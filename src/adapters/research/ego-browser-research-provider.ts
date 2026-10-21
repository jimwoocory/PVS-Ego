import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {ZodError} from "zod";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {DomainValidationError} from "../../domain/validation.js";
import type {ArtifactRepository} from "../../application/ports/artifact-repository.js";
import {BrowserResearchBlockedError,type BrowserResearchProvider,type BrowserResearchBlocked,type BrowserResearchResult,type WebResearchSource,type WebResearchDocument,type WebResearchProvider,type ResearchSourceCapture} from "../../application/ports/research-provider.js";
import {EgoResearchError,type EgoResearchRuntime,type EgoResearchBinding} from "../../application/ports/ego-research-runtime.js";
import {LocalArtifactStore} from "../store/local-artifact-store.js";
import {assertSafeResearchUrl,type ResearchAddressLookup} from "./http-web-research-provider.js";
import {classifySource,normalizeResultUrl,blockedSearchHost,unsafeOrAdultHost} from "./public-search-research-provider.js";
import {z} from "zod";
import {readSavedResearchArtifact} from "../../application/services/saved-research-artifact.js";

type Session={handle:string;projectId:string;runId:string;runtimeIdentity:string;binding:EgoResearchBinding;
  candidates:WebResearchSource[];completedQueries:string[];pending?:{kind:"SEARCH"|"SOURCE";url:string;query?:string};
  captures:Record<string,ResearchSourceCapture>;};
