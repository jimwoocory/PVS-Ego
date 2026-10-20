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
      requiredUserAction:code==="BROWSER_SESSION_EXPIRED"?"检查原浏览器实例与控制权；由用户归还后继续原研究。宿主已重启时需要新的明确会话许可，不能恢复旧权限。":
        detail==="SCREENSHOT_TIMEOUT"?"原页面截图超时；在独立Ego宿主中检查原研究Space是否可见，再继续同一研究。不会跳过截图、自动接管其他Space或转HTTP伪造页面证据。":
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
  private async fetchSourceUnlocked(source:WebResearchSource,context?:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    let s:Session|undefined;
    try{if(!context||!source.browserResumeHandle)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
      s=await this.session(context.projectId,context.runId,source.browserResumeHandle);
      if(!s.candidates.some(c=>c.url===source.url))throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
      // Validate ownership even when reusing a previously saved immutable document.
      await this.read(s);
      const cached=s.captures[source.url];
      if(cached)return this.savedDocument(s,source,cached);
      const root=path.resolve(this.projectsRoot,s.projectId),tempRoot=path.join(root,".tmp"),dir=path.join(tempRoot,"ego-"+randomUUID());await fs.mkdir(dir,{recursive:true});
      try{const screenshot=path.join(dir,"page.png"),resume=s.pending?.kind==="SOURCE"&&s.pending.url===source.url;
        s.pending={kind:"SOURCE",url:source.url};await this.checkpoint(s);const capture=await this.read(s,resume?undefined:source.url,screenshot);
        if(capture.text.length<80)throw new EgoResearchError("BROWSER_PROVIDER_ERROR");
        const contentHash=sha256Bytes(Buffer.from(capture.text)),store=new LocalArtifactStore(root,this.artifacts),key=sha256Bytes(Buffer.from(s.runId+source.url+capture.fetchedAt+contentHash));
        const document:WebResearchDocument={sourceUrl:source.url,finalUrl:capture.finalUrl,title:capture.title,fetchedAt:capture.fetchedAt,sourceType:source.sourceType,text:capture.text,excerpt:capture.text.slice(0,4000),contentHash};
        const doc=await store.writeImmutable({id:"ego-document:"+key,projectId:s.projectId,relativePath:"research/ego/"+s.runId+"/"+key+".json",bytes:Buffer.from(JSON.stringify(document)),kind:"OTHER",mimeType:"application/json",immutable:true});
        const screenshotBytes=await fs.readFile(screenshot);if(!screenshotBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new EgoResearchError("BROWSER_PROVIDER_ERROR");
        const image=await store.writeImmutable({id:"ego-screenshot:"+key,projectId:s.projectId,relativePath:"research/ego/"+s.runId+"/"+key+".png",bytes:screenshotBytes,kind:"OTHER",mimeType:"image/png",immutable:true});
        const proof:ResearchSourceCapture={provider:this.id,documentArtifactId:doc.id,screenshotArtifactId:image.id,sourceUrl:source.url,finalUrl:capture.finalUrl,fetchedAt:capture.fetchedAt,contentHash,truncated:capture.truncated};
        s.captures[source.url]=proof;s.pending=undefined;await this.checkpoint(s);return {...document,sourceCapture:proof};
      }finally{if(path.resolve(dir).startsWith(tempRoot+path.sep))await fs.rm(dir,{recursive:true,force:true});}
    }catch(error){throw new BrowserResearchBlockedError(this.blocked(error,s?.handle??source.browserResumeHandle));}
  }
  private async savedDocument(s:Session,source:WebResearchSource,proof:ResearchSourceCapture){
    const a=await this.artifacts.findById(proof.documentArtifactId),root=path.resolve(this.projectsRoot,s.projectId),file=a?path.resolve(root,a.relativePath):"";
    if(!a||a.projectId!==s.projectId||a.integrityStatus!=="READY"||!file.startsWith(root+path.sep))throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
    const bytes=await fs.readFile(file);if(sha256Bytes(bytes)!==a.sha256)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
    const document=JSON.parse(bytes.toString("utf8")) as WebResearchDocument;
    if(document.sourceUrl!==source.url||sha256Bytes(Buffer.from(document.text))!==proof.contentHash)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");
    if(proof.screenshotArtifactId){const image=await this.artifacts.findById(proof.screenshotArtifactId),imagePath=image?path.resolve(root,image.relativePath):"";
      if(!image||image.projectId!==s.projectId||image.integrityStatus!=="READY"||!imagePath.startsWith(root+path.sep)||sha256Bytes(await fs.readFile(imagePath))!==image.sha256)throw new EgoResearchError("BROWSER_SESSION_EXPIRED");}
    return {...document,sourceType:source.sourceType,sourceCapture:proof};
  }
}

export class EgoAwareWebResearchProvider implements WebResearchProvider{
  constructor(private readonly http:WebResearchProvider,private readonly ego:EgoBrowserResearchProvider){}
  fetchSource(source:WebResearchSource,context?:{projectId:string;runId:string}){
    return source.browserResumeHandle?this.ego.fetchSource(source,context):this.http.fetchSource(source,context);
  }
}
