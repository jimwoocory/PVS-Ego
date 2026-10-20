import fs from "node:fs/promises";
import path from "node:path";
import type {CanvasVideoDownload} from "../ports/canvas-video-download.js";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import type {GenerationRepository} from "../ports/generation-repository.js";
import type {WorkflowRepository} from "../ports/workflow-repository.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import type {CanvasProductionBinding} from "../../domain/canvas-production.js";
import {CanvasProductionService} from "./canvas-production-service.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {LocalArtifactStore} from "../../adapters/store/local-artifact-store.js";
import {sha256Bytes,hashValue} from "../../domain/hashing.js";
import {inspectMedia} from "../../adapters/media/inspect-media.js";
import {assessMediaRatio} from "./generated-media-spec-qc.js";

/** Native Canvas outputs enter the SAME attempt/artifact/review pipeline; this class never submits generation. */
export class CanvasVideoResultService{
  constructor(private readonly canvas:CanvasProductionService,private readonly download:CanvasVideoDownload,
    private readonly artifacts:ArtifactRepository,private readonly generation:GenerationRepository,private readonly workflow:WorkflowRepository,
    private readonly projectsRoot:string,private readonly inspect:typeof inspectMedia=inspectMedia){}
  async readiness(){const account=await this.canvas.runtime.assertAccount();return this.download.readiness(account.accountFingerprint);}
  async sync(run:SmartGenerationRun,clipId:string,checkpoint:(b:CanvasProductionBinding)=>Promise<void>){
    const b=run.canvasBinding,n=b?.nodes.find(n=>n.kind==="VIDEO"&&n.key===clipId);
    if(!b||!n?.execution||!run.consent||run.consent.scopeHash!==n.execution.scopeHash||run.paidScope?.hash!==run.consent.scopeHash)
      throw new CanvasRuntimeError("VIDEO_RESULT_HAS_NO_AUTHORIZED_ORIGINAL_SUBMISSION");
    await this.canvas.runtime.assertAccount();await this.canvas.inspectBoundNodes(b);
    const attempts=(await this.workflow.listGenerationAttempts(run.projectId)).filter(a=>run.attemptIds.includes(a.id)&&a.clipId===clipId&&a.providerHandle?.submitId===n.submitId);
    if(attempts.length!==1)throw new CanvasRuntimeError("VIDEO_RESULT_ATTEMPT_BINDING_INVALID");
    const attempt=attempts[0]!,request=await this.generation.getGenerationRequest(attempt.generationRequestId);
    const approval=await this.generation.getUserApproval(attempt.userApprovalId);
    if(!request||request.provider!=="dreamina-canvas"||request.projectId!==run.projectId||request.clipId!==clipId||request.requestHash!==attempt.requestHash||
      !approval||approval.generationRequestId!==request.id||approval.requestHash!==request.requestHash||approval.approvalHash!==attempt.approvalHash||
      !run.paidScope?.requests.some(r=>r.clipId===clipId&&r.requestId===request.id&&r.requestHash===request.requestHash))
      throw new CanvasRuntimeError("VIDEO_RESULT_REQUEST_BINDING_INVALID");
    if(request.canvasBinding&&(request.canvasBinding.nodeId!==n.nodeId||request.canvasBinding.submitId!==n.submitId||request.canvasBinding.runId!==run.id||
      request.canvasBinding.projectId!==b.projectId||request.canvasBinding.accountFingerprint!==b.accountFingerprint||request.canvasBinding.generationHash!==n.generationHash))
      throw new CanvasRuntimeError("VIDEO_RESULT_NATIVE_BINDING_CHANGED");
    if(attempt.outputArtifactId){const artifact=await this.artifacts.findById(attempt.outputArtifactId);
      if(!artifact||artifact.projectId!==run.projectId||artifact.integrityStatus!=="READY"||artifact.sha256!==n.delivery?.sha256)throw new CanvasRuntimeError("VIDEO_RESULT_ARTIFACT_BINDING_INVALID");
      const root=path.resolve(this.projectsRoot,run.projectId),file=path.resolve(root,artifact.relativePath);
      if(!file.startsWith(root+path.sep)||sha256Bytes(await fs.readFile(file))!==artifact.sha256)throw new CanvasRuntimeError("VIDEO_RESULT_STORED_BYTES_CHANGED");
      if(attempt.status!=="FAILED"||attempt.errorCode!=="CANVAS_VIDEO_MEDIA_QC_FAILED")return attempt;}
    const status=(await this.canvas.runtime.call(["operation","status",n.submitId,"--project-id",b.projectId])).data;
    if(status?.operationRef!==n.submitId)throw new CanvasRuntimeError("VIDEO_RESULT_OPERATION_MISMATCH");
    if(["pending","running"].includes(status.state))return this.workflow.updateGenerationAttemptStatus(attempt.id,{status:"PROCESSING"});
    if(status.state==="failed")return this.workflow.updateGenerationAttemptStatus(attempt.id,{status:"FAILED",errorCode:"CANVAS_VIDEO_GENERATION_FAILED",errorMessage:"原Canvas视频生成失败，不会自动重提"});
    if(status.state!=="succeeded"||status.submission?.adviceCode!=="submission_accepted")throw new CanvasRuntimeError("VIDEO_RESULT_OUTCOME_UNKNOWN");
    n.execution.state="ACCEPTED";n.execution.updatedAt=new Date().toISOString();
    const successes=status.resources?.filter((r:any)=>r.state==="succeeded")??[];
    const selected=n.delivery?.resourceId?successes.find((r:any)=>r.resourceId===n.delivery!.resourceId):successes.length===1?successes[0]:undefined;
    if(!selected)throw new CanvasRuntimeError("VIDEO_RESULT_RESOURCE_SELECTION_REQUIRED");
    const resource=(await this.canvas.runtime.call(["resource","get",selected.resourceId,"--project-id",b.projectId])).data;
    if(resource?.resourceId!==selected.resourceId||resource.type!=="video"||resource.status!=="success")throw new CanvasRuntimeError("VIDEO_RESULT_RESOURCE_INVALID");
    const capability=await this.readiness();if(!capability.ready)throw new CanvasRuntimeError(capability.code??"VIDEO_DOWNLOAD_UNAVAILABLE");
    n.delivery={attemptId:attempt.id,resourceId:selected.resourceId,state:"DOWNLOADING",findings:[]};await checkpoint(b);
    const projectRoot=path.resolve(this.projectsRoot,run.projectId),tempRoot=path.resolve(projectRoot,".tmp");
    if(!projectRoot.startsWith(path.resolve(this.projectsRoot)+path.sep)||!tempRoot.startsWith(projectRoot+path.sep))throw new CanvasRuntimeError("VIDEO_RESULT_PATH_INVALID");
    await fs.mkdir(tempRoot,{recursive:true});const temp=await fs.mkdtemp(path.join(tempRoot,"canvas-result-")),target=path.join(temp,"video.mp4");
    try{
      const artifactId="canvas-video:"+attempt.id;let artifact=await this.artifacts.findById(artifactId);
      if(!artifact){const fetched=await this.download.download({canvasProjectId:b.projectId,nodeId:n.nodeId,submitId:n.submitId,resourceId:selected.resourceId,accountFingerprint:b.accountFingerprint,outputPath:target});
        if(path.resolve(fetched.path)!==path.resolve(target))throw new CanvasRuntimeError("VIDEO_RESULT_OUTPUT_PATH_CHANGED");
        const bytes=await fs.readFile(target);
        if(sha256Bytes(bytes)!==fetched.sha256||bytes.length!==fetched.sizeBytes||bytes.length<12)throw new CanvasRuntimeError("VIDEO_RESULT_INTEGRITY_FAILED");
        // Preserve a paid result before format/audio/ratio QC. A failed check must never erase the only output.
        artifact=await new LocalArtifactStore(projectRoot,this.artifacts).writeImmutable({id:artifactId,projectId:run.projectId,kind:"GENERATED_VIDEO",immutable:true,
          relativePath:"outputs/canvas/"+hashValue(attempt.id)+".mp4",bytes,mimeType:"video/mp4"});
      }
      if(artifact.projectId!==run.projectId||artifact.integrityStatus!=="READY"||artifact.kind!=="GENERATED_VIDEO")throw new CanvasRuntimeError("VIDEO_RESULT_STORED_ARTIFACT_INVALID");
      const file=path.resolve(projectRoot,artifact.relativePath);if(!file.startsWith(projectRoot+path.sep))throw new CanvasRuntimeError("VIDEO_RESULT_PATH_INVALID");
      const bytes=await fs.readFile(file);if(sha256Bytes(bytes)!==artifact.sha256)throw new CanvasRuntimeError("VIDEO_RESULT_STORED_BYTES_CHANGED");
      const findings:string[]=[];let media:Awaited<ReturnType<typeof inspectMedia>>|undefined;
      if(bytes.toString("ascii",4,8)!=="ftyp")findings.push("文件不是可核验的MP4容器");
      try{media=await this.inspect(file);
        if(!media.hasVideo)findings.push("文件没有视频流");if(Math.abs(media.durationMs-request.durationMs)>500)findings.push("实际时长与本镜头规格不符");
        if(assessMediaRatio(request.aspectRatio,media).status!=="PASS")findings.push("实际画幅与本镜头规格不符");
        if(request.generateAudio&&!media.hasAudio)findings.push("要求原生音轨但实际文件没有音轨");
      }catch{findings.push("无法读取实际视频媒体信息");}
      n.delivery={attemptId:attempt.id,resourceId:selected.resourceId,artifactId:artifact.id,sha256:artifact.sha256,state:findings.length?"QC_FAILED":"NEEDS_REVIEW",findings,
        ...(media?{durationMs:media.durationMs,width:media.width,height:media.height,hasAudio:media.hasAudio}:{})};await checkpoint(b);
      return this.workflow.updateGenerationAttemptStatus(attempt.id,{status:findings.length?"FAILED":"SUCCEEDED",outputArtifactId:artifact.id,completedAt:new Date().toISOString(),
        errorCode:findings.length?"CANVAS_VIDEO_MEDIA_QC_FAILED":undefined,errorMessage:findings.length?findings.join("；"):undefined});
    }finally{
      const resolved=path.resolve(temp);if(resolved.startsWith(tempRoot+path.sep))await fs.rm(resolved,{recursive:true,force:true});
    }
  }
}
