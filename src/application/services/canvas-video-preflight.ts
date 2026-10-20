import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {compiledPromptSchema,generationRequestSchema,preflightReportSchema,type GenerationRequest} from "../../domain/schemas.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import type {GenerationRepository,PreparedPreflightChain} from "../ports/generation-repository.js";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import {CanvasProductionService,canvasGenerationHash} from "./canvas-production-service.js";
import {assertCurrentQuote} from "./production-quote-service.js";
import {CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {computeGenerationRequestHash} from "./hash-contracts.js";

const ref=(entityType:string,v:{id:string;version:number;contentHash:string})=>({entityType,entityId:v.id,version:v.version,hash:v.contentHash});
export const canvasPaidScopeHash=(s:NonNullable<SmartGenerationRun["paidScope"]>)=>hashValue({planRef:s.planRef,requests:s.requests});

/** Canvas is its own provider. Never compile its paid requests using the legacy CLI registry. */
export class CanvasVideoPreflightService {
  constructor(private readonly canvas:CanvasProductionService,private readonly repo:GenerationRepository,
    private readonly artifacts:ArtifactRepository,private readonly projectsRoot:string,
    private readonly delivery:()=>Promise<{ready:boolean;code?:string;message?:string}>){ }

  async inspect(run:SmartGenerationRun){
    const b=run.canvasBinding,plan=run.productionPlan,script=run.script,creative=run.creativeBatch;
    if(!b||!plan?.generationTarget||!script||!creative||!run.truthRef)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_SOURCE_INCOMPLETE");
    const account=await this.canvas.runtime.assertAccount();
    if(b.runId!==run.id||b.accountFingerprint!==account.accountFingerprint||b.executableSha256!==this.canvas.runtime.config.executableSha256||b.profile!==this.canvas.runtime.config.profile||
      b.sourceScriptHash!==script.contentHash||b.sourcePlanHash!==plan.contentHash)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_SOURCE_CHANGED");
    const blockers:string[]=[],quote=assertCurrentQuote(run,"VIDEO");
    if(script.status!=="CONFIRMED")blockers.push("SCRIPT_REVIEW_REQUIRED");
    if(plan.status!=="CONFIRMED")blockers.push("PLAN_REVIEW_REQUIRED");
    if(b.scopeHash!==quote.scopeHash)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_QUOTE_SCOPE_CHANGED");
    const observed=await this.canvas.inspectBoundNodes(b);
    const model=await this.canvas.runtime.findModel(this.canvas.runtime.config.videoModel,"video");
    const providerIdentityHash=hashValue({provider:"dreamina-canvas",executableSha256:b.executableSha256,profile:b.profile,accountFingerprint:b.accountFingerprint});
    const capabilityFingerprint=hashValue(model),checked=await this.delivery();
    if(!checked.ready)blockers.push(checked.code??"VIDEO_DOWNLOAD_UNAVAILABLE");
    const raw=(await this.canvas.runtime.call(["node","show","--project-id",b.projectId,...b.nodes.filter(n=>n.kind==="VIDEO").flatMap(n=>["--node-id",n.nodeId])])).data;
    if(raw?.draftVersion!==observed.draftVersion)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_DRAFT_CHANGED");
    const clips=plan.scenes.flatMap(s=>s.clips),now=new Date().toISOString();
    const chain:PreparedPreflightChain={projectId:run.projectId,clipIds:clips.map(c=>c.id),staleAt:now,compiledPrompts:[],requests:[],reports:[]};
    const previous=await this.repo.listCompiledPrompts(run.projectId);
    for(const clip of clips){
      const n=b.nodes.find(n=>n.key===clip.id&&n.kind==="VIDEO"),q=quote.items.find(i=>i.request.key===clip.id&&i.request.kind==="VIDEO");
      const g=raw?.nodes?.find((x:any)=>x.result==="FOUND"&&x.node?.nodeId===n?.nodeId)?.node?.generation;
      if(!n?.saved||!g?.prompt||g.mode!=="m2v"||g.outputCount!==1||g.durationSeconds*1000!==clip.durationMs||g.ratio!==plan.generationTarget?.aspectRatio||
        g.resolution?.toLowerCase()!==plan.generationTarget.videoResolution.toLowerCase()||canvasGenerationHash(g)!==n.generationHash||g.model!==n.canonicalModel||g.model!==model.model||
        q?.result.status!=="QUOTED"||q.request.sourceRequestHash!==n.sourceRequestHash||q.result.accountFingerprint!==b.accountFingerprint||q.result.canvas?.nodeId!==n.nodeId||
        q.result.canvas.projectId!==b.projectId||q.result.canvas.canonicalModel!==g.model||q.result.canvas.generationHash!==n.generationHash)
        throw new CanvasRuntimeError("VIDEO_PREFLIGHT_NODE_OR_QUOTE_CHANGED");
      const mode=model.modes?.find((m:any)=>m.name==="m2v"),duration=mode?.flags?.find((f:any)=>f.flag==="--duration");
      if(!duration||g.durationSeconds<duration.min||g.durationSeconds>duration.max||
        !mode.flags.some((f:any)=>f.flag==="--resolution"&&f.values?.some((v:string)=>v.toLowerCase()===g.resolution.toLowerCase())))
        throw new CanvasRuntimeError("VIDEO_PREFLIGHT_MODEL_SPEC_CHANGED");
      const manifest:GenerationRequest["assetManifest"]=[];
      const references=g.references??[];
      if(references.length!==clip.referenceAssets.length)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_REFERENCE_COVERAGE_CHANGED");
      for(const [index,use] of clip.referenceAssets.entries()){
        const entry=run.productionAssetSet?.entries.find(e=>e.referenceAssetId===use.assetId||e.sourceReferenceAssetIds.includes(use.assetId));
        const node=b.nodes.find(x=>x.key===(entry?.source==="PRODUCT_INPUT"?"PRODUCT":entry?.key));
        if(!entry||!node||references[index]?.kind!=="node"||references[index]?.id!==node.nodeId)
          throw new CanvasRuntimeError("VIDEO_PREFLIGHT_REFERENCE_BINDING_CHANGED");
        if(!["READY","CONFIRMED"].includes(entry.status))blockers.push("ASSET_REVIEW_REQUIRED:"+entry.key);
        const candidates=await Promise.all(entry.artifactIds.map(id=>this.artifacts.findById(id)));
        const artifact=candidates.find(a=>a?.projectId===run.projectId&&a.integrityStatus==="READY");
        if(!artifact)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_REFERENCE_FILE_MISSING");
        const root=path.resolve(this.projectsRoot,run.projectId),file=path.resolve(root,artifact.relativePath);
        if(!file.startsWith(root+path.sep)||sha256Bytes(await fs.readFile(file))!==artifact.sha256)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_REFERENCE_FILE_CHANGED");
        manifest.push({assetId:use.assetId,artifactHash:artifact.sha256,role:use.role,priority:index,required:true,inputType:"image"});
      }
      const promptBody={id:randomUUID(),projectId:run.projectId,clipId:clip.id,version:Math.max(0,...previous.filter(p=>p.clipId===clip.id).map(p=>p.version))+1,status:"CURRENT" as const,
        provider:"dreamina-canvas" as const,model:g.model,productTruthRef:run.truthRef,creativeBatchRef:ref("CreativeBatch",creative),selectedCreativeId:run.selectedCreativeId??script.selectedCreativeId,
        scriptRef:ref("ScriptDraft",script),productionPlanRef:ref("ProductionPlan",plan),clipHash:clip.contentHash,segmentHashes:{},compilerTemplateVersion:"pvs-canvas-native-v1",
        ...(run.productionAssetSet?{productionAssetSetRef:ref("ProductionAssetSet",run.productionAssetSet)}:{}),
        promptText:g.prompt,inputAssetManifest:manifest,factMapping:[],segmentMapping:[],constraintMapping:[],
        generationParams:{durationMs:clip.durationMs,aspectRatio:g.ratio,videoResolution:g.resolution.toLowerCase(),generateAudio:q.request.nativeAudio},createdAt:now};
      const compiled=compiledPromptSchema.parse({...promptBody,compiledPromptHash:hashValue(promptBody)});
      const body={id:randomUUID(),projectId:run.projectId,clipId:clip.id,compiledPromptId:compiled.id,compiledPromptHash:compiled.compiledPromptHash,
        provider:"dreamina-canvas" as const,providerIdentityHash,capabilityFingerprint,model:g.model,promptText:g.prompt,assetManifest:manifest,
        durationMs:clip.durationMs,aspectRatio:compiled.generationParams.aspectRatio,videoResolution:compiled.generationParams.videoResolution,generateAudio:q.request.nativeAudio,
        canvasBinding:{runId:run.id,projectId:b.projectId,nodeId:n.nodeId,submitId:n.submitId,accountFingerprint:b.accountFingerprint,generationHash:n.generationHash!,
          sourceRequestHash:n.sourceRequestHash,quoteScopeHash:quote.scopeHash,canonicalModel:n.canonicalModel!},
        inputVersionRefs:[run.truthRef,compiled.creativeBatchRef,compiled.scriptRef,compiled.productionPlanRef,...(compiled.productionAssetSetRef?[compiled.productionAssetSetRef]:[])],createdAt:now};
      const request=generationRequestSchema.parse({...body,requestHash:computeGenerationRequestHash(body)});
      chain.compiledPrompts.push(compiled);chain.requests.push(request);
      const report={id:randomUUID(),projectId:run.projectId,generationRequestId:request.id,requestHash:request.requestHash,status:"PASS" as const,
        providerIdentityHash,capabilityFingerprint,clipCount:1,totalGeneratedMs:clip.durationMs,highRiskClipIds:clip.riskAssessment?.level==="HIGH"?[clip.id]:[],
        costEstimate:{status:"KNOWN" as const,estimatedCredits:q.result.credits,estimatedCostText:`Canvas最高${q.result.credits}积分`,observedAt:now,expiresAt:q.result.expiresAt},
        blockers:[],warnings:["REQUIRES_EXPLICIT_PAID_CONFIRMATION","REQUIRES_HUMAN_CLIP_REVIEW"],createdAt:now};
      chain.reports.push(preflightReportSchema.parse({...report,reportHash:hashValue(report)}));
    }
    if(quote.items.filter(i=>i.request.kind==="VIDEO").length!==clips.length)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_QUOTE_COVERAGE_CHANGED");
    if(blockers.length)for(const [index,p] of chain.reports.entries()){
      const {reportHash:_,...body}=p,blocked={...body,status:"BLOCKED" as const,blockers:[...new Set(blockers)]};
      chain.reports[index]=preflightReportSchema.parse({...blocked,reportHash:hashValue(blocked)});
    }
    return {ready:blockers.length===0,blockers:[...new Set(blockers)],chain,delivery:checked,noGenerationSubmitted:true as const};
  }
  async prepare(run:SmartGenerationRun){
    const check=await this.inspect(run);
    if(!check.ready)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_BLOCKED:"+check.blockers.join(","));
    if(!this.repo.replacePreflightChain)throw new CanvasRuntimeError("ATOMIC_PREFLIGHT_REPOSITORY_REQUIRED");
    await this.repo.replacePreflightChain(check.chain);
    const requests=check.chain.requests.map((r,index)=>{const p=check.chain.reports[index]!;return {requestId:r.id,clipId:r.clipId,requestHash:r.requestHash,
      preflightId:p.id,preflightHash:p.reportHash,costStatus:p.costEstimate.status,estimatedCredits:p.costEstimate.estimatedCredits,costText:p.costEstimate.estimatedCostText};}).sort((a,b)=>a.requestId.localeCompare(b.requestId));
    const scope={hash:"0".repeat(64),planRef:ref("ProductionPlan",run.productionPlan!),requests,preparedAt:new Date().toISOString()};
    return {...scope,hash:canvasPaidScopeHash(scope)};
  }
  async validate(run:SmartGenerationRun){
    const s=run.paidScope,b=run.canvasBinding;
    if(!s||!b||canvasPaidScopeHash(s)!==s.hash||s.planRef.hash!==run.productionPlan?.contentHash||s.requests.length!==run.productionPlan.scenes.flatMap(s=>s.clips).length||
      new Set(s.requests.map(r=>r.clipId)).size!==s.requests.length||new Set(s.requests.map(r=>r.requestId)).size!==s.requests.length)
      throw new CanvasRuntimeError("VIDEO_PAID_SCOPE_INVALID");
    const check=await this.inspect(run);if(!check.ready)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_BLOCKED:"+check.blockers.join(","));
    const current=await this.repo.listCurrentGenerationRequests(run.projectId);
    for(const bound of s.requests){
      const request=current.find(r=>r.id===bound.requestId),report=await this.repo.getPreflightReport(bound.preflightId),expected=check.chain.requests.find(r=>r.clipId===bound.clipId);
      if(!request||!report||!expected||request.provider!=="dreamina-canvas"||request.requestHash!==bound.requestHash||
        computeGenerationRequestHash((({requestHash:_,...body})=>body)(request))!==request.requestHash||hashValue(request.canvasBinding)!==hashValue(expected.canvasBinding)||
        request.promptText!==expected.promptText||request.model!==expected.model||request.providerIdentityHash!==expected.providerIdentityHash||request.durationMs!==expected.durationMs||
        request.aspectRatio!==expected.aspectRatio||request.videoResolution!==expected.videoResolution||request.generateAudio!==expected.generateAudio||
        hashValue(request.inputVersionRefs)!==hashValue(expected.inputVersionRefs)||hashValue(request.assetManifest)!==hashValue(expected.assetManifest)||request.capabilityFingerprint!==expected.capabilityFingerprint||
        report.status!=="PASS"||report.requestHash!==request.requestHash||report.reportHash!==bound.preflightHash||report.generationRequestId!==request.id||
        hashValue((({reportHash:_,...body})=>body)(report))!==report.reportHash||
        report.costEstimate.estimatedCredits!==bound.estimatedCredits||report.costEstimate.status!=="KNOWN"||!report.costEstimate.expiresAt||Date.parse(report.costEstimate.expiresAt)<=Date.now())
        throw new CanvasRuntimeError("VIDEO_REQUEST_PREFLIGHT_BINDING_CHANGED");
    }
    await this.canvas.validateBudget(run,"VIDEO");
  }
}
