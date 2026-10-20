import { hashValue } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { productionQuoteSchema, quoteRequestSchema, providerQuoteSchema, type ProductionQuote, type ProviderQuote, type QuoteRequest, type QuoteItem } from "../../domain/generation-quote.js";
import { PRODUCTION_IMAGE_PROFILE, productionImageRatio } from "../../domain/production-image-spec.js";
import type { SmartGenerationRun } from "../../domain/smart-generation.js";
import type { GenerationQuoteProvider } from "../ports/generation-quote-provider.js";

export function buildProductionQuoteRequest(run: SmartGenerationRun): QuoteRequest {
  const items: QuoteItem[] = [];
  for (const asset of run.productionAssetSet?.entries ?? []) {
    if (asset.source !== "DREAMINA_GENERATED" || asset.status !== "PLANNED") continue;
    if (!asset.generationRequestHash) throw new DomainValidationError("设定图缺少生成请求绑定，不能报价");
    const images = asset.sourceReferenceAssetIds.length;
    items.push({ key: asset.key, label: asset.label, kind: "IMAGE", providerId: PRODUCTION_IMAGE_PROFILE.provider,
      model: PRODUCTION_IMAGE_PROFILE.model, operation: images ? "image2image" : "text2image",
      resolution: PRODUCTION_IMAGE_PROFILE.resolution, aspectRatio: productionImageRatio(asset.kind), count: 1,
      nativeAudio: false, references: { images, videos: 0, audio: 0 }, sourceRequestHash: asset.generationRequestHash });
  }
  const plan = run.productionPlan, target = plan?.generationTarget;
  if (plan && target) for (const clip of plan.scenes.flatMap(scene => scene.clips)) {
    items.push({ key: clip.id, label: `视频${clip.order}`, kind: "VIDEO", providerId: "domestic-jimeng-cli",
      model: target.requestedModelVersion, operation: "multimodal2video", resolution: target.videoResolution,
      aspectRatio: target.aspectRatio, count: 1, durationMs: clip.durationMs, nativeAudio: target.nativeAudioOutputRequested,
      references: { images: clip.referenceAssets.length, videos: 0, audio: 0 },
      sourceRequestHash: run.paidScope?.requests.find(r => r.clipId === clip.id)?.requestHash ?? hashValue({ planHash: plan.contentHash, clip }) });
  }
  const scopeHash = hashValue({ projectId: run.projectId, runId: run.id, scriptHash: run.script?.contentHash,
    planHash: plan?.contentHash, assetSetHash: run.productionAssetSet?.contentHash, items });
  return quoteRequestSchema.parse({ contract: "pvs-generation-quote-v1", projectId: run.projectId, runId: run.id, scopeHash, items });
}
export class ProductionQuoteService {
  constructor(private readonly provider: GenerationQuoteProvider, private readonly now = () => new Date()) {}
  async quote(request: QuoteRequest): Promise<ProductionQuote> {
    request = quoteRequestSchema.parse(request);
    if (new Set(request.items.map(i => i.key)).size !== request.items.length) throw new DomainValidationError("报价项编号重复");
    const queriedAt = this.now().toISOString();
    // Sequential requests: bounded upstream calls, no implicit retry or generation.
    const items: ProductionQuote["items"] = [];
    for (const item of request.items) {
      const requestHash = hashValue({ contract: request.contract, scopeHash: request.scopeHash, item });
      let result: ProviderQuote;
      try { result = providerQuoteSchema.parse(await this.provider.quote({ item, requestHash })); }
      catch { result = { status: "UNAVAILABLE" as const, code: "QUOTE_RESPONSE_INVALID", message: "报价服务未返回符合契约的费用，未提交生成" }; }
      if (result.status === "QUOTED" && (result.requestHash !== requestHash ||
          Date.parse(result.issuedAt) > this.now().getTime() + 30_000 || Date.parse(result.expiresAt) <= this.now().getTime() ||
          Date.parse(result.expiresAt) <= Date.parse(result.issuedAt) || Date.parse(result.expiresAt) - Date.parse(result.issuedAt) > 15 * 60_000))
        result = { status: "UNAVAILABLE", code: "QUOTE_BINDING_OR_EXPIRY_INVALID", message: "报价与本次请求不匹配或有效期无效，需要重新核价" };
      items.push({ request: item, requestHash, result });
    }
    const missingInterfaces: ProductionQuote["missingInterfaces"] = [];
    for (const item of items) { const result = item.result;
      if (result.status === "UNAVAILABLE" && !missingInterfaces.some(m => m.providerId === item.request.providerId && m.code === result.code))
        missingInterfaces.push({ providerId: item.request.providerId, code: result.code, message: result.message });
    }
    const complete = items.every(i => i.result.status === "QUOTED");
    const totals: ProductionQuote["totals"] = [];
    if (complete) for (const item of items) if (item.result.status === "QUOTED") {
      let total = totals.find(t => t.providerId === item.request.providerId);
      if (!total) { total = { providerId: item.request.providerId, currency: "CREDITS", kind: item.result.kind, credits: 0 }; totals.push(total); }
      if (item.result.kind === "CREDIT_CEILING") total.kind = "CREDIT_CEILING";
      total.credits = Math.round((total.credits + item.result.credits) * 1e6) / 1e6;
    }
    return productionQuoteSchema.parse({ ...request, items, queriedAt, status: complete ? "QUOTED" : "UNAVAILABLE", totals,
      ...(complete && new Set(items.map(i => i.result.status === "QUOTED" ? i.result.accountFingerprint : "")).size === 1 &&
        new Set(items.map(i => i.result.status === "QUOTED" ? i.result.sourceUrl : "")).size === 1 ? { grandTotal: {
          currency: "CREDITS", kind: totals.some(t => t.kind === "CREDIT_CEILING") ? "CREDIT_CEILING" : "BINDING_QUOTE",
          credits: Math.round(totals.reduce((sum, t) => sum + t.credits, 0) * 1e6) / 1e6 } } : {}),
      ...(complete ? { expiresAt: new Date(Math.min(...items.map(i => i.result.status === "QUOTED" ? Date.parse(i.result.expiresAt) : Infinity))).toISOString() } : {}),
      missingInterfaces, noGenerationSubmitted: true });
  }
}

