import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {hashValue,sha256Bytes} from "../../domain/hashing.js";
import {canvasShortPlanSchema,type CanvasShortPlan} from "../../domain/canvas-short-plan.js";
import {scriptDraftSchema,productionPlanSchema,reviewDecisionSchema} from "../../domain/schemas.js";
import type {SmartGenerationRun} from "../../domain/smart-generation.js";
import type {ArtifactRepository} from "../ports/artifact-repository.js";
import type {GenerationRepository} from "../ports/generation-repository.js";
import type {WorkflowRepository} from "../ports/workflow-repository.js";
import type {ReviewRepository} from "../ports/review-repository.js";
import type {CanvasVideoDownload} from "../ports/canvas-video-download.js";
import {CanvasProductionService} from "./canvas-production-service.js";
import {CanvasVideoPreflightService,canvasPaidScopeHash} from "./canvas-video-preflight.js";
import {CanvasVideoResultService} from "./canvas-video-result-service.js";
import {ApprovalService} from "./approval-service.js";
import {DreaminaCanvasRuntime,CanvasRuntimeError} from "../../adapters/video/dreamina-canvas-runtime.js";
import {buildProductionQuoteRequest} from "./production-quote-service.js";
import {CanvasShortDeliveryService} from "./canvas-short-delivery.js";
import {buildRealisticShortRevision} from "./canvas-short-visual-revision.js";
import {canvasShortVisualRevisionSchema} from "../../domain/canvas-short-visual-revision.js";
import {quoteShortReferences} from "./canvas-short-reference-quote.js";
import {generateZeroShortReference,syncShortReference} from "./canvas-short-reference-image.js";
import {adoptShortReference,quoteShortBoundVideo,inspectShortBoundReferences} from "./canvas-short-bound-video-quote.js";
import {buildRealisticExecution,realisticExecutionContext} from "./canvas-short-realistic-execution.js";

