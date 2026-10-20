import {assertEvidenceScope,assertNoUnsupportedEffect} from "../../domain/douyin-feedback-validation.js";
import {type FeedbackContext} from "../../domain/douyin-feedback-evidence.js";
import type {DouyinInsight} from "../../domain/douyin-ops.js";
import type {ProductFlowService} from "./product-flow.js";
import { randomUUID } from "node:crypto";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import {
  douyinCreativeFeedbackSchema,
  type DouyinCreativeFeedback
} from "../../domain/douyin-ops.js";
import { sha256Text } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";

export type DouyinCreativeFeedbackContextItem = {
  feedbackId: string;
  insightId: string;
  text: string;
  evidenceRefs: string[];
};

export class DouyinCreativeFeedbackService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly productFlow?:Pick<ProductFlowService,"getWorkspace">
  ) {}

  private async validateInsight(insight:DouyinInsight){
    const evidence=insight.observationEvidence;
    if(!evidence)throw new DomainValidationError("历史复盘缺少冻结的观察时间窗和覆盖证据，保留原记录；核对并生成新复盘后方可使用");
    assertEvidenceScope(evidence,insight);
    const binding=await this.repo.findWorkBindingById(insight.bindingId);
    if(!binding||binding.projectId!==insight.projectId||binding.status!=="BOUND"||binding.awemeId!==insight.awemeId||binding.opsAccountUid!==evidence.opsAccountUid)throw new DomainValidationError("原复盘作品或账号绑定已变化");
    if(this.productFlow){const workspace=await this.productFlow.getWorkspace(insight.projectId);if(workspace?.productTruth?.status!=="CONFIRMED"||workspace.productTruth.contentHash!==insight.productTruthHash||workspace.project.currentProductTruthRef?.hash!==insight.productTruthHash)throw new DomainValidationError("复盘所依据的产品事实已变化，请先重新核对");}
    return evidence;
  }
  private validateAction(insight:DouyinInsight,index:number){
    const action=insight.nextCreativeActions[index],evidence=insight.observationEvidence!;
    const refs=new Set([...evidence.metrics,...evidence.comments].map(item=>item.evidenceRef));
    if(!action||action.claimType!=="METHOD_HYPOTHESIS"||!action.evidenceRefs.length||action.evidenceRefs.some(ref=>!refs.has(ref)))throw new DomainValidationError("建议必须为带原观察证据的方法假设，不能成为产品事实或商业效果");
    assertNoUnsupportedEffect(action.text);return action;
  }

  async promote(input: {
    projectId: string;
    insightId: string;
    actionIndex: number;
    confirmed: boolean;
    confirmedAt?: string;
  }): Promise<DouyinCreativeFeedback> {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "需要明确确认后才能把复盘建议加入下一轮创意"
      );
    }
    if (
      !Number.isInteger(input.actionIndex) ||
      input.actionIndex < 0
    ) {
      throw new DomainValidationError(
        "复盘建议序号无效"
      );
    }

    const insight =
      await this.repo.findInsightById(
        input.insightId
      );
    if (
      !insight ||
      insight.projectId !== input.projectId
    ) {
      throw new DomainValidationError(
        "复盘记录不存在或不属于当前项目"
      );
    }

    await this.validateInsight(insight);
    const action=this.validateAction(insight,input.actionIndex);
    if (!action) {
      throw new DomainValidationError(
        "所选复盘建议不存在"
      );
    }
    if (!action.evidenceRefs.length) {
      throw new DomainValidationError(
        "没有证据引用的复盘建议不能进入下一轮创意"
      );
    }

    const now =
      input.confirmedAt ?? new Date().toISOString();
    const actionHash = sha256Text(
      JSON.stringify({
        text: action.text,
        evidenceRefs: action.evidenceRefs
      })
    );

    return this.repo.upsertCreativeFeedback(
      douyinCreativeFeedbackSchema.parse({
        id: randomUUID(),
        projectId: input.projectId,
        insightId: insight.id,
        actionIndex: input.actionIndex,
        actionHash,
        actionText: action.text,
        evidenceRefs: action.evidenceRefs,
        active: true,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now
      })
    );
  }

  async deactivate(input: {
    projectId: string;
    feedbackId: string;
    confirmed: boolean;
    deactivatedAt?: string;
  }): Promise<DouyinCreativeFeedback> {
    if (input.confirmed !== true) {
      throw new DomainValidationError(
        "需要明确确认后才能停用创意反馈"
      );
    }
    const existing =
      await this.repo.findCreativeFeedbackById(
        input.feedbackId
      );
    if (
      !existing ||
      existing.projectId !== input.projectId
    ) {
      throw new DomainValidationError(
        "创意反馈不存在或不属于当前项目"
      );
    }
    if (!existing.active) {
      return existing;
    }

    const updated =
      await this.repo.deactivateCreativeFeedback({
        feedbackId: existing.id,
        projectId: input.projectId,
        deactivatedAt:
          input.deactivatedAt ??
          new Date().toISOString()
      });
    if (!updated) {
      throw new DomainValidationError(
        "创意反馈状态已变化，请刷新后重试"
      );
    }
    return updated;
  }

  active(
    projectId: string
  ): Promise<DouyinCreativeFeedback[]> {
    return this.repo.listCreativeFeedback({
      projectId,
      active: true
    });
  }

  async context(
    projectId: string
  ): Promise<FeedbackContext[]> {
    const active = await this.active(projectId);
    const result:FeedbackContext[]=[];
    for(const item of active.slice(-20)){
      if(item.projectId!==projectId)throw new DomainValidationError("创意反馈不属于当前项目");
      const insight=await this.repo.findInsightById(item.insightId);
      if(!insight||insight.projectId!==projectId)throw new DomainValidationError("原复盘缺失或不属于当前项目");
      const observation=await this.validateInsight(insight),action=this.validateAction(insight,item.actionIndex);
      const hash=sha256Text(JSON.stringify({text:action.text,evidenceRefs:action.evidenceRefs}));
      if(item.actionHash!==hash||item.actionText!==action.text||JSON.stringify(item.evidenceRefs)!==JSON.stringify(action.evidenceRefs))throw new DomainValidationError("已采用反馈与原建议的正文或证据已变化");
      result.push({feedbackId:item.id,insightId:item.insightId,text:item.actionText,evidenceRefs:item.evidenceRefs,actionHash:item.actionHash,confirmedAt:item.confirmedAt,evidenceHash:insight.evidenceHash,observation});
    }
    return result;
  }
}
