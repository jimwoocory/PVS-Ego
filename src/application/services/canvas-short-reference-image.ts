import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import type {CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import {LocalArtifactStore} from "../../adapters/store/local-artifact-store.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {CanvasProductionService,canvasGenerationHash,validateCanvasQuote} from "./canvas-production-service.js";

type Save=(p:CanvasShortPlan)=>Promise<void>;
const now=()=>new Date().toISOString();
async function context(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,revisionHash:string,requestHash:string){
  const head=p.visualRevisions?.at(-1),q=p.referenceQuote,node=q?.nodes.find(n=>n.key==="SETTING"),b=parent.canvasBinding;
  if(!head||head.contentHash!==revisionHash||head.contentHash!==hashValue(head.payload)||head.designReview?.contentHash!==revisionHash||
    !q||q.revisionHash!==revisionHash||q.requestHash!==requestHash||!node?.saved||!b||q.projectId!==b.projectId||
    head.payload.sourcePlanHash!==p.contentHash||p.contentHash!==hashValue(p.payload)||p.parentRunId!==parent.id||p.projectId!==parent.projectId||
    p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash||
    parent.consent||p.consent||parent.attemptIds.length||p.attemptIds.length||p.paidScope)
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_SOURCE_CHANGED");
  const account=await canvas.runtime.assertAccount();
  if(account.accountFingerprint!==q.accountFingerprint||account.accountFingerprint!==b.accountFingerprint||q.profile!==canvas.runtime.config.profile||
    q.executableSha256!==canvas.runtime.config.executableSha256)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ACCOUNT_CHANGED");
  const shown=(await canvas.runtime.call(["node","show","--project-id",q.projectId,"--node-id",node.nodeId])).data;
  const remote=shown?.nodes?.find((n:any)=>n.result==="FOUND"&&n.node?.nodeId===node.nodeId)?.node,g=remote?.generation;
  if(!g||canvasGenerationHash(g)!==node.generationHash||g.mode!=="t2i"||g.model!=="seedream_5.0_lite"||g.prompt!==q.imagePrompt||
    g.ratio!=="9:16"||g.resolution!=="2K"||g.outputCount!==1||(g.references?.length??0)!==0||!Number.isSafeInteger(shown.draftVersion))
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_NODE_CHANGED");
  return {q,node,account,draftVersion:shown.draftVersion as number};
}
export async function generateZeroShortReference(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,
  revisionHash:string,requestHash:string,confirmed:boolean,save:Save){
  if(!confirmed)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_EXPLICIT_ZERO_CONSENT_REQUIRED");
  const c=await context(canvas,parent,p,revisionHash,requestHash);
  const scopeHash=hashValue({projectId:parent.projectId,runId:parent.id,planId:p.id,revisionHash,requestHash,canvasProjectId:c.q.projectId,
    nodeId:c.node.nodeId,generationHash:c.node.generationHash,accountFingerprint:c.account.accountFingerprint,creditCeiling:0,count:1,model:"seedream_5.0_lite"});
  if(p.referenceImage){
    if(p.referenceImage.scopeHash!==scopeHash)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_PERMISSION_CHANGED");
    return p.referenceImage; // Never repeat confirm/run after any durable execution state, including PREPARED/UNKNOWN.
  }
  const model=await canvas.runtime.findModel("seedream_5.0_lite","image"),mode=model.modes?.find((m:any)=>m.name==="t2i");
  if(model.model!=="seedream_5.0_lite"||!mode?.flags?.find((f:any)=>f.flag==="--ratio")?.values?.includes("9:16")||
    !mode.flags?.find((f:any)=>f.flag==="--resolution")?.values?.includes("2K"))throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_MODEL_CHANGED");
  const quote=await canvas.runtime.call(["node","quote","--project-id",c.q.projectId,"--node-id",c.node.nodeId]);
  const checked=validateCanvasQuote(quote.data,[c.node.nodeId],c.draftVersion);
  if(!checked.confirmable||checked.items[0]?.error||checked.items[0]?.maxCredits!==0||!quote.meta?.requestId)
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_NO_LONGER_ZERO");
  const image=p.referenceImage={scopeHash,revisionHash,quoteRequestHash:requestHash,nodeId:c.node.nodeId,generationHash:c.node.generationHash,
    accountFingerprint:c.account.accountFingerprint,creditCeiling:0 as const,count:1 as const,model:"seedream_5.0_lite" as const,
    consent:{source:"EXPLICIT_USER_ZERO_REFERENCE_IMAGE" as const,approvedAt:now()},submitId:randomUUID(),state:"PREPARED" as const,
    liveQuote:{draftVersion:checked.draftVersion,sourceRequestId:quote.meta.requestId,checkedAt:now(),credits:0 as const},resources:[] as string[],updatedAt:now()};
  p.blocker="仅同框参考图获准最高0积分；视频仍未授权，图像完成后等待用户审核";await save(p);
  try{
    // Budget token remains only in this frame; never persist it or log raw confirmation envelopes.
    const approval=await canvas.runtime.call(["node","confirm","--project-id",c.q.projectId,"--node-id",c.node.nodeId,"--credit-ceiling","0"],true);
    if(!approval.data?.creditConfirmationToken||approval.data.creditCeiling!==0||!Number.isFinite(Date.parse(approval.data.expiresAt))||Date.parse(approval.data.expiresAt)<=Date.now())
      throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ZERO_TOKEN_INVALID");
    p.referenceImage!.state="DISPATCHING";p.referenceImage!.updatedAt=now();await save(p);
    const response=await canvas.runtime.call(["node","run","--project-id",c.q.projectId,"--node-id",c.node.nodeId,"--submit-id",image.submitId,
      "--credit-token",approval.data.creditConfirmationToken],true);
    const item=response.data?.items?.[0];
    if(response.data?.items?.length!==1||item.nodeId!==c.node.nodeId||item.submitId!==image.submitId||item.generationDiff?.length)
      throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_SUBMIT_RECEIPT_CHANGED");
    p.referenceImage!.state=item.state==="accepted"?"ACCEPTED":item.state==="rejected"?"FAILED":"UNKNOWN";
    p.referenceImage!.resources=(item.resources??[]).map((r:any)=>r.resourceId);p.referenceImage!.submissionRequestId=response.meta?.requestId;
    p.referenceImage!.updatedAt=now();await save(p);return p.referenceImage!;
  }catch(error){p.referenceImage!.state="UNKNOWN";p.referenceImage!.error=error instanceof CanvasRuntimeError?error.code:"SHORT_REFERENCE_IMAGE_OUTCOME_UNKNOWN";
    p.referenceImage!.updatedAt=now();await save(p);throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_RECONCILE_ORIGINAL_SUBMIT_ONLY");}
}

/** Query/download the one authorized submission. No confirm/run is reachable from this method. */
export async function syncShortReference(canvas:CanvasProductionService,parent:SmartGenerationRun,p:CanvasShortPlan,artifacts:ArtifactRepository,projectsRoot:string,save:Save){
  const image=p.referenceImage;if(!image)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_PERMISSION_MISSING");
  const c=await context(canvas,parent,p,image.revisionHash,image.quoteRequestHash);
  if(image.nodeId!==c.node.nodeId||image.generationHash!==c.node.generationHash||image.accountFingerprint!==c.account.accountFingerprint||
    image.creditCeiling!==0||image.count!==1||image.model!=="seedream_5.0_lite"||image.consent.source!=="EXPLICIT_USER_ZERO_REFERENCE_IMAGE")
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_PERMISSION_CHANGED");
  const root=path.resolve(projectsRoot,p.projectId);
  if(image.artifact){const a=await artifacts.findById(image.artifact.id),target=path.resolve(root,image.artifact.relativePath);
    if(!target.startsWith(root+path.sep)||!a||a.projectId!==p.projectId||a.integrityStatus!=="READY"||a.sha256!==image.artifact.sha256||
      a.relativePath!==image.artifact.relativePath||sha256Bytes(await fs.readFile(target))!==a.sha256)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ARTIFACT_CHANGED");
    return image;
  }
  const response=await canvas.runtime.call(["operation","status",image.submitId,"--project-id",c.q.projectId]),data=response.data;
  if(data?.operationRef!==image.submitId)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_OPERATION_CHANGED");
  image.observationRequestId=response.meta?.requestId;image.updatedAt=now();
  if(data.state==="failed"){image.state="FAILED";image.error="原同框图生成失败；没有自动重提";await save(p);return image;}
  const resources=(data.resources??[]).filter((r:any)=>r.state==="succeeded");
  if(data.state!=="succeeded"){await save(p);return image;}
  if(resources.length!==1||!/^[-a-f0-9]{36}$/.test(resources[0].resourceId))throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_RESOURCE_COUNT_CHANGED");
  const resourceId=resources[0].resourceId;image.resources=[resourceId];await save(p);
  const tempRoot=path.join(root,".tmp");await fs.mkdir(tempRoot,{recursive:true});
  const target=path.join(tempRoot,"short-reference-"+image.submitId+"-"+randomUUID()+".png");
  const downloaded=await canvas.runtime.call(["resource","download",resourceId,"--project-id",c.q.projectId,"--output",target]);
  const bytes=await fs.readFile(target),sha=sha256Bytes(bytes);
  if(downloaded.data?.resourceId!==resourceId||downloaded.data.sha256!==sha||downloaded.data.size!==bytes.length)
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_DOWNLOAD_CHANGED");
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":bytes[0]===255&&bytes[1]===216?"image/jpeg":
    bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"?"image/webp":undefined;
  if(!mime)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_FORMAT_INVALID");
  const {stdout}=await promisify(execFile)(process.env.FFPROBE_PATH??"ffprobe",["-v","error","-show_entries","stream=width,height,codec_type","-of","json",target],{windowsHide:true,timeout:30000});
  const streams=JSON.parse(stdout).streams,stream=streams?.find((s:any)=>s.codec_type==="video"),width=stream?.width,height=stream?.height;
  if(streams?.length!==1||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<2000||Math.abs(width/height-9/16)>.02)
    throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_DIMENSIONS_INVALID");
  const ext=mime==="image/png"?"png":mime==="image/jpeg"?"jpg":"webp",relativePath=`production-assets/short/${p.id}/reference-${image.scopeHash}.${ext}`,id="short-reference:"+image.scopeHash;
  const file=path.resolve(root,relativePath),existing=await artifacts.findById(id);
  if(existing){
    if(existing.projectId!==p.projectId||existing.relativePath!==relativePath)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ARTIFACT_CHANGED");
    await fs.mkdir(path.dirname(file),{recursive:true});
    try{await fs.copyFile(target,file,constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    if(sha256Bytes(await fs.readFile(file))!==sha||existing.integrityStatus==="READY"&&existing.sha256!==sha)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ARTIFACT_CHANGED");
    if(existing.integrityStatus!=="READY")await artifacts.markReady(id,{sha256:sha,sizeBytes:bytes.length,mimeType:mime});
  }else await new LocalArtifactStore(root,artifacts).writeImmutable({id,projectId:p.projectId,kind:"OTHER",immutable:true,relativePath,bytes,mimeType:mime});
  image.artifact={id,sha256:sha,relativePath,sizeBytes:bytes.length,mimeType:mime,width,height};image.state="NEEDS_REVIEW";image.error=undefined;image.updatedAt=now();
  p.blocker="人物与书房同框参考图已下载，等待用户看实际图片审核；本轮不核视频报价、不生成视频";
  await save(p);await fs.rm(target,{force:true});return image;
}