export function assertCurrentQuote(run: SmartGenerationRun, kind: "IMAGE" | "VIDEO", now = new Date()) {
  const phase=kind==="IMAGE"?run.canvasBinding?.imageQuote:undefined,grant=run.canvasBinding?.imageBudgetGrant;
  if(phase&&grant&&grant.projectId===run.projectId&&grant.runId===run.id&&grant.scopeHash===run.assetPaidScope?.hash&&
    phase.scopeHash===grant.quoteScopeHash&&phase.status==="QUOTED"&&phase.expiresAt&&Date.parse(phase.expiresAt)>now.getTime()&&
    phase.items.length===3&&phase.items.every(i=>i.request.kind==="IMAGE"&&grant.keys.includes(i.request.key)&&i.result.status==="QUOTED"&&i.result.credits===0))return phase;
  const quote = run.feeQuote;
  if(quote?.status==="UNAVAILABLE"&&quote.scopeHash===buildProductionQuoteRequest(run).scopeHash&&quote.missingInterfaces.length)
    throw new DomainValidationError("后台逐项报价仍有缺项，不能付费："+quote.missingInterfaces.map(m=>m.message).join("；"));
  const savedScope=Boolean(run.canvasBinding?.originalQuoteRequest?.scopeHash===quote?.scopeHash&&run.canvasBinding?.sourceScriptHash===run.script?.contentHash&&run.canvasBinding?.sourcePlanHash===run.productionPlan?.contentHash);
  if (!quote || quote.status !== "QUOTED" || !quote.expiresAt || Date.parse(quote.expiresAt) <= now.getTime() ||
      (!savedScope&&quote.scopeHash !== buildProductionQuoteRequest(run).scopeHash) || !quote.items.some(i => i.request.kind === kind))
    throw new DomainValidationError("当前范围缺少有效的后台报价，不能付费；请先调用production.quote，不能接受未知成本绕过");
  return quote;
}
