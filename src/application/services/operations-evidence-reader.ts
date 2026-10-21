import fs from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import type {ProductFlowRepository} from "../ports/product-flow-repository.js";
import type {DouyinOpsRepository} from "../ports/douyin-ops-repository.js";
import type {DouyinCollectionRepository} from "../ports/douyin-collection-repository.js";
import type {DouyinOperationsScheduleRepository} from "../ports/douyin-operations-schedule-repository.js";
import {creativeBatchSchema,productTruthSchema} from "../../domain/schemas.js";
import {feedbackInputReceiptSchema} from "../../domain/douyin-feedback-evidence.js";
import {assertEvidenceScope} from "../../domain/douyin-feedback-validation.js";
import {hashValue,sha256Bytes,sha256Text} from "../../domain/hashing.js";
import {assertSavedMetricSnapshot} from "./douyin-read-evidence-audit.js";

const unavailable=(code:string)=>({status:"UNVERIFIABLE" as const,code});
const recordSchema=z.object({projectId:z.string(),cycleId:z.string().min(1),actionId:z.string().min(1),kind:z.literal("STRATEGY_INPUT"),createdAt:z.string().datetime(),payload:z.object({batchId:z.string().min(1),version:z.number().int().positive(),batchHash:z.string().regex(/^[a-f0-9]{64}$/),truthHash:z.string().regex(/^[a-f0-9]{64}$/),context:z.unknown(),inputHash:z.string(),feedback:z.array(z.unknown()),feedbackInputReceipt:feedbackInputReceiptSchema.optional(),activate:z.boolean()}).passthrough()});

/** Saved data only. This reader has no runtime, acquisition, model or mutation dependency. */
export class OperationsEvidenceReader {
  constructor(private readonly schedules:Pick<DouyinOperationsScheduleRepository,"get"|"list"|"inspectLease">,
    private readonly collections:Pick<DouyinCollectionRepository,"get">,
    private readonly ops:Pick<DouyinOpsRepository,"findWorkBindingById"|"findMetricSnapshotByCaptureKey"|"findInsightById"|"findCreativeFeedbackById">,
    private readonly flow:Pick<ProductFlowRepository,"getProject"|"getVerifiedVersion">,
    private readonly artifacts:Pick<ArtifactRepository,"findById"|"listByProject">,
    private readonly projectsRoot:string,private readonly clock:()=>Date=()=>new Date()){}

  async schedule(projectId:string,id:string){
    try{
      const run=await this.schedules.get(projectId,id);if(!run)return null;
      const binding=await this.ops.findWorkBindingById(run.input.bindingId);
      if(!binding||binding.projectId!==projectId||binding.awemeId!==run.input.awemeId||binding.opsAccountUid!==run.input.opsAccountUid||binding.status!=="BOUND")return unavailable("SCHEDULE_SCOPE_CHANGED");
      const checkedAt=this.clock().toISOString(),lease=await this.schedules.inspectLease?.(projectId,id,checkedAt);
      if(!lease||lease.revision!==run.revision)return unavailable("SCHEDULE_VERSION_UNVERIFIED");
      const handles=new Map<string,{kind:"COMMENTS"|"REPLIES";parentCid?:string}>();
      for(const item of run.history){
        handles.set(item.commentsRunId,{kind:"COMMENTS"});
        for(const scope of item.observationCoverage?.replies??[])if(scope.runId)handles.set(scope.runId,{kind:"REPLIES",parentCid:scope.parentCid});
        for(const replyId of item.replyRunIds)if(!handles.has(replyId))return unavailable("SCHEDULE_SCOPE_UNVERIFIED");
      }
      if(run.checkpoint?.commentsRunId)handles.set(run.checkpoint.commentsRunId,{kind:"COMMENTS"});
      for(const [parentCid,runId] of Object.entries(run.checkpoint?.replyRuns??{}))handles.set(runId,{kind:"REPLIES",parentCid});
      const savedCollections=[];
      for(const [runId,scope] of handles){
        const saved=await this.collections.get(projectId,runId);
        if(!saved||saved.projectId!==projectId||saved.bindingId!==binding.id||saved.awemeId!==run.input.awemeId||saved.opsAccountUid!==run.input.opsAccountUid||saved.kind!==scope.kind||saved.parentCid!==scope.parentCid||saved.pageSize!==run.input.pageSize||saved.batchPages!==1)return unavailable("SCHEDULE_COLLECTION_CHANGED");
        savedCollections.push(saved);
      }
      const metrics=[];
      const expected=new Map(run.history.map(item=>[item.index,item.metricsSnapshotId]));
      if(run.checkpoint?.metricsSnapshotId)expected.set(run.completedCaptures+1,run.checkpoint.metricsSnapshotId);
      for(const [index,snapshotId] of expected){
        const saved=await this.ops.findMetricSnapshotByCaptureKey(projectId,`schedule:${run.id}:${index}:metrics`);
        if(!saved||saved.id!==snapshotId||saved.captureKey!==`schedule:${run.id}:${index}:metrics`)return unavailable("SCHEDULE_METRICS_CHANGED");
        try{assertSavedMetricSnapshot(saved,{projectId,bindingId:binding.id,awemeId:run.input.awemeId,opsAccountUid:run.input.opsAccountUid});}catch{return unavailable("SCHEDULE_METRICS_CHANGED");}
        metrics.push({id:saved.id,captureKey:saved.captureKey,capturedAt:saved.capturedAt,contentHash:saved.contentHash,plays:saved.plays,likes:saved.likes,comments:saved.comments,shares:saved.shares,metricAvailability:saved.metricAvailability});
      }
      const windowOpen=!run.input.cadence||Boolean(run.cadenceState&&run.cadenceState.version===run.input.cadence.version&&run.cadenceState.deadlineAt===new Date(Date.parse(run.input.startAt)+run.input.cadence.maxDurationSeconds*1000).toISOString()&&Date.parse(run.cadenceState.deadlineAt)>Date.parse(checkedAt));
      const resumeAllowed=["PAUSED","BLOCKED"].includes(run.status)&&lease.state!=="ACTIVE"&&run.completedCaptures<run.input.maxCaptures&&run.consecutiveFailures<3&&!run.terminalReason&&windowOpen&&!run.checkpoint?.pendingRead&&Boolean(run.executionProtocol||!run.checkpoint)&&[undefined,"AUTH_REQUIRED","RISK_CONTROL"].includes(run.errorCode);
      return {status:"VERIFIED" as const,run,lease,collections:savedCollections,metrics,resumeAllowed,checkedAt};
    }catch{return unavailable("SCHEDULE_INTEGRITY_FAILED");}
  }

