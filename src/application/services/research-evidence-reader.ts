import {z} from 'zod';
import type {ResearchRepository} from '../ports/research-repository.js';
import type {ArtifactRepository} from '../ports/artifact-repository.js';
import {sha256Bytes} from '../../domain/hashing.js';
import {readSavedResearchArtifact,SavedResearchArtifactError} from './saved-research-artifact.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema=z.object({sourceUrl:z.string().url(),finalUrl:z.string().url(),title:z.string().min(1),text:z.string().min(1).max(300000),excerpt:z.string(),fetchedAt:z.iso.datetime(),contentHash:hash});
export type EvidenceInspection = {status:'BLOCKED';code:string} | {
  status:'VERIFIED';projectId:string;runId:string;evidenceId:string;title:string;text:string;provider:string;
  sourceUrl:string;finalUrl:string;fetchedAt:string;verifiedAt:string;contentHash:string;artifactSha256:string;
  truncated:boolean;screenshot:'NOT_VERIFIED';
};
const validId=(id:string)=>/^[A-Za-z0-9_-]{1,100}$/.test(id);
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
    const maxText=folder==='ego'?300000:4000;
    let saved;
    try{saved=await readSavedResearchArtifact(this.artifacts,this.projectsRoot,{projectId,runId,folder,artifactId:proof.documentArtifactId,mimeType:'application/json',...(proof.documentSha256?{expectedSha256:proof.documentSha256}:{})});}
    catch(error){return blocked(error instanceof SavedResearchArtifactError?error.code:'ARTIFACT_UNAVAILABLE');}
    const {artifact,bytes}=saved;
    let document:z.infer<typeof documentSchema>;
    try{document=documentSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return blocked('DOCUMENT_INVALID');}
    if(document.text.length>maxText)return blocked('DOCUMENT_INVALID');
    if(sha256Bytes(Buffer.from(document.text))!==document.contentHash||document.contentHash!==evidence.contentHash||document.contentHash!==proof.contentHash||document.sourceUrl!==proof.sourceUrl||document.finalUrl!==proof.finalUrl||document.finalUrl!==evidence.sourceUrl||document.fetchedAt!==proof.fetchedAt||document.fetchedAt!==evidence.fetchedAt||document.title!==evidence.title||document.excerpt!==evidence.excerpt)return blocked('EVIDENCE_MISMATCH');
    return {status:'VERIFIED',projectId,runId,evidenceId,title:document.title,text:document.text,provider:proof.provider,sourceUrl:document.sourceUrl,finalUrl:document.finalUrl,fetchedAt:document.fetchedAt,verifiedAt:new Date().toISOString(),contentHash:document.contentHash,artifactSha256:artifact.sha256!,truncated:proof.truncated,screenshot:'NOT_VERIFIED'};
  }
}
