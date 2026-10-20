import "../../isolation/require-isolation.js";
import https from "node:https";
import http from "node:http";
import {isIP} from "node:net";
import {DomainValidationError} from "../../domain/validation.js";
import {assertSafeResearchUrl,type ResearchAddressLookup} from "./http-web-research-provider.js";

type Answer={name:string;type:number;TTL:number;data:string};
/** Explicit, process-scoped public-only transport for independent research verification.
 * TLS-authenticated DoH bootstraps at a fixed public IP; target TLS still verifies its original name.
 * Nothing changes OS DNS, browser profiles, global fetch, or the production default provider.
 */
export class PublicDnsResearchNetwork {
  readonly identity="cloudflare-doh-tls-public-only-v1";
  readonly observations:Array<{host:string;addresses:Array<{address:string;family:number}>;fetchedAt:string}>=[];
  readonly requests:Array<{url:string;address:string;status:number}>=[];
  private readonly cache=new Map<string,{expires:number;addresses:Array<{address:string;family:number}>}>();
  constructor(private readonly options:{maxHosts?:number;timeoutMs?:number;maxBytes?:number}={}){}
  private async query(host:string,type:"A"|"AAAA"):Promise<Answer[]>{
    const data=await new Promise<Buffer>((resolve,reject)=>{
      const request=https.get({hostname:"1.1.1.1",servername:"cloudflare-dns.com",port:443,
        path:"/dns-query?name="+encodeURIComponent(host)+"&type="+type,
        headers:{host:"cloudflare-dns.com",accept:"application/dns-json"},rejectUnauthorized:true,timeout:this.options.timeoutMs??15000},response=>{
        if(response.statusCode!==200){response.resume();reject(new DomainValidationError("公开DNS服务响应失败"));return;}
        const chunks:Buffer[]=[];let size=0;response.on("data",chunk=>{size+=chunk.length;if(size>65536){request.destroy(new DomainValidationError("DNS响应过大"));return;}chunks.push(chunk);});
        response.on("error",reject);response.on("end",()=>resolve(Buffer.concat(chunks)));
      });request.on("error",reject);request.on("timeout",()=>request.destroy(new DomainValidationError("公开DNS查询超时")));
    });
    const result=JSON.parse(data.toString("utf8"));
    if(result.Status!==0||!Array.isArray(result.Question)||result.Question[0]?.name?.toLowerCase().replace(/\.$/,"")!==host)
      throw new DomainValidationError("公开DNS返回了不匹配的查询");
    const answers:Answer[]=Array.isArray(result.Answer)?result.Answer:[];
    const chain=new Set([host]);
    for(let depth=0;depth<8;depth++)for(const answer of answers)
      if(answer.type===5&&chain.has(answer.name.toLowerCase().replace(/\.$/,"")))chain.add(answer.data.toLowerCase().replace(/\.$/,""));
    return answers.filter(answer=>chain.has(answer.name.toLowerCase().replace(/\.$/,""))&&(answer.type===1||answer.type===28));
  }
  readonly resolveAddresses:ResearchAddressLookup=async raw=>{
    const host=raw.toLowerCase().replace(/^\[|\]$/g,"").replace(/\.$/,"");
    // Reject local names and literals before any DNS query; this never sends private host names to DoH.
    if(isIP(host)){await assertSafeResearchUrl("https://"+(isIP(host)===6?"["+host+"]":host),false);return [{address:host,family:isIP(host)}];}
    if(!host.includes(".")||/(?:^|\.)(?:localhost|local|internal|test)$/.test(host)||host.endsWith(".home.arpa"))throw new DomainValidationError("研究DNS不能解析本机或内部域名");
    const cached=this.cache.get(host);if(cached&&cached.expires>Date.now())return cached.addresses.map(a=>({...a}));
    if(!cached&&this.cache.size>=(this.options.maxHosts??40))throw new DomainValidationError("本轮公开域名解析达到上限");
    const answers=(await Promise.all([this.query(host,"A"),this.query(host,"AAAA")])).flat();
    const addresses=[...new Map(answers.map(a=>[a.data,{address:a.data,family:isIP(a.data)}])).values()];
    if(!addresses.length||addresses.some(a=>a.family===0))throw new DomainValidationError("公开域名没有可用地址");
    for(const a of addresses)await assertSafeResearchUrl("https://"+(a.family===6?"["+a.address+"]":a.address),false);
    const ttl=Math.max(1,Math.min(60,...answers.map(a=>a.TTL||1)));
    this.cache.set(host,{expires:Date.now()+ttl*1000,addresses});
    this.observations.push({host,addresses,fetchedAt:new Date().toISOString()});return addresses.map(a=>({...a}));
  };
  readonly fetch:typeof fetch=async (input,init)=>{
    if(input instanceof Request)throw new DomainValidationError("研究传输只接受显式公开URL");
    if(init?.method&&init.method!=="GET")throw new DomainValidationError("公开研究传输只允许GET");
    const suppliedHeaders=new Headers(init?.headers);
    if(suppliedHeaders.has("authorization")||suppliedHeaders.has("cookie"))throw new DomainValidationError("匿名公开研究传输不接受凭证");
    let url=await assertSafeResearchUrl(String(input),false,this.resolveAddresses);
    for(let redirect=0;redirect<=5;redirect++){
      const addresses=await this.resolveAddresses(url.hostname),chosen=addresses.find(a=>a.family===4)??addresses[0]!;
      const response=await new Promise<Response>((resolve,reject)=>{
        const requester=url.protocol==="https:"?https:http;
        const request=requester.get(url,{headers:Object.fromEntries(new Headers(init?.headers).entries()),agent:false,
          lookup:((_host:unknown,options:any,callback:any)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)) as any,
          timeout:this.options.timeoutMs??15000,signal:init?.signal??undefined},incoming=>{
          if(incoming.socket.remoteAddress?.replace(/^::ffff:/,"")!==chosen.address){request.destroy(new DomainValidationError("实际连接地址与已核验公开DNS不一致"));return;}
          const chunks:Buffer[]=[];let size=0;incoming.on("data",chunk=>{size+=chunk.length;if(size>(this.options.maxBytes??2*1024*1024)){request.destroy(new DomainValidationError("研究响应超过大小上限"));return;}chunks.push(chunk);});
          incoming.on("error",reject);incoming.on("end",()=>{
            const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(", "):value);
            const status=incoming.statusCode??502;this.requests.push({url:url.toString(),address:chosen.address,status});
            resolve(new Response([204,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
          });
        });request.on("error",reject);request.on("timeout",()=>request.destroy(new DomainValidationError("公开网页请求超时")));
      });
      const next=response.headers.get("location");
      if(init?.redirect!=="manual"&&response.status>=300&&response.status<400&&next){
        if(redirect===5)throw new DomainValidationError("公开研究重定向次数过多");
        url=await assertSafeResearchUrl(new URL(next,url).toString(),false,this.resolveAddresses);continue;
      }
      return response;
    }
    throw new DomainValidationError("公开研究传输失败");
  };
}