const seal=<T extends {contentHash?:string}>(input:T)=>{const {contentHash:_,...body}=input;return {...body,contentHash:hashValue(body)};};
const ref=(entityType:string,value:{id:string;version:number;contentHash:string})=>({entityType,entityId:value.id,version:value.version,hash:value.contentHash});
type Save=(p:CanvasShortPlan)=>Promise<void>;
export class CanvasShortProductionService {
  constructor(private readonly originalCanvas:CanvasProductionService,private readonly download:CanvasVideoDownload,
    private readonly artifacts:ArtifactRepository,private readonly generation:GenerationRepository,private readonly workflow:WorkflowRepository,
    private readonly reviews:ReviewRepository,private readonly projectsRoot:string,private readonly canvasFactory?:()=>CanvasProductionService){}
  private canvas(){return this.canvasFactory?.()??new CanvasProductionService(new DreaminaCanvasRuntime({...this.originalCanvas.runtime.config,videoModel:"seedance_2.0_fast_vip"}));}
  private state(p:CanvasShortPlan){return p.visualRevisions?.length?p.realisticExecution??p:p;}
  private deliveryPlan(p:CanvasShortPlan):CanvasShortPlan{return p.realisticExecution?{...p,payload:p.realisticExecution.payload,contentHash:p.realisticExecution.contentHash,binding:p.realisticExecution.binding,feeQuote:p.realisticExecution.feeQuote,paidScope:p.realisticExecution.paidScope}:p;}
  async quoteReferences(parent:SmartGenerationRun,p:CanvasShortPlan,revisionHash:string,imagePrompt:string,save:Save){
    const head=p.visualRevisions?.at(-1);if(!head)throw new CanvasRuntimeError("SHORT_VISUAL_REVISION_REQUIRED");
    await this.file(parent.projectId,head.payload.productReference.artifactId,head.payload.productReference.sha256);
    return quoteShortReferences(this.canvas(),parent,p,revisionHash,imagePrompt,save);
  }
  async generateZeroReference(parent:SmartGenerationRun,p:CanvasShortPlan,revisionHash:string,requestHash:string,confirmed:boolean,save:Save){
    const head=p.visualRevisions?.at(-1);if(!head)throw new CanvasRuntimeError("SHORT_VISUAL_REVISION_REQUIRED");
    await this.file(parent.projectId,head.payload.productReference.artifactId,head.payload.productReference.sha256);
    return generateZeroShortReference(this.canvas(),parent,p,revisionHash,requestHash,confirmed,save);
  }
  async syncReference(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    return syncShortReference(this.canvas(),parent,p,this.artifacts,this.projectsRoot,save);
  }
  private async checkReferenceFiles(parent:SmartGenerationRun,p:CanvasShortPlan){
    const head=p.visualRevisions?.at(-1),image=p.referenceImage;
    if(!head||!image?.artifact)throw new CanvasRuntimeError("SHORT_REFERENCE_IMAGE_ARTIFACT_REQUIRED");
    await this.file(parent.projectId,head.payload.productReference.artifactId,head.payload.productReference.sha256);
    await this.file(parent.projectId,image.artifact.id,image.artifact.sha256);
  }
  async adoptReference(parent:SmartGenerationRun,p:CanvasShortPlan,revisionHash:string,artifactId:string,sha256:string,confirmed:boolean,save:Save){
    await this.checkReferenceFiles(parent,p);return adoptShortReference(this.canvas(),parent,p,revisionHash,artifactId,sha256,confirmed,save);
  }
  async quoteBoundVideo(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    await this.checkReferenceFiles(parent,p);return quoteShortBoundVideo(this.canvas(),parent,p,save);
  }
  private generationTarget(template:NonNullable<SmartGenerationRun["productionPlan"]>["generationTarget"],model:any,now:string){
    const mode=model.modes?.find((m:any)=>m.name==="m2v"),duration=mode?.flags?.find((f:any)=>f.flag==="--duration");
    if(!template||!mode||!duration)throw new CanvasRuntimeError("SHORT_VIDEO_MODEL_SPEC_MISSING");
    return {...template,requestedModelVersion:"seedance_2.0_fast_vip",registryFingerprint:hashValue(model),capabilityCheckedAt:now,
      operationConstraints:[{...template.operationConstraints[0]!,operation:"multimodal2video" as const,operationLabel:"Canvas多模态视频",modelMode:"EXPLICIT" as const,
        modelVersion:"seedance_2.0_fast_vip",durationMinSeconds:duration.min,durationMaxSeconds:duration.max,
        maxImages:mode.references?.types?.find((r:any)=>r.mediaType==="image")?.max,maxVideos:mode.references?.types?.find((r:any)=>r.mediaType==="video")?.max,
        maxAudio:mode.references?.types?.find((r:any)=>r.mediaType==="audio")?.max,maxTotalInputs:mode.references?.max,
        supportedResolutions:mode.flags.find((f:any)=>f.flag==="--resolution")?.values??["720p"]}]};
  }
  private async file(projectId:string,id:string,sha?:string){
    const a=await this.artifacts.findById(id),root=path.resolve(this.projectsRoot,projectId),file=a?path.resolve(root,a.relativePath):"";
    if(!a||a.projectId!==projectId||a.integrityStatus!=="READY"||sha&&sha!==a.sha256||!file.startsWith(root+path.sep)||sha256Bytes(await fs.readFile(file))!==a.sha256)
      throw new CanvasRuntimeError("SHORT_REFERENCE_OR_OUTPUT_CHANGED");return a;
  }
  async createDraft(run:SmartGenerationRun,previewId:string,rejectedPlanId?:string){
    const previous=run.canvasShortPlans?.find(p=>p.payload.previewId===previewId);
    if(rejectedPlanId){const rejected=run.canvasShortPlans?.find(p=>p.id===rejectedPlanId);
      if(!rejected||rejected.payload.previewId!==previewId||rejected.status!=="BLOCKED"||rejected.blocker!=="SHORT_CLIP_REDO_REQUESTED")throw new CanvasRuntimeError("SHORT_REDO_REQUIRES_REJECTED_ORIGINAL_PLAN");
    }else if(previous){
      if(previous.payload.productionPlan.generationTarget?.operationConstraints.some(c=>c.modelVersion!==previous.payload.model)){
        if(previous.planReview||previous.consent||previous.attemptIds.length)throw new CanvasRuntimeError("SHORT_REVIEWED_MODEL_METADATA_CHANGED");
        const model=await this.canvas().runtime.findModel("seedance_2.0_fast_vip","video");
        previous.payload.productionPlan=productionPlanSchema.parse(seal({...previous.payload.productionPlan,
          generationTarget:this.generationTarget(previous.payload.productionPlan.generationTarget,model,new Date().toISOString())}));
        previous.contentHash=hashValue(previous.payload);previous.feeQuote=undefined;previous.paidScope=undefined;previous.binding=undefined;
      }
      return previous;
    }
    const preview=run.canvasShortPreviews?.find(p=>p.id===previewId),candidate=preview?.candidates.find(c=>c.key==="seedance_2.0_fast_vip-12000");
    if(!preview||!candidate?.saved||!candidate.generationHash||!run.script||!run.productionPlan||!run.canvasBinding||
      preview.sourceScriptHash!==run.script.contentHash||preview.sourcePlanHash!==run.productionPlan.contentHash)throw new CanvasRuntimeError("SHORT_SELECTED_PREVIEW_CHANGED");
    const references=[];
    for(const key of ["PRODUCT","DAUGHTER","FATHER","LIVING_ROOM"]){const entry=run.productionAssetSet?.entries.find(e=>e.key===key),id=entry?.artifactIds[0];
      if(!id)throw new CanvasRuntimeError("SHORT_REFERENCE_MISSING");const a=await this.file(run.projectId,id);references.push({key,artifactId:id,sha256:a.sha256!});}
    const model=await this.canvas().runtime.findModel("seedance_2.0_fast_vip","video"),now=new Date().toISOString();
    const id=randomUUID(),sceneId=randomUUID(),clipId=randomUUID(),template=run.productionPlan.scenes[0]!.clips[0]!,segment=template.segments[0]!;
    const descriptions=["女儿把完整枕头放上桌，父亲没有接，反问后女儿一愣。","女儿收回催促的手，介绍瑶药护颈枕，父亲从她转向产品。","父亲主动把枕头移向自己，索取资料，女儿笑着点头。","原产品图与品牌、产品名、了解入口的3秒本地尾卡。"];
    const dialogue=["父亲：又替我选？","女儿：这回先看，瑶药护颈枕。","父亲：资料给我，我来选。",""];
    const durations=[3000,5000,4000,3000],beatIds=durations.map(()=>randomUUID());
    const script=scriptDraftSchema.parse(seal({...run.script,id:randomUUID(),version:1,status:"DRAFT",confirmedAt:undefined,aiExecution:undefined,
      targetDurationMs:15000,productionAssetSetRef:undefined,beats:descriptions.map((text,index)=>({id:beatIds[index]!,order:index+1,purpose:(["HOOK","PRODUCT","RESULT","CTA"] as const)[index]!,
        text:text+(dialogue[index]?" "+dialogue[index]:""),estimatedDurationMs:durations[index]!,requiredFactIds:index===1||index===3?run.script!.beats.find(b=>b.purpose==="PRODUCT")?.requiredFactIds??[]:[]}))}));
    const states=descriptions.slice(0,4).map(description=>{const body={description,productState:template.openingState.productState,environmentState:"同一客厅、父女各一人、同一完整产品"};return {...body,stateHash:hashValue(body)};});
    const segments=[0,1,2].map(index=>({...segment,id:randomUUID(),order:index+1,startMs:[0,3000,8000][index]!,endMs:[3000,8000,12000][index]!,
      subjectAction:descriptions[index]!,dialogueOrNarration:{kind:"DIALOGUE" as const,text:dialogue[index]!,estimatedDurationMs:durations[index]!,estimatorVersion:"15s-draft-requires-native-speech-review"},
      postProductionText:[],sourceBeatIds:[beatIds[index]!],requiredFactIds:script.beats[index]!.requiredFactIds,continuityIn:states[index]!,continuityOut:states[index+1]!}));
    const clip=seal({...template,id:clipId,sceneId,order:1,durationMs:12000,purpose:"礼物遭拒—交还选择权—主动索取资料的12秒漫剧",sourceBeatIds:beatIds.slice(0,3),
      openingState:states[0]!,closingState:states[3]!,segments,aggregateStatus:"PLANNED" as const});
    const plan=productionPlanSchema.parse(seal({...run.productionPlan,id:randomUUID(),version:1,status:"DRAFT",confirmedAt:undefined,aiExecution:undefined,
      productionAssetSetRef:undefined,scriptRef:ref("ScriptDraft",script),generationTarget:this.generationTarget(run.productionPlan.generationTarget,model,now),
      scenes:[{...run.productionPlan.scenes[0]!,id:sceneId,sourceBeatIds:beatIds.slice(0,3),clips:[clip]}]}));
    const payload={previewId,candidateKey:"seedance_2.0_fast_vip-12000",sourceScriptHash:run.script.contentHash,sourcePlanHash:run.productionPlan.contentHash,title:preview.title,
      model:"seedance_2.0_fast_vip",creditCeiling:72,generatedDurationMs:12000,localTailMs:3000,outputDurationMs:15000,nodeId:candidate.nodeId,submitId:randomUUID(),generationHash:candidate.generationHash,
      prompt:candidate.prompt,script,productionPlan:plan,tailCardText:preview.tailCardText,references};
    return canvasShortPlanSchema.parse({id,parentRunId:run.id,projectId:run.projectId,payload,contentHash:hashValue(payload),status:"DRAFT",attemptIds:[],createdAt:now,updatedAt:now});
  }
  async reviseStyle(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    if(p.parentRunId!==parent.id||p.projectId!==parent.projectId||p.contentHash!==hashValue(p.payload)||
      p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash)
      throw new CanvasRuntimeError("SHORT_PLAN_SOURCE_CHANGED");
    if(p.consent||p.attemptIds.length||p.paidScope)throw new CanvasRuntimeError("SHORT_STYLE_REVISION_REQUIRES_UNAUTHORIZED_PLAN");
    for(const r of p.payload.references)await this.file(parent.projectId,r.artifactId,r.sha256);
    if(p.visualRevisions?.length){const current=p.visualRevisions.at(-1)!;
      if(current.contentHash!==hashValue(current.payload)||current.payload.sourcePlanHash!==p.contentHash)throw new CanvasRuntimeError("SHORT_VISUAL_REVISION_CHANGED");return p;}
    p.visualRevisions=[buildRealisticShortRevision(p)];p.status="BLOCKED";p.blocker="仿真人修订稿待审核；新人物和场景图尚未生成与绑定，禁止沿用旧二维图和报价";
    await save(p);return p;
  }
  private async context(parent:SmartGenerationRun,p:CanvasShortPlan){
    if(p.visualRevisions?.length){if(!p.realisticExecution)throw new CanvasRuntimeError("SHORT_REALISTIC_REFERENCE_BINDING_REQUIRED");await this.checkReferenceFiles(parent,p);return realisticExecutionContext(this.canvas(),parent,p);}
    if(p.parentRunId!==parent.id||p.projectId!==parent.projectId||p.contentHash!==hashValue(p.payload)||p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash)
      throw new CanvasRuntimeError("SHORT_PLAN_SOURCE_CHANGED");
    for(const r of p.payload.references){const e=parent.productionAssetSet?.entries.find(e=>e.key===r.key);if(!e?.artifactIds.includes(r.artifactId))throw new CanvasRuntimeError("SHORT_PLAN_REFERENCE_SELECTION_CHANGED");await this.file(parent.projectId,r.artifactId,r.sha256);}
    if(p.planReview&&p.planReview.contentHash!==p.contentHash)throw new CanvasRuntimeError("SHORT_PLAN_REVIEW_CHANGED");
    const status=p.planReview?"CONFIRMED":"DRAFT",confirmedAt=p.planReview?.confirmedAt;
    const script=scriptDraftSchema.parse(seal({...p.payload.script,status,confirmedAt}));
    const plan=productionPlanSchema.parse(seal({...p.payload.productionPlan,status,confirmedAt,scriptRef:ref("ScriptDraft",script)}));
    const shadow={...parent,id:p.id,script,productionPlan:plan,targetDurationMs:15000,canvasBinding:undefined,paidScope:undefined,consent:p.consent,attemptIds:p.attemptIds,feeQuote:p.feeQuote,
      status:p.consent?"GENERATING":"READY_FOR_PAID_CONFIRM",canvasShortPlans:undefined} as SmartGenerationRun;
    const request=buildProductionQuoteRequest(shadow),original=parent.canvasBinding!;
    if(p.binding&&p.consent&&p.binding.scopeHash!==request.scopeHash)throw new CanvasRuntimeError("SHORT_AUTHORIZED_SCOPE_CHANGED");
    const binding=p.binding?.scopeHash===request.scopeHash?p.binding:{...original,runId:p.id,scopeHash:request.scopeHash,sourceScriptHash:script.contentHash,sourcePlanHash:plan.contentHash,
      originalQuoteRequest:request,imageBudgetGrant:undefined,imageQuote:undefined,quoteObservation:undefined,
      nodes:[...original.nodes.filter(n=>p.payload.references.some(r=>r.key===n.key)).map(n=>structuredClone(n)),{key:plan.scenes[0]!.clips[0]!.id,kind:"VIDEO" as const,
        nodeId:p.payload.nodeId,updateId:randomUUID(),submitId:p.payload.submitId,sourceRequestHash:request.items.find(i=>i.kind==="VIDEO")!.sourceRequestHash,
        canonicalModel:p.payload.model,generationHash:p.payload.generationHash,saved:true}]};
    shadow.canvasBinding=binding;shadow.paidScope=p.paidScope;p.binding=binding;
    return shadow;
  }
  async editVisualDraft(parent:SmartGenerationRun,p:CanvasShortPlan,expectedHeadHash:string,raw:unknown,save:Save){
    if(p.consent||p.paidScope||p.attemptIds.length||p.parentRunId!==parent.id||p.projectId!==parent.projectId||p.contentHash!==hashValue(p.payload)||
      p.payload.sourceScriptHash!==parent.script?.contentHash||p.payload.sourcePlanHash!==parent.productionPlan?.contentHash)
      throw new CanvasRuntimeError("SHORT_VISUAL_EDIT_SOURCE_OR_PERMISSION_CHANGED");
    const body=canvasShortVisualRevisionSchema.shape.payload.parse(raw),head=p.visualRevisions?.at(-1),contentHash=hashValue(body);
    if(p.visualRevisions?.some(r=>r.contentHash===contentHash))return p;
    if(!head||head.contentHash!==expectedHeadHash||head.contentHash!==hashValue(head.payload)||body.replacesRevisionId!==head.id||
      body.sourcePlanId!==p.id||body.sourcePlanHash!==p.contentHash||JSON.stringify(body.styleReference)!==JSON.stringify(head.payload.styleReference)||
      JSON.stringify(body.productReference)!==JSON.stringify(head.payload.productReference)||JSON.stringify(body.excludedReferenceArtifactIds)!==JSON.stringify(head.payload.excludedReferenceArtifactIds))
      throw new CanvasRuntimeError("SHORT_VISUAL_EDIT_HEAD_CHANGED");
    const script=body.script,plan=body.productionPlan,clips=plan.scenes.flatMap(s=>s.clips);
    const actualHash=(value:{contentHash:string})=>{const {contentHash:_,...data}=value;return hashValue(data);};
    if(script.projectId!==parent.projectId||plan.projectId!==parent.projectId||script.status!=="DRAFT"||plan.status!=="DRAFT"||script.targetDurationMs!==15000||script.confirmedAt||plan.confirmedAt||
      script.contentHash!==actualHash(script)||plan.contentHash!==actualHash(plan)||plan.scriptRef.entityId!==script.id||plan.scriptRef.hash!==script.contentHash||
      plan.generationTarget?.requestedModelVersion!==p.payload.model||clips.length!==1||clips[0]!.durationMs!==12000||
      clips[0]!.referenceAssets.some(a=>a.role!=="PRIMARY_PRODUCT")||new Set(body.designs.map(d=>d.key)).size!==3)
      throw new CanvasRuntimeError("SHORT_VISUAL_EDIT_DRAFT_CONTRACT_INVALID");
    await this.file(parent.projectId,body.productReference.artifactId,body.productReference.sha256);
    if((p.visualRevisions?.length??0)>=20)throw new CanvasRuntimeError("SHORT_VISUAL_REVISION_LIMIT");
    const revision=canvasShortVisualRevisionSchema.parse({id:randomUUID(),contentHash,createdAt:new Date().toISOString(),status:"DRAFT",payload:body});
    p.visualRevisions=[...(p.visualRevisions??[]),revision];p.status="BLOCKED";p.blocker="新创意候选稿待审核；没有继承上版内容确认、参考绑定或费用许可";
    await save(p);return p;
  }
  async reviewVisualDesign(parent:SmartGenerationRun,p:CanvasShortPlan,revisionId:string,expectedHash:string,confirmed:boolean,save:Save){
    const revision=p.visualRevisions?.at(-1);
    if(!confirmed||!revision||revision.id!==revisionId||revision.contentHash!==expectedHash||revision.contentHash!==hashValue(revision.payload)||
      revision.payload.sourcePlanHash!==p.contentHash||p.parentRunId!==parent.id||p.projectId!==parent.projectId||p.consent||p.attemptIds.length)
      throw new CanvasRuntimeError("SHORT_VISUAL_EXPLICIT_REVIEW_REQUIRED");
    if(!revision.designReview){revision.designReview={contentHash:expectedHash,confirmedAt:new Date().toISOString(),scope:"TEXT_DESIGN_ONLY"};
      revision.status="DESIGN_CONFIRMED";p.blocker="仿真人文字设定已确认；新参考图尚未生成和审核，生成费用与发布仍未授权";await save(p);}
    return p;
  }
  private preflight(canvas:CanvasProductionService){return new CanvasVideoPreflightService(canvas,this.generation,this.artifacts,this.projectsRoot,async()=>{
    const account=await canvas.runtime.assertAccount();return this.download.readiness(account.accountFingerprint);});}
  async inspect(parent:SmartGenerationRun,p:CanvasShortPlan){
    if(p.visualRevisions?.length){const revision=p.visualRevisions.at(-1)!;
      if(p.parentRunId!==parent.id||p.projectId!==parent.projectId||p.contentHash!==hashValue(p.payload)||revision.contentHash!==hashValue(revision.payload)||revision.payload.sourcePlanHash!==p.contentHash)
        throw new CanvasRuntimeError("SHORT_VISUAL_REVISION_CHANGED");
      await this.file(parent.projectId,revision.payload.productReference.artifactId,revision.payload.productReference.sha256);
      const image=p.referenceImage?.revisionHash===revision.contentHash?p.referenceImage:undefined;
      if(image?.artifact)await this.file(parent.projectId,image.artifact.id,image.artifact.sha256);
      if(p.realisticExecution){const execution=p.realisticExecution,blockers:string[]=[];
        try{const run=await this.context(parent,p);await this.preflight(this.canvas()).validate(run);}catch(error){blockers.push(error instanceof CanvasRuntimeError?error.code:error instanceof Error?error.message:"PREFLIGHT_INCOMPLETE");}
        return {planId:p.id,contentHash:revision.contentHash,status:blockers.length?"PREFLIGHT_BLOCKED":"REQUEST_READY",revision,creditCeiling:72,generatedDurationMs:12000,localTailMs:3000,
          blockers,referenceImage:image,boundVideoQuote:p.boundVideoQuotes?.at(-1),execution,paidScope:execution.paidScope,feeQuote:execution.feeQuote,hasPaidConsent:Boolean(p.consent),
          attemptIds:p.attemptIds,noGenerationSubmitted:false,noVideoGenerationSubmitted:!p.attemptIds.length,requiresExplicitVideoConfirmation:true};}
      const boundVideoQuote=p.boundVideoQuotes?.at(-1)?.revisionHash===revision.contentHash?p.boundVideoQuotes.at(-1):undefined;
      return {planId:p.id,contentHash:revision.contentHash,status:boundVideoQuote?.status==="QUOTED"?"BOUND_VIDEO_QUOTED":image?.review?"REFERENCE_ADOPTED":image?.artifact?"REFERENCE_IMAGE_REVIEW":revision.designReview?"REFERENCE_PREPARATION":"VISUAL_REVISION_DRAFT",revision,creditCeiling:72,generatedDurationMs:12000,localTailMs:3000,
        blockers:[...(!revision.designReview?["REALISTIC_DESIGN_REVIEW_REQUIRED"]:[]),...(!image?.review?[image?.artifact?"REALISTIC_REFERENCE_IMAGE_REVIEW_REQUIRED":"REALISTIC_REFERENCE_IMAGES_NOT_CREATED"]:[]),
          ...(boundVideoQuote?["REALISTIC_EXECUTION_REQUEST_PREPARATION_REQUIRED",boundVideoQuote.status==="QUOTED"?"SHORT_QUOTE_REVALIDATION_REQUIRED":boundVideoQuote.status==="OVER_BUDGET"?"SHORT_72_CREDIT_CEILING_EXCEEDED":"SHORT_QUOTE_REFRESH_REQUIRED"]:["REALISTIC_NODE_BINDING_REQUIRED","SHORT_QUOTE_REFRESH_REQUIRED"])],
        referenceQuote:p.referenceQuote?.revisionHash===revision.contentHash?p.referenceQuote:undefined,
        referenceImage:image,hasReferenceImageConsent:Boolean(image),boundVideoQuote,
        feeQuote:undefined,hasPaidConsent:false,attemptIds:p.attemptIds,noGenerationSubmitted:!image&&!p.attemptIds.length,
        reviewChecklist:revision.payload.reviewChecklist};
    }
    const run=await this.context(parent,p),blockers=[];
    if(!p.planReview)blockers.push("SHORT_PLAN_REVIEW_REQUIRED");
    for(const r of p.payload.references){const e=parent.productionAssetSet!.entries.find(e=>e.key===r.key)!;if(e.status!=="READY")blockers.push("ASSET_REVIEW_REQUIRED:"+r.key);}
    const account=await this.canvas().runtime.assertAccount(),delivery=await this.download.readiness(account.accountFingerprint);if(!delivery.ready)blockers.push(delivery.code??"VIDEO_DOWNLOAD_UNAVAILABLE");
    if(!p.feeQuote?.expiresAt||Date.parse(p.feeQuote.expiresAt)<=Date.now())blockers.push("SHORT_QUOTE_REFRESH_REQUIRED");
    return {planId:p.id,contentHash:p.contentHash,status:p.status,blockers,delivery,creditCeiling:72,model:p.payload.model,generatedDurationMs:12000,localTailMs:3000,
      feeQuote:p.feeQuote,hasPaidConsent:Boolean(p.consent),attemptIds:p.attemptIds,clipReview:p.clipReview,final:p.final,noGenerationSubmitted:!p.attemptIds.length,
      reviewChecklist:["父女各一人且外观连续","开场拒收、交还选择权和结尾索取资料清楚","对白、说话人及口型对应","产品与原图一致，没有虚构功效","尾卡文字清楚，最终15秒可播放"]};}
  async reviewPlan(parent:SmartGenerationRun,p:CanvasShortPlan,expectedHash:string,confirmed:boolean,save:Save){
    if(!confirmed||expectedHash!==p.contentHash||p.consent||p.attemptIds.length)throw new CanvasRuntimeError("SHORT_PLAN_EXPLICIT_REVIEW_REQUIRED");
    await this.context(parent,p);p.planReview={contentHash:p.contentHash,confirmedAt:new Date().toISOString()};p.status="PLAN_CONFIRMED";p.feeQuote=undefined;p.paidScope=undefined;p.binding=undefined;await save(p);return p;
  }
  async quote(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    if(p.consent||p.attemptIds.length)throw new CanvasRuntimeError("SHORT_ALREADY_AUTHORIZED");
    const canvas=this.canvas(),run=await this.context(parent,p);await save(p);
    const state=this.state(p);run.feeQuote=await canvas.quoteSaved(run);state.feeQuote=run.feeQuote;
    if(state.feeQuote.items.some(i=>i.result.status!=="QUOTED"||i.result.credits>72)){p.status="BLOCKED";p.blocker="SHORT_72_CREDIT_CEILING_EXCEEDED";}
    else p.blocker=undefined;await save(p);return p;
  }
  async prepare(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    if(p.visualRevisions?.length)return this.prepareRealistic(parent,p,save);
    const run=await this.context(parent,p);if(!p.planReview||p.consent||p.attemptIds.length)throw new CanvasRuntimeError("SHORT_PLAN_EXPLICIT_REVIEW_REQUIRED");
    if(!p.feeQuote?.grandTotal||p.feeQuote.grandTotal.credits>72)throw new CanvasRuntimeError("SHORT_72_CREDIT_QUOTE_REQUIRED");
    p.paidScope=await this.preflight(this.canvas()).prepare(run);p.status="REQUEST_READY";await save(p);return p;
  }
  private async prepareRealistic(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    if(!p.referenceImage?.review||p.referenceImage.state!=="ADOPTED")throw new CanvasRuntimeError("SHORT_REALISTIC_REFERENCE_BINDING_REQUIRED");
    if(p.consent||p.attemptIds.length||parent.consent||parent.attemptIds.length)throw new CanvasRuntimeError("SHORT_ALREADY_AUTHORIZED");
    await this.checkReferenceFiles(parent,p);const canvas=this.canvas();
    const quote=await quoteShortBoundVideo(canvas,parent,p,save);
    if(quote.status!=="QUOTED"||quote.totalCredits===null||quote.totalCredits>72)throw new CanvasRuntimeError("SHORT_72_CREDIT_QUOTE_REQUIRED");
    const c=await inspectShortBoundReferences(canvas,parent,p),expected=buildRealisticExecution(parent,p,c);
    if(p.realisticExecution)await this.context(parent,p);else{p.realisticExecution=expected;await save(p);}
    const execution=p.realisticExecution!,run=await this.context(parent,p),preflight=this.preflight(canvas);
    try{
      const feeQuote=await canvas.quoteSaved(run);
      if(feeQuote.status!=="QUOTED"||feeQuote.items.length!==1||feeQuote.items[0]?.result.status!=="QUOTED"||feeQuote.items[0].result.credits!==quote.videoCredits||
        !feeQuote.grandTotal||feeQuote.grandTotal.credits>72)throw new CanvasRuntimeError("SHORT_72_CREDIT_QUOTE_CHANGED");
      execution.feeQuote=feeQuote;run.feeQuote=feeQuote;await save(p);
      const check=await preflight.inspect(run);
      execution.preflight={status:check.ready?"PASS":"BLOCKED",checkedAt:new Date().toISOString(),blockers:check.blockers,delivery:check.delivery,noVideoGenerationSubmitted:true};
      await save(p);if(!check.ready)throw new CanvasRuntimeError("VIDEO_PREFLIGHT_BLOCKED:"+check.blockers.join(","));
      if(execution.paidScope){const report=await this.generation.getPreflightReport(execution.paidScope.requests[0]!.preflightId);
        if(report?.costEstimate.expiresAt&&Date.parse(report.costEstimate.expiresAt)<=Date.now()){
          if((execution.paidScopeHistory?.length??0)>=20)throw new CanvasRuntimeError("SHORT_NATIVE_SCOPE_HISTORY_LIMIT");
          execution.paidScopeHistory=[...(execution.paidScopeHistory??[]),structuredClone(execution.paidScope)];
          execution.paidScope=undefined;run.paidScope=undefined;await save(p);
        }
      }
      if(!execution.paidScope){
        // Recover an already persisted native chain after a checkpoint crash; never create a second matching request.
        const current=(await this.generation.listCurrentGenerationRequests(parent.projectId)).filter(r=>r.canvasBinding?.runId===p.id&&r.canvasBinding.nodeId===execution.payload.nodeId&&r.canvasBinding.submitId===execution.payload.submitId);
        if(current.length>1)throw new CanvasRuntimeError("SHORT_NATIVE_REQUEST_RECOVERY_AMBIGUOUS");
        if(current.length){const request=current[0]!,reports=(await this.generation.listPreflightReports(parent.projectId)).filter(r=>r.generationRequestId===request.id&&r.status==="PASS");
          if(reports.length!==1)throw new CanvasRuntimeError("SHORT_NATIVE_REQUEST_RECOVERY_REQUIRED");const report=reports[0]!;
          if(report.costEstimate.expiresAt&&Date.parse(report.costEstimate.expiresAt)<=Date.now()){
            const approvals=await this.generation.listUserApprovals(parent.projectId),attempts=await this.workflow.listGenerationAttempts(parent.projectId);
            if(approvals.some(a=>a.generationRequestId===request.id)||attempts.some(a=>a.generationRequestId===request.id))throw new CanvasRuntimeError("SHORT_EXPIRED_REQUEST_HAS_EXECUTION_HISTORY");
            // Replace only the expired, never-authorized local chain. Keep its records and fixed remote submit ID.
            execution.paidScope=await preflight.prepare(run);
          }else{
          const scope={hash:"0".repeat(64),planRef:ref("ProductionPlan",run.productionPlan!),preparedAt:new Date().toISOString(),requests:[{requestId:request.id,requestHash:request.requestHash,clipId:request.clipId,
            preflightId:report.id,preflightHash:report.reportHash,costStatus:report.costEstimate.status,estimatedCredits:report.costEstimate.estimatedCredits,costText:report.costEstimate.estimatedCostText}]};
          execution.paidScope={...scope,hash:canvasPaidScopeHash(scope)};
          }
        }else execution.paidScope=await preflight.prepare(run);
        await save(p);
      }
      run.paidScope=execution.paidScope;await preflight.validate(run);
      execution.preflight={...execution.preflight,status:"PASS",checkedAt:new Date().toISOString(),blockers:[]};
      p.status="REQUEST_READY";p.blocker=undefined;await save(p);return p;
    }catch(error){const message=error instanceof CanvasRuntimeError?error.code:error instanceof Error?error.message:"REALISTIC_PREFLIGHT_FAILED";
      execution.preflight={status:"BLOCKED",checkedAt:new Date().toISOString(),blockers:[message],delivery:execution.preflight?.delivery??{ready:false,code:"PREFLIGHT_INCOMPLETE"},noVideoGenerationSubmitted:true};
      p.status="BLOCKED";p.blocker=message;await save(p);throw error;}
  }
  async authorize(parent:SmartGenerationRun,p:CanvasShortPlan,scopeHash:string,confirmed:boolean,save:Save){
    const state=this.state(p);
    if(!confirmed||!state.paidScope||scopeHash!==state.paidScope.hash||state.paidScope.requests.some(r=>r.costStatus!=="KNOWN"||r.estimatedCredits===undefined||r.estimatedCredits>72))
      throw new CanvasRuntimeError("SHORT_EXPLICIT_72_CREDIT_PERMISSION_REQUIRED");
    if(p.consent){if(p.consent.scopeHash!==scopeHash)throw new CanvasRuntimeError("SHORT_CONSENT_CHANGED");return p;}
    const run=await this.context(parent,p);await this.preflight(this.canvas()).validate(run);
    p.consent={scopeHash,approvedAt:new Date().toISOString(),acceptedUnknownCostRisk:false,source:"EXPLICIT_SMART_RUN_PAID_CONFIRMATION"};p.status="AUTHORIZED";await save(p);return p;
  }
  async advance(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    const state=this.state(p);
    if(!p.consent||p.consent.scopeHash!==state.paidScope?.hash)throw new CanvasRuntimeError("SHORT_PAID_PERMISSION_MISSING");
    if(["CLIP_REVIEW","CLIP_ACCEPTED","FINAL_REVIEW","DELIVERED"].includes(p.status))return p;
    if(p.blocker==="SHORT_CLIP_REDO_REQUESTED")throw new CanvasRuntimeError("SHORT_REDO_REQUIRES_NEW_PLAN_AND_PERMISSION");
    const canvas=this.canvas(),run=await this.context(parent,p),preflight=this.preflight(canvas),checkpoint=async(b:NonNullable<SmartGenerationRun["canvasBinding"]>)=>{state.binding=b;run.canvasBinding=b;await save(p);};
    if(!p.attemptIds.length){await preflight.validate(run);const batch=await new ApprovalService(this.generation,this.workflow).approveCurrentRequests({projectId:parent.projectId,
      generationRequestIds:state.paidScope!.requests.map(r=>r.requestId),acceptedUnknownCostRisk:false,acceptedDuplicateSubmissionRisk:false,reuseMatchingApprovals:true});
      p.attemptIds=batch.attempts.map(a=>a.id);run.attemptIds=p.attemptIds;p.status="GENERATING";await save(p);}
    const id=p.attemptIds[0]!,attempt=await this.workflow.getGenerationAttempt(id),clipId=run.productionPlan!.scenes[0]!.clips[0]!.id;
    if(!attempt||attempt.generationRequestId!==state.paidScope!.requests[0]!.requestId||attempt.requestHash!==state.paidScope!.requests[0]!.requestHash)throw new CanvasRuntimeError("SHORT_ATTEMPT_CHANGED");
    if(attempt.status==="CREATED"){
      await preflight.validate(run);if(!this.workflow.claimCreatedAttempt||!await this.workflow.claimCreatedAttempt(id))return p;
      await this.workflow.updateGenerationAttemptStatus(id,{status:"SUBMITTING",providerHandle:{submitId:state.binding!.nodes.find(n=>n.key===clipId)!.submitId}});
      try{await canvas.submitAuthorizedNode(run,clipId,checkpoint);await this.workflow.updateGenerationAttemptStatus(id,{status:"SUBMITTED",submittedAt:new Date().toISOString()});}
      catch(error){await this.workflow.updateGenerationAttemptStatus(id,{status:"SUBMISSION_OUTCOME_UNKNOWN",errorCode:"CANVAS_RECONCILE_REQUIRED"});p.status="BLOCKED";p.blocker="原提交结果需核对，禁止重新提交";await save(p);throw error;}
    }
    const result=await new CanvasVideoResultService(canvas,this.download,this.artifacts,this.generation,this.workflow,this.projectsRoot).sync(run,clipId,checkpoint);
    p.status=result.status==="SUCCEEDED"?"CLIP_REVIEW":result.status==="FAILED"?"BLOCKED":"GENERATING";await save(p);return p;
  }
  async reviewClip(parent:SmartGenerationRun,p:CanvasShortPlan,attemptId:string,sha256:string,decision:"ACCEPT"|"REDO",confirmed:boolean,save:Save){
    if(!confirmed||!p.attemptIds.includes(attemptId))throw new CanvasRuntimeError("SHORT_CLIP_EXPLICIT_REVIEW_REQUIRED");
    const run=await this.context(parent,p),a=await this.workflow.getGenerationAttempt(attemptId),clip=run.productionPlan!.scenes[0]!.clips[0]!;
    if(!a||a.status!=="SUCCEEDED"||!a.outputArtifactId||a.generationRequestId!==this.state(p).paidScope?.requests[0]?.requestId||run.canvasBinding?.nodes.find(n=>n.kind==="VIDEO")?.delivery?.state!=="NEEDS_REVIEW")
      throw new CanvasRuntimeError("SHORT_CLIP_NOT_READY_FOR_REVIEW");
    await this.file(parent.projectId,a.outputArtifactId,sha256);
    if(decision==="ACCEPT"&&p.clipReview?.attemptId===attemptId&&p.clipReview.sha256===sha256)return p;
    const review=reviewDecisionSchema.parse({id:randomUUID(),projectId:parent.projectId,clipId:clip.id,clipHash:clip.contentHash,generationAttemptId:a.id,outputArtifactId:a.outputArtifactId,
      outputArtifactHash:sha256,decision,source:"USER",decidedAt:new Date().toISOString()});await this.reviews.createDecision(review);
    p.clipReview=decision==="ACCEPT"?{attemptId:a.id,artifactId:a.outputArtifactId,sha256,decisionId:review.id,reviewedAt:review.decidedAt}:undefined;
    p.final=undefined;p.status=decision==="ACCEPT"?"CLIP_ACCEPTED":"BLOCKED";p.blocker=decision==="REDO"?"SHORT_CLIP_REDO_REQUESTED":undefined;await save(p);return p;
  }
  async assemble(parent:SmartGenerationRun,p:CanvasShortPlan,save:Save){
    await this.context(parent,p);if(!p.clipReview||!["CLIP_ACCEPTED","FINAL_REVIEW","DELIVERED"].includes(p.status))throw new CanvasRuntimeError("SHORT_CLIP_REVIEW_REQUIRED");
    const deliveryPlan=this.deliveryPlan(p),decisions=await this.reviews.listDecisionsForClip(parent.projectId,deliveryPlan.payload.productionPlan.scenes[0]!.clips[0]!.id);
    if(!decisions.some(d=>d.id===p.clipReview!.decisionId&&d.source==="USER"&&d.decision==="ACCEPT"&&d.outputArtifactHash===p.clipReview!.sha256))throw new CanvasRuntimeError("SHORT_CLIP_REVIEW_CHANGED");
    if(p.final){await this.file(parent.projectId,p.final.artifactId,p.final.sha256);return p;}
    p.final=await new CanvasShortDeliveryService(this.artifacts,this.projectsRoot).assemble(deliveryPlan);p.status="FINAL_REVIEW";await save(p);return p;
  }
  async acceptFinal(parent:SmartGenerationRun,p:CanvasShortPlan,sha:string,confirmed:boolean,save:Save){
    await this.context(parent,p);if(!confirmed||!p.final||p.final.sha256!==sha||!["FINAL_REVIEW","DELIVERED"].includes(p.status))throw new CanvasRuntimeError("SHORT_FINAL_EXPLICIT_REVIEW_REQUIRED");
    await this.file(parent.projectId,p.final.artifactId,sha);
    const qc=await this.artifacts.findById(p.final.qcArtifactId),manifest=await this.artifacts.findById(p.final.manifestArtifactId);
    if(!qc?.sha256||!manifest?.sha256)throw new CanvasRuntimeError("SHORT_FINAL_RECEIPTS_MISSING");
    const report=JSON.parse(await fs.readFile(path.resolve(this.projectsRoot,parent.projectId,(await this.file(parent.projectId,qc.id,qc.sha256)).relativePath),"utf8"));
    const delivery=JSON.parse(await fs.readFile(path.resolve(this.projectsRoot,parent.projectId,(await this.file(parent.projectId,manifest.id,manifest.sha256)).relativePath),"utf8"));
    if(report.status!=="PASS"||report.planHash!==this.deliveryPlan(p).contentHash||report.sha256!==sha||delivery.planHash!==this.deliveryPlan(p).contentHash||delivery.sourceClip?.decisionId!==p.clipReview?.decisionId)
      throw new CanvasRuntimeError("SHORT_FINAL_QC_OR_REVIEW_CHANGED");
    p.final.acceptedAt??=new Date().toISOString();p.status="DELIVERED";await save(p);return p;
  }
}
