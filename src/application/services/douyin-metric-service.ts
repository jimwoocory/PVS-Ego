import { randomUUID } from "node:crypto";
import type { DouyinOpsRepository } from "../ports/douyin-ops-repository.js";
import type { DouyinOpsRuntime } from "../ports/douyin-ops-runtime.js";
import {
  douyinMetricSnapshotSchema,
  douyinWorkBindingSchema,
  type DouyinMetricSnapshot,
  type DouyinWorkBinding
} from "../../domain/douyin-ops.js";
import { sha256Text } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import {assertOperationsReadAccount} from "./douyin-ops-read-scope.js";
import {metricKeys,type MetricAvailability} from "../../domain/douyin-observation.js";
import type {
  DouyinWorkBindingDecision
} from "./douyin-work-binding-service.js";

export class DouyinMetricService {
  constructor(
    private readonly repo: DouyinOpsRepository,
    private readonly runtime: DouyinOpsRuntime
  ) {}

  async persistBinding(input: {
    projectId: string;
    decision: DouyinWorkBindingDecision;
    publishedAt?: string;
    now?: string;
    opsAccountUid?:string;
  }): Promise<DouyinWorkBinding> {
    const now = input.now ?? new Date().toISOString();
    const previous = await this.repo.findWorkBindingByPackage(
      input.decision.packageId
    );

    const value = douyinWorkBindingSchema.parse({
      id: previous?.id ?? randomUUID(),
      projectId: input.projectId,
      packageId: input.decision.packageId,
      ...((input.opsAccountUid??previous?.opsAccountUid)?{opsAccountUid:input.opsAccountUid??previous!.opsAccountUid}:{}),
      ...(input.decision.receiptId
        ? { publishReceiptId: input.decision.receiptId }
        : {}),
      ...(input.decision.awemeId
        ? { awemeId: input.decision.awemeId }
        : {}),
      ...(input.decision.source
        ? { source: input.decision.source }
        : {}),
      confidence: input.decision.confidence,
      status: input.decision.status,
      ...(input.publishedAt
        ? { publishedAt: input.publishedAt }
        : previous?.publishedAt
          ? { publishedAt: previous.publishedAt }
          : {}),
      ...(input.decision.status === "BOUND"
        ? { boundAt: previous?.boundAt ?? now }
        : {}),
      ...(input.decision.externalUrl
        ? { externalUrl: input.decision.externalUrl }
        : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    });

    return this.repo.upsertWorkBinding(value);
  }

  async refresh(input: {
    projectId: string;
    packageId?: string;
    captureKey?: string;
    capturedAt?: string;
    bindingId?:string;
    awemeId?:string;
  }): Promise<DouyinMetricSnapshot> {
    const binding = input.bindingId?await this.repo.findWorkBindingById(input.bindingId):input.packageId
      ? await this.repo.findWorkBindingByPackage(input.packageId)
      : await this.repo.latestWorkBinding(input.projectId, { preferBound: true });

    if (!binding || binding.projectId !== input.projectId) {
      throw new DomainValidationError(
        "当前项目尚未建立抖音作品绑定"
      );
    }
    if (binding.status !== "BOUND" || !binding.awemeId) {
      throw new DomainValidationError(
        "抖音作品绑定尚未确认，不能刷新作品指标"
      );
    }
    if(input.awemeId&&input.awemeId!==binding.awemeId)throw new DomainValidationError("指标采集作品与指定绑定不一致");
    await assertOperationsReadAccount(this.runtime,binding);
    if(input.captureKey?.trim()){
      const prior=await this.repo.findMetricSnapshotByCaptureKey(input.projectId,input.captureKey.trim());
      if(prior){if(prior.bindingId!==binding.id||prior.awemeId!==binding.awemeId)throw new DomainValidationError("原指标采集标识属于不同绑定");return prior;}
    }

    const work = await this.runtime.getWork(binding.awemeId);
    await assertOperationsReadAccount(this.runtime,binding);
    const currentBinding=await this.repo.findWorkBindingById(binding.id);
    if(!currentBinding||currentBinding.status!=="BOUND"||currentBinding.projectId!==binding.projectId||currentBinding.awemeId!==binding.awemeId||currentBinding.opsAccountUid!==binding.opsAccountUid)throw new DomainValidationError("指标读取期间作品或账号绑定已改变，停止保存");
    if(work.author.uid!==binding.opsAccountUid)throw new DomainValidationError("作品作者 UID 与原运营账号不一致");
    if (work.awemeId !== binding.awemeId) {
      throw new DomainValidationError(
        "抖音运行时返回的作品 ID 与 PVS 绑定不一致"
      );
    }

    const capturedAt =
      input.capturedAt ?? new Date().toISOString();
    const captureKey =
      input.captureKey?.trim() ||
      "manual:" + randomUUID();

    const metricAvailability:MetricAvailability={},metrics:typeof work.metrics={};
    for(const key of metricKeys){const state=work.metricAvailability?.[key]??(work.metrics[key]===undefined?"NOT_PROVIDED":"OBSERVED");metricAvailability[key]=state;if(state==="OBSERVED"){if(work.metrics[key]===undefined)throw new DomainValidationError("指标声明已观察但缺少数值");metrics[key]=work.metrics[key];}}
    const normalized = {
      awemeId: work.awemeId,
      description: work.description,
      publishedAt: work.publishedAt,
      metrics,metricAvailability,opsAccountUid:binding.opsAccountUid,authorUid:work.author.uid,
      durationMs: work.durationMs,
      externalUrl: work.externalUrl
    };
    const rawJson = JSON.stringify(normalized);
    const now = new Date().toISOString();

    const snapshot = douyinMetricSnapshotSchema.parse({
      id: randomUUID(),
      projectId: input.projectId,
      bindingId: binding.id,
      awemeId: binding.awemeId,
      captureKey,
      capturedAt,
      plays: metrics.plays,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      metricAvailability,
      ...(metrics.collects !== undefined
        ? { collects: metrics.collects }
        : {}),
      ...(work.durationMs !== undefined
        ? { durationMs: work.durationMs }
        : {}),
      rawJson,
      contentHash: sha256Text(rawJson),
      createdAt: now
    });

    return this.repo.createMetricSnapshot(snapshot);
  }

  async history(input: {
    projectId: string;
    awemeId?: string;
    limit?: number;
  }): Promise<DouyinMetricSnapshot[]> {
    return this.repo.listMetricSnapshots(input);
  }
}