  private async bytes(projectId:string,id:string){
    const artifact=await this.artifacts.findById(id);if(!artifact||artifact.projectId!==projectId)return null;
    if(artifact.kind!=="STRUCTURED_SNAPSHOT"||!artifact.immutable||artifact.integrityStatus!=="READY"||artifact.mimeType!=="application/json"||!artifact.sha256||!artifact.sizeBytes||artifact.sizeBytes>1024*1024)throw Error("ARTIFACT_UNAVAILABLE");
    if(!/^agent-evidence-[a-f0-9]{64}$/.test(id)||artifact.relativePath!=="agent-evidence/"+id.slice("agent-evidence-".length)+".json")throw Error("PATH_DENIED");
    const root=path.resolve(this.projectsRoot),project=path.resolve(root,projectId),file=path.resolve(project,artifact.relativePath);
    if(path.dirname(project)!==root||!file.startsWith(project+path.sep))throw Error("PATH_DENIED");
    for(let cursor=file;cursor!==root;cursor=path.dirname(cursor))if((await fs.lstat(cursor)).isSymbolicLink())throw Error("PATH_DENIED");
    if(await fs.realpath(project)!==project||await fs.realpath(file)!==file)throw Error("PATH_DENIED");
    const before=await fs.stat(file);if(!before.isFile()||before.nlink!==1||before.size!==artifact.sizeBytes)throw Error("ARTIFACT_CHANGED");
    const bytes=await fs.readFile(file),after=await fs.stat(file);
    if(after.nlink!==1||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==artifact.sizeBytes||sha256Bytes(bytes)!==artifact.sha256)throw Error("ARTIFACT_CHANGED");
    return {artifact,bytes};
  }

