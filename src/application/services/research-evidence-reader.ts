import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {ResearchRepository} from '../ports/research-repository.js';
import type {ArtifactRepository} from '../ports/artifact-repository.js';
import {sha256Bytes} from '../../domain/hashing.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema=z.object({sourceUrl:z.string().url(),finalUrl:z.string().url(),title:z.string().min(1),text:z.string().min(1).max(300000),excerpt:z.string(),fetchedAt:z.iso.datetime(),contentHash:hash});
export type EvidenceInspection = {status:'BLOCKED';code:string} | {
  status:'VERIFIED';projectId:string;runId:string;evidenceId:string;title:string;text:string;provider:string;
  sourceUrl:string;finalUrl:string;fetchedAt:string;verifiedAt:string;contentHash:string;artifactSha256:string;
  truncated:boolean;screenshot:'NOT_VERIFIED';
};
const validId=(id:string)=>/^[A-Za-z0-9_-]{1,100}$/.test(id);
const inside=(parent:string,child:string)=>child.startsWith(parent+path.sep);
/** Read-only local evidence inspection. Never calls a provider, model or repair. */
export class ResearchEvidenceReader {
  constructor(private readonly repo:Pick<ResearchRepository,'findRun'|'listEvidence'>,private readonly artifacts:ArtifactRepository,private readonly projectsRoot:string){}
  async inspect(projectId:string,runId:string,evidenceId:string):Promise<EvidenceInspection|null>{
    if(![projectId,runId,evidenceId].every(validId))return null;
    const run=await this.repo.findRun(runId);if(!run||run.projectId!==projectId)return null;
    const evidence=(await this.repo.listEvidence(runId)).find(e=>e.id===evidenceId&&e.runId===runId&&e.projectId===projectId);if(!evidence)return null;
    const blocked=(code:string):EvidenceInspection=>({status:'BLOCKED',code});
    const proof=evidence.sourceCapture;if(!proof)return blocked('CAPTURE_UNAVAILABLE');
    const folder=proof.provider==='go-local-owned-fixture'?'go-local':proof.provider==='ego-browser-research'?'ego':null;
    if(!folder)return blocked('CAPTURE_UNSUPPORTED');
    const maxBytes=folder==='ego'?2_000_000:65536,maxText=folder==='ego'?300000:4000;
    const artifact=await this.artifacts.findById(proof.documentArtifactId);
    if(!artifact||artifact.projectId!==projectId||artifact.integrityStatus!=='READY'||!artifact.immutable||artifact.mimeType!=='application/json')return blocked('ARTIFACT_UNAVAILABLE');
    const relative=artifact.relativePath.replaceAll('\\','/'),prefix='research/'+folder+'/'+runId+'/';
    if(!relative.startsWith(prefix)||relative.slice(prefix.length).includes('/')||!relative.endsWith('.json')||path.isAbsolute(artifact.relativePath))return blocked('PATH_DENIED');
    const projectRoot=path.resolve(this.projectsRoot,projectId),file=path.resolve(projectRoot,artifact.relativePath);
    if(!inside(projectRoot,file))return blocked('PATH_DENIED');
    let bytes:Buffer;
    try{
      const realRoot=await fs.realpath(this.projectsRoot),realProject=await fs.realpath(projectRoot),realFile=await fs.realpath(file);
      if(!inside(realRoot,realProject)||!inside(realProject,realFile))return blocked('PATH_DENIED');
      const stat=await fs.stat(realFile);if(!stat.isFile()||stat.nlink!==1)return blocked('PATH_DENIED');
      if(stat.size>maxBytes)return blocked('FILE_TOO_LARGE');
      bytes=await fs.readFile(realFile);
    }catch(error){return blocked((error as NodeJS.ErrnoException).code==='ENOENT'?'FILE_MISSING':'PATH_DENIED');}
    if(bytes.length>maxBytes)return blocked('FILE_TOO_LARGE');
    if(sha256Bytes(bytes)!==artifact.sha256||bytes.length!==artifact.sizeBytes)return blocked('ARTIFACT_CHANGED');
    let document:z.infer<typeof documentSchema>;
    try{document=documentSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return blocked('DOCUMENT_INVALID');}
    if(document.text.length>maxText)return blocked('DOCUMENT_INVALID');
    if(sha256Bytes(Buffer.from(document.text))!==document.contentHash||document.contentHash!==evidence.contentHash||document.contentHash!==proof.contentHash||document.sourceUrl!==proof.sourceUrl||document.finalUrl!==proof.finalUrl||document.finalUrl!==evidence.sourceUrl||document.fetchedAt!==proof.fetchedAt||document.fetchedAt!==evidence.fetchedAt||document.title!==evidence.title||document.excerpt!==evidence.excerpt)return blocked('EVIDENCE_MISMATCH');
    return {status:'VERIFIED',projectId,runId,evidenceId,title:document.title,text:document.text,provider:proof.provider,sourceUrl:document.sourceUrl,finalUrl:document.finalUrl,fetchedAt:document.fetchedAt,verifiedAt:new Date().toISOString(),contentHash:document.contentHash,artifactSha256:artifact.sha256!,truncated:proof.truncated,screenshot:'NOT_VERIFIED'};
  }
}
