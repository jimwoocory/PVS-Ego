import type {PrismaClient} from "@prisma/client";
import {randomUUID} from 'node:crypto';
import {browserPublishCheckpointSchema,type BrowserPublishCheckpoint,type BrowserPublishCheckpointRepository} from "../../application/ports/browser-publish-preparation.js";
import {hashValue} from "../../domain/hashing.js";

/** Append-only revisions in the existing version store. No second publish package, database or migration. */
export class PrismaBrowserPublishCheckpoints implements BrowserPublishCheckpointRepository {
 constructor(private readonly db:PrismaClient){}
 private validate(input:unknown){
  const cp=browserPublishCheckpointSchema.parse(input),{contentHash,...body}=cp;
  if(contentHash!==hashValue(body)||cp.scopeHash!==hashValue(cp.scope)||cp.scope.projectId!==cp.projectId||cp.scope.packageId!==cp.packageId||
   cp.binding&&(cp.binding.runtimeId!==cp.scope.runtimeId||cp.binding.accountKey!==cp.scope.accountKey)||
   !['PREPARING','BLOCKED'].includes(cp.phase)&&!cp.binding)throw Error('BROWSER_CHECKPOINT_INTEGRITY_FAILED');
  return cp;
 }
 async latest(projectId:string,packageId:string){
  const row=await this.db.versionedEntity.findFirst({where:{projectId,entityType:"BrowserPublishCheckpoint",entityKey:packageId},orderBy:{version:"desc"}});
  if(!row)return null;
  const parsed=this.validate(JSON.parse(row.dataJson));
  if(row.contentHash!==parsed.contentHash||row.version!==parsed.version||row.status!==parsed.phase||row.id!==parsed.id||parsed.projectId!==projectId||parsed.packageId!==packageId)throw Error("BROWSER_CHECKPOINT_INTEGRITY_FAILED");
  return parsed;
 }
 async append(input:BrowserPublishCheckpoint,expectedVersion:number){
  const cp=this.validate(input);
  if(cp.version!==expectedVersion+1||expectedVersion===0&&cp.phase!=='PREPARING')throw Error("BROWSER_CHECKPOINT_INTEGRITY_FAILED");
  // The unique project/type/key/version index is the durable compare-and-set fence.
  try{return await this.db.$transaction(async tx=>{
   const prior=await tx.versionedEntity.findFirst({where:{projectId:cp.projectId,entityType:"BrowserPublishCheckpoint",entityKey:cp.packageId},orderBy:{version:"desc"}});
   if((prior?.version??0)!==expectedVersion)return false;
   if(prior){const old=this.validate(JSON.parse(prior.dataJson));if(prior.contentHash!==old.contentHash||prior.status!==old.phase||old.scopeHash!==cp.scopeHash)throw Error('BROWSER_CHECKPOINT_INTEGRITY_FAILED');}
   if(expectedVersion===0){
    // Also honor older checkpoints created before reservations existed. Any
    // interrupted/blocked preparation may already have selected/uploaded media.
    const historical=await tx.versionedEntity.findMany({where:{projectId:cp.projectId,entityType:'BrowserPublishCheckpoint'}});
    for(const row of historical){const old=this.validate(JSON.parse(row.dataJson));if(row.contentHash!==old.contentHash)throw Error('BROWSER_CHECKPOINT_INTEGRITY_FAILED');if(old.packageId!==cp.packageId&&(old.scope.videoSha256===cp.scope.videoSha256||old.scope.assemblyId===cp.scope.assemblyId))return false;}
    // Both unique reservations and PREPARING commit atomically. No expiry or
    // failure automatically releases ownership or permits another upload.
    for(const key of ['sha:'+cp.scope.videoSha256,'assembly:'+cp.scope.assemblyId]){
     const value={projectId:cp.projectId,packageId:cp.packageId,checkpointId:cp.id,videoSha256:cp.scope.videoSha256,assemblyId:cp.scope.assemblyId,scopeHash:cp.scopeHash,createdAt:cp.createdAt};
     await tx.versionedEntity.create({data:{id:randomUUID(),projectId:cp.projectId,entityType:'BrowserPublishMediaReservation',entityKey:key,version:1,status:'RESERVED_NO_AUTOMATIC_RETRY',contentHash:hashValue(value),dataJson:JSON.stringify(value)}});
    }
   }
   await tx.versionedEntity.create({data:{id:cp.id,projectId:cp.projectId,entityType:"BrowserPublishCheckpoint",entityKey:cp.packageId,version:cp.version,status:cp.phase,contentHash:cp.contentHash,dataJson:JSON.stringify(cp)}});return true;
  });}catch(error){if(["P2002","P2034","P1008"].includes((error as {code?:string}).code??""))return false;throw error;}
 }
}
