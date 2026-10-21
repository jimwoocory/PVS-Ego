import fs from 'node:fs/promises';
import path from 'node:path';
import type {ArtifactRepository} from '../ports/artifact-repository.js';
import {sha256Bytes} from '../../domain/hashing.js';

export class SavedResearchArtifactError extends Error {
  constructor(readonly code:string){super(code);}
}
function deny(code:string):never {throw new SavedResearchArtifactError(code);}
/** Bounded saved bytes only. Never repairs, acquires or follows linked paths. */
export async function readSavedResearchArtifact(repo:Pick<ArtifactRepository,'findById'>,projectsRoot:string,
  scope:{projectId:string;runId:string;folder:'ego'|'go-local';artifactId:string;mimeType:'application/json'|'image/png';expectedSha256?:string}){
  if(![scope.projectId,scope.runId].every(id=>/^[A-Za-z0-9_-]{1,100}$/.test(id)))deny('PATH_DENIED');
  let artifact;try{artifact=await repo.findById(scope.artifactId);}catch{deny('ARTIFACT_UNAVAILABLE');}
  if(!artifact||artifact.projectId!==scope.projectId||artifact.kind!=='OTHER'||artifact.integrityStatus!=='READY'||!artifact.immutable||artifact.mimeType!==scope.mimeType||!(/^[a-f0-9]{64}$/.test(artifact.sha256??''))||!Number.isSafeInteger(artifact.sizeBytes)||artifact.sizeBytes!<=0)deny('ARTIFACT_UNAVAILABLE');
  if(scope.expectedSha256!==undefined&&scope.expectedSha256!==artifact.sha256)deny('ARTIFACT_CHANGED');
  const maxBytes=scope.mimeType==='image/png'?8_000_000:scope.folder==='ego'?2_000_000:65536;
  if(artifact.sizeBytes!>maxBytes)deny('FILE_TOO_LARGE');
  const relative=artifact.relativePath.replaceAll('\\','/'),prefix=`research/${scope.folder}/${scope.runId}/`,extension=scope.mimeType==='image/png'?'.png':'.json';
  if(path.isAbsolute(artifact.relativePath)||!relative.startsWith(prefix)||relative.slice(prefix.length).includes('/')||!relative.endsWith(extension))deny('PATH_DENIED');
  const root=path.resolve(projectsRoot),project=path.resolve(root,scope.projectId),file=path.resolve(project,artifact.relativePath);
  if(path.dirname(project)!==root||!file.startsWith(project+path.sep))deny('PATH_DENIED');
  let bytes:Buffer;
  try{
    for(let cursor=file;cursor!==root;cursor=path.dirname(cursor))if((await fs.lstat(cursor)).isSymbolicLink())deny('PATH_DENIED');
    if(await fs.realpath(project)!==project||await fs.realpath(file)!==file)deny('PATH_DENIED');
    const before=await fs.stat(file);
    if(!before.isFile()||before.nlink!==1)deny('PATH_DENIED');
    if(before.size>maxBytes)deny('FILE_TOO_LARGE');
    if(before.size!==artifact.sizeBytes)deny('ARTIFACT_CHANGED');
    bytes=await fs.readFile(file);const after=await fs.stat(file);
    if(!after.isFile()||after.nlink!==1||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==artifact.sizeBytes||sha256Bytes(bytes)!==artifact.sha256)deny('ARTIFACT_CHANGED');
  }catch(error){if(error instanceof SavedResearchArtifactError)throw error;deny((error as NodeJS.ErrnoException).code==='ENOENT'?'FILE_MISSING':'PATH_DENIED');}
  if(scope.mimeType==='image/png'&&!bytes!.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))deny('ARTIFACT_CHANGED');
  return {artifact,bytes:bytes!};
}