const safeId=(id:string)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new EgoResearchError("BROWSER_SESSION_EXPIRED");return id;};
/** Optional read-only candidate. Session files are browser checkpoints; all document evidence uses existing Artifacts. */
export class EgoBrowserResearchProvider implements BrowserResearchProvider,WebResearchProvider{
  readonly id="ego-browser-research";
  constructor(private readonly runtime:EgoResearchRuntime,private readonly artifacts:ArtifactRepository,private readonly projectsRoot:string,
    private readonly options:{searchUrlTemplate:string;allowPrivateNetwork?:boolean;maxQueries?:number;maxSources?:number;resolveAddresses?:ResearchAddressLookup;networkIdentity?:string}){}
  private get runtimeIdentity(){return this.options.networkIdentity?hashValue({runtime:this.runtime.identity,network:this.options.networkIdentity}):this.runtime.identity;}
  private directory(projectId:string,runId:string){return path.resolve(this.projectsRoot,safeId(projectId),"research","ego",safeId(runId));}
  private blocked(error:unknown,handle?:string):BrowserResearchBlocked{
    const code=error instanceof EgoResearchError?error.code:"BROWSER_PROVIDER_ERROR";
    const detail=error instanceof EgoResearchError?error.detailCode:error instanceof DomainValidationError?"URL_POLICY_DENIED":error instanceof ZodError?"CAPTURE_SCHEMA_"+error.issues.map(i=>i.path.join("_")).join("_").replace(/[^a-zA-Z0-9_]/g,"").slice(0,100):
      typeof (error as NodeJS.ErrnoException)?.code==="string"?/^[A-Z_]{2,50}$/.test((error as NodeJS.ErrnoException).code!)?(error as NodeJS.ErrnoException).code:"PROVIDER_FAILURE":error instanceof Error?error.name:"PROVIDER_FAILURE";
    return {status:"BLOCKED",blockerCode:code,message:"Ego只读研究已暂停："+code+(detail?"（"+detail+"）":""),
      requiredUserAction:detail==="CAPTURE_DIGEST_UNAVAILABLE"?"历史缓存缺少完整文件摘要，保留原记录并停止复用。可只读核对保存证据；重新采集需要另行明确原会话与来源范围，不自动重采或补写摘要。":
        code==="BROWSER_SESSION_EXPIRED"?"检查原浏览器实例与控制权；由用户归还后继续原研究。宿主已重启时需要新的明确会话许可，不能恢复旧权限。":
        ["SCREENSHOT_TIMEOUT","SPACE_HIDDEN","SCREENSHOT_FAILED"].includes(detail??"")?"原研究Space隐藏或截图未完成；由用户检查并选择原Space后再明确继续同一研究。不会跳过截图、自动切换Space或转HTTP伪造页面证据。":
        detail==="URL_POLICY_DENIED"?"当前网址或DNS解析未通过既有研究地址策略；检查独立网络配置，保留原任务，不降低私网访问保护。":
        ["LOGIN_REQUIRED","CAPTCHA_REQUIRED","RISK_CONTROL"].includes(code)?"在原页面由用户完成登录或平台验证后归还控制，再继续原研究。不会自动登录、代答验证码或切换引擎。":"检查Ego候选配置和诊断后继续原研究；不自动改用其他引擎或创建替代任务。",
      browserState:{provider:this.id,...(handle?{resumeToken:handle}:{})}};
  }
  private async checkpoint(s:Session){const dir=this.directory(s.projectId,s.runId),target=path.join(dir,"session.json"),tmp=path.join(dir,"session-"+randomUUID()+".tmp");await fs.writeFile(tmp,JSON.stringify(s),{flag:"wx"});await fs.rename(tmp,target);}
  private async session(projectId:string,runId:string,handle?:string):Promise<Session>{
    const dir=this.directory(projectId,runId);await fs.mkdir(dir,{recursive:true});
    const raw=await fs.readFile(path.join(dir,"session.json"),"utf8").catch((e:NodeJS.ErrnoException)=>{if(e.code==="ENOENT")return null;throw e;});
    if(raw){const s=JSON.parse(raw) as Session;
      if(s.projectId!==projectId||s.runId!==runId||s.runtimeIdentity!==this.runtimeIdentity||(handle&&handle!==s.handle))throw new EgoResearchError("BROWSER_SESSION_EXPIRED");return s;}
    if(handle)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
    const binding=await this.runtime.open("pvs-research-"+projectId+"-"+runId),s:Session={handle:randomUUID(),projectId,runId,runtimeIdentity:this.runtimeIdentity,binding,candidates:[],completedQueries:[],captures:{}};
    await this.checkpoint(s);return s;
  }
  private async safeUrl(url:string){return (await assertSafeResearchUrl(url,this.options.allowPrivateNetwork===true,this.options.resolveAddresses)).toString();}
  private async exclusive<T>(projectId:string,runId:string,action:()=>Promise<T>){
    const dir=this.directory(projectId,runId);await fs.mkdir(dir,{recursive:true});const lock=path.join(dir,"session.lock");
    const owned=await fs.open(lock,"wx").catch(()=>{throw new EgoResearchError("BROWSER_PROVIDER_ERROR");});
    try{return await action();}finally{await owned.close();await fs.unlink(lock);}
  }
  private async read(s:Session,url?:string,screenshotPath?:string){
    if(url)await this.safeUrl(url);const capture=await this.runtime.read(s.binding,{url,screenshotPath});await this.safeUrl(capture.finalUrl);
    if(capture.blocker)throw new EgoResearchError(capture.blocker);return capture;
  }
  async discover(input:{projectId:string;runId?:string;goal:string;queries:string[];resumeToken?:string}):Promise<BrowserResearchResult>{
    if(!input.runId)return this.blocked(new EgoResearchError("BROWSER_PROVIDER_ERROR"));
    try{return await this.exclusive(input.projectId,input.runId,()=>this.discoverUnlocked(input));}catch(error){return this.blocked(error,input.resumeToken);}
  }
  private async discoverUnlocked(input:{projectId:string;runId?:string;goal:string;queries:string[];resumeToken?:string}):Promise<BrowserResearchResult>{
    let s:Session|undefined;
    try{if(!input.runId)throw new EgoResearchError("BROWSER_PROVIDER_ERROR");
      for(const query of input.queries.slice(0,this.options.maxQueries??3))await this.safeUrl(this.options.searchUrlTemplate.replaceAll("{query}",encodeURIComponent(query)));
      s=await this.session(input.projectId,input.runId,input.resumeToken);
      // Never navigate away from a blocked source before checking the same page after a user's return.
      if(s.pending?.kind==="SOURCE"){
        await this.fetchSourceUnlocked({url:s.pending.url,sourceType:"COMPETITOR",browserResumeHandle:s.handle},{projectId:s.projectId,runId:s.runId});
        s=await this.session(s.projectId,s.runId,s.handle);
      }
      const queries=[...new Set(input.queries.map(q=>q.trim()).filter(Boolean))].slice(0,this.options.maxQueries??3);
      const perQuery=Math.max(1,Math.ceil((this.options.maxSources??6)/Math.max(1,queries.length)));
      for(const query of queries){if(s.completedQueries.includes(query))continue;
        const url=this.options.searchUrlTemplate.replaceAll("{query}",encodeURIComponent(query));
        const resume=s.pending?.kind==="SEARCH"&&s.pending.query===query;
        s.pending={kind:"SEARCH",url,query};await this.checkpoint(s);const result=await this.read(s,resume?undefined:url);
        for(const link of result.links){if(s.candidates.length>=(this.options.maxSources??6))break;
          if(s.candidates.filter(c=>c.discoveryQuery===query).length>=perQuery)break;
          try{const normalized=normalizeResultUrl(link.url,new URL(url).hostname.includes("duckduckgo")?"duck":"bing");
            if(!normalized||!link.title.trim()||blockedSearchHost(new URL(normalized).hostname)||unsafeOrAdultHost(new URL(normalized).hostname))continue;
            const candidate=await this.safeUrl(normalized);if(new URL(candidate).origin===new URL(url).origin&&new URL(candidate).pathname===new URL(url).pathname)continue;
            if(s.candidates.some(c=>c.url===candidate))continue;
            s.candidates.push({url:candidate,sourceType:classifySource(query,candidate),discoveryQuery:query,discoveryEngine:"external",discoveryRank:s.candidates.length+1,resultTitle:link.title,browserResumeHandle:s.handle});
          }catch{/* Unsafe result URLs are not fetched. */}}
        s.completedQueries.push(query);s.pending=undefined;await this.checkpoint(s);
      }
      // Even cached discovery must verify current instance and ownership; the handle itself grants nothing.
      if(!queries.length||queries.every(q=>s!.completedQueries.includes(q)))await this.read(s);
      if(!s.candidates.length)throw new EgoResearchError("BROWSER_PROVIDER_ERROR","NO_USABLE_RESULTS");
      return {status:"READY",sources:s.candidates,browserState:{provider:this.id,resumeToken:s.handle}};
    }catch(error){return this.blocked(error,s?.handle??input.resumeToken);}
  }
  async fetchSource(source:WebResearchSource,context?:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    if(!context)throw new BrowserResearchBlockedError(this.blocked(new EgoResearchError("BROWSER_SESSION_EXPIRED"),source.browserResumeHandle));
    try{return await this.exclusive(context.projectId,context.runId,()=>this.fetchSourceUnlocked(source,context));}
    catch(error){if(error instanceof BrowserResearchBlockedError)throw error;throw new BrowserResearchBlockedError(this.blocked(error,source.browserResumeHandle));}
  }
  /** Explicit owned-page wiring, never discovery or a default HTTP fallback.
   * The injected executor fixes the URL independently of caller page data. */
  async fetchOwnedSource(source:WebResearchSource,context:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    if(!this.runtime.ownedSourceUrl||source.url!==this.runtime.ownedSourceUrl)throw new BrowserResearchBlockedError(this.blocked(new EgoResearchError('BROWSER_SESSION_EXPIRED','OWNED_SOURCE_REQUIRED')));
    try{return await this.exclusive(context.projectId,context.runId,async()=>{
      await this.safeUrl(source.url);
      const s=await this.session(context.projectId,context.runId,source.browserResumeHandle);
      if(!s.candidates.some(c=>c.url===source.url)){
        s.candidates.push({...source,browserResumeHandle:s.handle});await this.checkpoint(s);
      }
      return this.fetchSourceUnlocked({...source,browserResumeHandle:s.handle},context);
    });}catch(error){if(error instanceof BrowserResearchBlockedError)throw error;throw new BrowserResearchBlockedError(this.blocked(error,source.browserResumeHandle));}
  }
  private async fetchSourceUnlocked(source:WebResearchSource,context?:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    let s:Session|undefined;
    try{if(!context||!source.browserResumeHandle)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
      s=await this.session(context.projectId,context.runId,source.browserResumeHandle);
      if(!s.candidates.some(c=>c.url===source.url))throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
      const cached=s.captures[source.url];
      if(cached){const document=await this.savedDocument(s,source,cached);await this.read(s);return document;}
      // Validate ownership even when reusing a previously saved immutable document.
      await this.read(s);
      const root=path.resolve(this.projectsRoot,s.projectId),tempRoot=path.join(root,".tmp"),dir=path.join(tempRoot,"ego-"+randomUUID());await fs.mkdir(dir,{recursive:true});
      try{const screenshot=path.join(dir,"page.png"),resume=s.pending?.kind==="SOURCE"&&s.pending.url===source.url;
        s.pending={kind:"SOURCE",url:source.url};await this.checkpoint(s);const capture=await this.read(s,resume?undefined:source.url,screenshot);
        if(capture.text.length<80)throw new EgoResearchError("BROWSER_PROVIDER_ERROR");
        const contentHash=sha256Bytes(Buffer.from(capture.text)),store=new LocalArtifactStore(root,this.artifacts),key=sha256Bytes(Buffer.from(s.runId+source.url+capture.fetchedAt+contentHash));
        const document:WebResearchDocument={sourceUrl:source.url,finalUrl:capture.finalUrl,title:capture.title,fetchedAt:capture.fetchedAt,sourceType:source.sourceType,text:capture.text,excerpt:capture.text.slice(0,4000),contentHash};
        const doc=await store.writeImmutable({id:"ego-document:"+key,projectId:s.projectId,relativePath:"research/ego/"+s.runId+"/"+key+".json",bytes:Buffer.from(JSON.stringify(document)),kind:"OTHER",mimeType:"application/json",immutable:true});
        const screenshotBytes=await fs.readFile(screenshot);if(!screenshotBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new EgoResearchError("BROWSER_PROVIDER_ERROR");
        const image=await store.writeImmutable({id:"ego-screenshot:"+key,projectId:s.projectId,relativePath:"research/ego/"+s.runId+"/"+key+".png",bytes:screenshotBytes,kind:"OTHER",mimeType:"image/png",immutable:true});
        const proof:ResearchSourceCapture={provider:this.id,documentArtifactId:doc.id,screenshotArtifactId:image.id,documentSha256:doc.sha256!,screenshotSha256:image.sha256!,sourceUrl:source.url,finalUrl:capture.finalUrl,fetchedAt:capture.fetchedAt,contentHash,truncated:capture.truncated};
        s.captures[source.url]=proof;s.pending=undefined;await this.checkpoint(s);return {...document,sourceCapture:proof};
      }finally{if(path.resolve(dir).startsWith(tempRoot+path.sep))await fs.rm(dir,{recursive:true,force:true});}
    }catch(error){throw new BrowserResearchBlockedError(this.blocked(error,s?.handle??source.browserResumeHandle));}
  }
  private async savedDocument(s:Session,source:WebResearchSource,proof:ResearchSourceCapture){
    if(proof.provider!==this.id||!proof.documentSha256||!proof.screenshotArtifactId||!proof.screenshotSha256)throw new EgoResearchError("BROWSER_SESSION_EXPIRED","CAPTURE_DIGEST_UNAVAILABLE");
    const {bytes}=await readSavedResearchArtifact(this.artifacts,this.projectsRoot,{projectId:s.projectId,runId:s.runId,folder:'ego',artifactId:proof.documentArtifactId,mimeType:'application/json',expectedSha256:proof.documentSha256});
    const document=z.object({sourceUrl:z.string().url(),finalUrl:z.string().url(),title:z.string().min(1),text:z.string().min(1).max(300000),excerpt:z.string(),fetchedAt:z.iso.datetime(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse(JSON.parse(bytes.toString('utf8')));
    if(document.sourceUrl!==source.url||document.sourceUrl!==proof.sourceUrl||document.finalUrl!==proof.finalUrl||document.fetchedAt!==proof.fetchedAt||document.contentHash!==proof.contentHash||sha256Bytes(Buffer.from(document.text))!==proof.contentHash||document.excerpt!==document.text.slice(0,4000))throw new EgoResearchError("BROWSER_SESSION_EXPIRED","CAPTURE_BINDING_CHANGED");
    await readSavedResearchArtifact(this.artifacts,this.projectsRoot,{projectId:s.projectId,runId:s.runId,folder:'ego',artifactId:proof.screenshotArtifactId,mimeType:'image/png',expectedSha256:proof.screenshotSha256});
    return {...document,sourceType:source.sourceType,sourceCapture:proof};
  }
}

export class EgoAwareWebResearchProvider implements WebResearchProvider{
  constructor(private readonly http:WebResearchProvider,private readonly ego:EgoBrowserResearchProvider){}
  fetchSource(source:WebResearchSource,context?:{projectId:string;runId:string}){
    return source.browserResumeHandle?this.ego.fetchSource(source,context):this.http.fetchSource(source,context);
  }
}
