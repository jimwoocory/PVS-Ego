import type {PrismaClient} from "@prisma/client";
import {browserPublishCheckpointSchema,type BrowserPublishCheckpoint,type BrowserPublishCheckpointRepository} from "../../application/ports/browser-publish-preparation.js";
import {hashValue} from "../../domain/hashing.js";

/** Append-only revisions in the existing version store. No second publish package, database or migration. */
export class PrismaBrowserPublishCheckpoints implements BrowserPublishCheckpointRepository {
 constructor(private readonly db:PrismaClient){}
 async latest(projectId:string,packageId:string){
  const row=await this.db.versionedEntity.findFirst({where:{projectId,entityType:"BrowserPublishCheckpoint",entityKey:packageId},orderBy:{version:"desc"}});
  if(!row)return null;
  const parsed=browserPublishCheckpointSchema.parse(JSON.parse(row.dataJson)),{contentHash,...body}=parsed;
  if(contentHash!==hashValue(body)||row.contentHash!==contentHash||row.version!==parsed.version||parsed.projectId!==projectId||parsed.packageId!==packageId)throw Error("BROWSER_CHECKPOINT_INTEGRITY_FAILED");
  return parsed;
 }
 async append(input:BrowserPublishCheckpoint,expectedVersion:number){
  const cp=browserPublishCheckpointSchema.parse(input),{contentHash,...body}=cp;
  if(cp.version!==expectedVersion+1||hashValue(body)!==contentHash)throw Error("BROWSER_CHECKPOINT_INTEGRITY_FAILED");
  // The unique project/type/key/version index is the durable compare-and-set fence.
  try{return await this.db.$transaction(async tx=>{
   const prior=await tx.versionedEntity.findFirst({where:{projectId:cp.projectId,entityType:"BrowserPublishCheckpoint",entityKey:cp.packageId},orderBy:{version:"desc"}});
   if((prior?.version??0)!==expectedVersion)return false;
   await tx.versionedEntity.create({data:{id:cp.id,projectId:cp.projectId,entityType:"BrowserPublishCheckpoint",entityKey:cp.packageId,version:cp.version,status:cp.phase,contentHash:cp.contentHash,dataJson:JSON.stringify(cp)}});return true;
  });}catch(error){if(["P2002","P2034","P1008"].includes((error as {code?:string}).code??""))return false;throw error;}
 }
}