  async candidate(projectId:string,artifactId:string){
    let owned;try{owned=await this.artifacts.findById(artifactId);}catch{return unavailable("ARTIFACT_UNAVAILABLE");}if(!owned||owned.projectId!==projectId)return null;
    try{
      const saved=await this.bytes(projectId,artifactId);if(!saved)return null;
      const record=recordSchema.parse(JSON.parse(saved.bytes.toString("utf8"))),p=record.payload;
      if(record.projectId!==projectId||artifactId!=="agent-evidence-"+hashValue({projectId,cycleId:record.cycleId,actionId:record.actionId,kind:record.kind})||hashValue(p.context)!==p.inputHash)throw Error("RECEIPT_BINDING_CHANGED");
      if(!this.flow.getVerifiedVersion)throw Error("VERSION_READER_UNAVAILABLE");
      const candidate=creativeBatchSchema.parse(await this.flow.getVerifiedVersion(projectId,"CreativeBatch",p.batchId,p.version));
      const {contentHash,...body}=candidate;
      if(candidate.projectId!==projectId||contentHash!==p.batchHash||hashValue(body)!==contentHash||candidate.productTruthRef.hash!==p.truthHash)throw Error("CANDIDATE_CHANGED");
      const truth=productTruthSchema.parse(await this.flow.getVerifiedVersion(projectId,"ProductTruth",candidate.productTruthRef.entityId,candidate.productTruthRef.version)),{contentHash:truthHash,...truthBody}=truth;
      if(truth.projectId!==projectId||truthHash!==p.truthHash||hashValue(truthBody)!==truthHash)throw Error("TRUTH_REFERENCE_CHANGED");
      const stamped=candidate.douyinFeedbackReceipt;
      if(hashValue(stamped??null)!==hashValue(p.feedbackInputReceipt??null)||hashValue(stamped?.items??[])!==hashValue(p.feedback)||stamped&&(stamped.productTruthHash!==p.truthHash||stamped.inputHash!==hashValue(stamped.items)))throw Error("FEEDBACK_RECEIPT_CHANGED");
      const feedback=[];
      for(const item of stamped?.items??[]){
        assertEvidenceScope(item.observation,{projectId,bindingId:item.observation.bindingId,awemeId:item.observation.awemeId,productTruthHash:p.truthHash,evidenceHash:item.evidenceHash});
        const refs=new Set([...item.observation.metrics,...item.observation.comments].map(v=>v.evidenceRef));
        if(item.evidenceRefs.some(ref=>!refs.has(ref))||sha256Text(JSON.stringify({text:item.text,evidenceRefs:item.evidenceRefs}))!==item.actionHash)throw Error("FEEDBACK_RECEIPT_CHANGED");
        const source=await this.ops.findInsightById(item.insightId),adoption=await this.ops.findCreativeFeedbackById(item.feedbackId);
        if(!source||source.projectId!==projectId||source.evidenceHash!==item.evidenceHash||hashValue(source.observationEvidence)!==hashValue(item.observation)||!adoption||adoption.projectId!==projectId||adoption.insightId!==source.id||adoption.actionHash!==item.actionHash||adoption.actionText!==item.text||hashValue(adoption.evidenceRefs)!==hashValue(item.evidenceRefs)||adoption.confirmedAt!==item.confirmedAt)throw Error("FEEDBACK_ORIGIN_CHANGED");
        feedback.push({...item,currentState:adoption.active?"ACTIVE" as const:"INACTIVE" as const});
      }
      const project=await this.flow.getProject(projectId);if(!project)return null;
      return {status:"VERIFIED" as const,artifactId,artifactSha256:saved.artifact.sha256!,createdAt:record.createdAt,candidate,context:p.context,feedback,activatedAtGeneration:p.activate,isCurrent:project.currentCreativeBatchRef?.entityId===candidate.id&&project.currentCreativeBatchRef.version===candidate.version&&project.currentCreativeBatchRef.hash===candidate.contentHash,currentTruthMatches:project.currentProductTruthRef?.hash===p.truthHash};
    }catch(error){return unavailable(error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:"RECEIPT_INTEGRITY_FAILED");}
  }

  async overview(projectId:string){
    let schedules: Array<{id:string;inspection:Awaited<ReturnType<OperationsEvidenceReader["schedule"]>>}>=[],scheduleUnavailable=false;
    try{const rows=await this.schedules.list(projectId);for(const row of rows.slice(0,30))schedules.push({id:row.id,inspection:await this.schedule(projectId,row.id)});}catch{scheduleUnavailable=true;}
    const candidates:Array<{id:string;inspection:Awaited<ReturnType<OperationsEvidenceReader["candidate"]>>}>=[];
    let candidatesUnavailable=false,records:Awaited<ReturnType<ArtifactRepository["listByProject"]>>=[];
    try{records=(await this.artifacts.listByProject(projectId,"STRUCTURED_SNAPSHOT")).filter(a=>a.id.startsWith("agent-evidence-")).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));}catch{candidatesUnavailable=true;}
    for(const artifact of records.slice(0,30)){
      try{const saved=await this.bytes(projectId,artifact.id);if(saved&&JSON.parse(saved.bytes.toString("utf8")).kind!=="STRATEGY_INPUT")continue;}catch{/* Display unavailable receipts instead of hiding damaged files. */}
      candidates.push({id:artifact.id,inspection:await this.candidate(projectId,artifact.id)});
    }
    return {schedules,scheduleUnavailable,candidates,candidatesUnavailable,candidatesCapped:records.length>30,readOnly:true as const};
  }
}
export type ScheduleInspection=NonNullable<Awaited<ReturnType<OperationsEvidenceReader["schedule"]>>>;
export type CandidateInspection=NonNullable<Awaited<ReturnType<OperationsEvidenceReader["candidate"]>>>;
export type OperationsOverview=Awaited<ReturnType<OperationsEvidenceReader["overview"]>>;
