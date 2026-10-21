import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {hashValue,sha256Bytes} from '../../domain/hashing.js';
import type {ArtifactRepository} from '../../application/ports/artifact-repository.js';
import type {ResearchRepository} from '../../application/ports/research-repository.js';
import type {WebResearchProvider,WebResearchSource,WebResearchDocument} from '../../application/ports/research-provider.js';
import {LocalArtifactStore} from '../store/local-artifact-store.js';

const captureSchema=z.object({sourceUrl:z.string().max(2000),finalUrl:z.string().max(2000),title:z.string().min(1).max(256),text:z.string().min(1).max(4000),fetchedAt:z.iso.datetime(),truncated:z.boolean()}).strict();
const receiptSchema=z.object({version:z.literal('go-local-publication-v1'),id:z.string(),projectId:z.string(),runId:z.string(),sourceUrl:z.string(),relativePath:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().min(1).max(65536)}).strict();
export type GoLocalDocumentCapture=z.infer<typeof captureSchema>;
const safeId=(id:string)=>{if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw Error('GO_RESEARCH_ID_DENIED');return id;};
type Scope={projectId:string;runId:string;id:string;projectRoot:string;relativePath:string;file:string;receipt:string};

/** Explicit, unregistered local candidate. A unique DB reservation precedes
 * acquisition. A pending reservation never implicitly starts another worker. */
export class GoLocalResearchProvider implements WebResearchProvider {
  constructor(private readonly binding:{projectId:string;sourceUrl:string},private readonly repo:ResearchRepository,
    private readonly artifacts:ArtifactRepository,private readonly projectsRoot:string,
    private readonly readOwnedDocument:()=>Promise<GoLocalDocumentCapture>){
    const u=new URL(binding.sourceUrl);safeId(binding.projectId);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||[3090,3092,9223,19422,19423].includes(Number(u.port))||u.username||u.password||u.search||u.hash||!/^\/bridge-fixture\/[A-Za-z0-9-]{1,80}$/.test(u.pathname)||u.href!==binding.sourceUrl)throw Error('GO_RESEARCH_OWNED_FIXTURE_REQUIRED');
    this.binding=Object.freeze({...binding});
  }

  private async scope(source:WebResearchSource,context?:{projectId:string;runId:string}):Promise<Scope>{
    if(!context||context.projectId!==this.binding.projectId||source.url!==this.binding.sourceUrl)throw Error('GO_RESEARCH_SCOPE_DENIED');
    safeId(context.projectId);safeId(context.runId);
    const run=await this.repo.findRun(context.runId);
    if(!run||run.projectId!==context.projectId||run.mode!=='BASIC'||!['RUNNING','BLOCKED'].includes(run.status))throw Error('GO_RESEARCH_RUN_DENIED');
    const key=hashValue({projectId:context.projectId,runId:context.runId,sourceUrl:source.url}),id='go-local-document:'+key;
    const projectRoot=path.resolve(this.projectsRoot,context.projectId),relativePath='research/go-local/'+context.runId+'/'+key+'.json';
    const file=path.join(projectRoot,relativePath);
    return {...context,id,projectRoot,relativePath,file,receipt:file+'.publication.json'};
  }

  private async contained(s:Scope){
    const realRoot=await fs.realpath(this.projectsRoot),realProject=await fs.realpath(s.projectRoot),realDir=await fs.realpath(path.dirname(s.file));
    if(!realProject.startsWith(realRoot+path.sep)||!realDir.startsWith(realProject+path.sep))throw Error('GO_RESEARCH_PATH_DENIED');
  }

  private async prepareDirectory(s:Scope){
    const root=await fs.realpath(this.projectsRoot);
    let dir=path.resolve(this.projectsRoot);
    for(const part of [s.projectId,'research','go-local',s.runId]){
      dir=path.join(dir,part);
      try{await fs.mkdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      const stat=await fs.lstat(dir),real=await fs.realpath(dir);
      if(!stat.isDirectory()||stat.isSymbolicLink()||!real.startsWith(root+path.sep))throw Error('GO_RESEARCH_PATH_DENIED');
    }
    for(const file of [s.file,s.receipt]){
      try{await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      throw Error('GO_RESEARCH_ORPHAN_PUBLICATION');
    }
  }

  private async readFile(s:Scope,file:string):Promise<Buffer>{
    await this.contained(s);
    const real=await fs.realpath(file),dir=await fs.realpath(path.dirname(s.file)),stat=await fs.lstat(file);
    if(path.dirname(real)!==dir||!stat.isFile()||stat.nlink!==1||stat.size>65536)throw Error('GO_RESEARCH_PATH_DENIED');
    const bytes=await fs.readFile(file);if(bytes.length>65536)throw Error('GO_RESEARCH_FILE_TOO_LARGE');return bytes;
  }

  private validateDocument(bytes:Buffer,s:Scope):WebResearchDocument{
    const document=JSON.parse(bytes.toString('utf8')) as WebResearchDocument;
    captureSchema.parse({sourceUrl:document.sourceUrl,finalUrl:document.finalUrl,title:document.title,text:document.text,fetchedAt:document.fetchedAt,truncated:document.sourceCapture?.truncated});
    const proof=document.sourceCapture;
    if(document.sourceUrl!==this.binding.sourceUrl||document.finalUrl!==this.binding.sourceUrl||
      sha256Bytes(Buffer.from(document.text))!==document.contentHash||document.excerpt!==document.text||
      !proof||proof.provider!=='go-local-owned-fixture'||proof.documentArtifactId!==s.id||
      proof.sourceUrl!==document.sourceUrl||proof.finalUrl!==document.finalUrl||proof.fetchedAt!==document.fetchedAt||proof.contentHash!==document.contentHash)throw Error('GO_RESEARCH_DOCUMENT_CHANGED');
    return document;
  }

  private assertRecord(record:NonNullable<Awaited<ReturnType<ArtifactRepository['findById']>>>,s:Scope){
    if(record.projectId!==s.projectId||record.relativePath!==s.relativePath||!record.immutable||record.kind!=='OTHER'||record.mimeType!=='application/json')throw Error('GO_RESEARCH_ARTIFACT_DENIED');
  }

  async fetchSource(source:WebResearchSource,context?:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    const s=await this.scope(source,context),prior=await this.artifacts.findById(s.id);
    if(prior){
      this.assertRecord(prior,s);
      if(prior.integrityStatus==='PENDING')throw Error('GO_RESEARCH_CAPTURE_PENDING');
      if(prior.integrityStatus!=='READY')throw Error('GO_RESEARCH_ARTIFACT_DENIED');
      const bytes=await this.readFile(s,s.file);
      if(sha256Bytes(bytes)!==prior.sha256||bytes.length!==prior.sizeBytes)throw Error('GO_RESEARCH_ARTIFACT_CHANGED');
      return {...this.validateDocument(bytes,s),sourceType:source.sourceType};
    }
    // DB primary-key uniqueness is the cross-process arbitration point. A
    // losing requester is blocked; it neither captures nor repairs the winner.
    try{await this.artifacts.createPending({id:s.id,projectId:s.projectId,relativePath:s.relativePath,kind:'OTHER',mimeType:'application/json',immutable:true});}
    catch(error){if(await this.artifacts.findById(s.id))throw Error('GO_RESEARCH_CAPTURE_PENDING');throw error;}
    await this.prepareDirectory(s);
    const capture=captureSchema.parse(await this.readOwnedDocument());
    if(capture.sourceUrl!==source.url||capture.finalUrl!==source.url)throw Error('GO_RESEARCH_PAGE_CHANGED');
    const document:WebResearchDocument={sourceUrl:source.url,finalUrl:capture.finalUrl,title:capture.title,text:capture.text,excerpt:capture.text,fetchedAt:capture.fetchedAt,contentHash:sha256Bytes(Buffer.from(capture.text)),sourceType:source.sourceType};
    document.sourceCapture={provider:'go-local-owned-fixture',documentArtifactId:s.id,sourceUrl:source.url,finalUrl:capture.finalUrl,fetchedAt:capture.fetchedAt,contentHash:document.contentHash,truncated:capture.truncated};
    const bytes=Buffer.from(JSON.stringify(document));
    const receipt={version:'go-local-publication-v1',id:s.id,projectId:s.projectId,runId:s.runId,sourceUrl:source.url,relativePath:s.relativePath,sha256:sha256Bytes(bytes),sizeBytes:bytes.length};
    // An incomplete receipt is deliberately unrecoverable. Never overwrite it.
    await fs.writeFile(s.receipt,JSON.stringify(receipt),{flag:'wx'});
    const store=new LocalArtifactStore(s.projectRoot,this.artifacts);
    await store.writeReservedImmutable({id:s.id,projectId:s.projectId,relativePath:s.relativePath,bytes,kind:'OTHER',mimeType:'application/json',immutable:true});
    return document;
  }

  /** Explicit local finalization only. No browser, model, recapture, Evidence
   * insertion, run status change or renewed execution permission is involved. */
  async recoverPublishedSource(source:WebResearchSource,context:{projectId:string;runId:string}):Promise<WebResearchDocument>{
    const s=await this.scope(source,context),record=await this.artifacts.findById(s.id);
    if(!record)throw Error('GO_RESEARCH_RECOVERY_NOT_AVAILABLE');
    this.assertRecord(record,s);
    if(record.integrityStatus!=='PENDING')throw Error('GO_RESEARCH_RECOVERY_NOT_AVAILABLE');
    const receipt=receiptSchema.parse(JSON.parse((await this.readFile(s,s.receipt)).toString('utf8')));
    if(receipt.id!==s.id||receipt.projectId!==s.projectId||receipt.runId!==s.runId||receipt.sourceUrl!==source.url||receipt.relativePath!==s.relativePath)throw Error('GO_RESEARCH_RECEIPT_CHANGED');
    const bytes=await this.readFile(s,s.file);
    if(sha256Bytes(bytes)!==receipt.sha256||bytes.length!==receipt.sizeBytes)throw Error('GO_RESEARCH_ARTIFACT_CHANGED');
    const document=this.validateDocument(bytes,s);
    await this.artifacts.markReady(s.id,{sha256:receipt.sha256,sizeBytes:receipt.sizeBytes,mimeType:'application/json'});
    return {...document,sourceType:source.sourceType};
  }
}
