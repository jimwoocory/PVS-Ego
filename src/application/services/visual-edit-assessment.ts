import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ProductInputStore } from "../ports/product-input-store.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../ports/structured-ai-runtime.js";
import type { Clip, ProductTruth } from "../../domain/schemas.js";
import {
  visualClipAssessmentSchema,
  type VisualClipAssessment
} from "../../domain/visual-edit.js";
import { hashValue, sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { sampleGeneratedVisualReviewFrames } from "../../adapters/media/generated-visual-review-frames.js";

export const VISUAL_EDIT_EVALUATOR_VERSION = "p1f06-visual-edit-v2-visibility";

const proposalSchema = z.object({
  productIdentity: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  /** Visual evidence of presence, independent of whether presence was required. */
  productPresence: z.enum(["ABSENT", "PRESENT", "UNCERTAIN"]),
  /** Whether the expected NONE / PARTIAL / CLEAR / HERO framing was met. */
  visibilityCompliance: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  /** Confidence in non-product checks independent of product identity. */
  sceneConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  storyActionAlignment: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  productStability: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  usageCompliance: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  visualQuality: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  cutQuality: z.enum(["PASS", "BLOCKED", "UNCERTAIN"]),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  recommendedWindowIndex: z.number().int().nonnegative(),
  reasons: z.array(z.string().trim().min(1).max(1200)).min(1).max(20)
}).strict();

function truthRef(truth: ProductTruth) {
  return {
    entityType: "ProductTruth",
    entityId: truth.id,
    version: truth.version,
    hash: truth.contentHash
  };
}

function candidateWindows(sourceDurationMs: number, requiredDurationMs: number) {
  if (sourceDurationMs < requiredDurationMs) {
    throw new DomainValidationError("生成视频短于导演镜头，不能由视觉 AI 静默补帧或变速");
  }
  const maxStart = sourceDurationMs - requiredDurationMs;
  if (maxStart <= 100) {
    return [{ index: 0, inMs: 0, outMs: requiredDurationMs }];
  }
  const count = maxStart >= requiredDurationMs ? 5 : 3;
  const starts = [...new Set(Array.from(
    { length: count },
    (_, index) => Math.round((maxStart * index) / Math.max(1, count - 1))
  ))];
  return starts.map((inMs, index) => ({
    index,
    inMs,
    outMs: inMs + requiredDurationMs
  }));
}

export function applyClipVisibilityPolicy(
  clip: Pick<Clip, "productVisibility">,
  proposal: z.infer<typeof proposalSchema>
) {
  const visibility = clip.productVisibility;
  let productIdentity: "PASS" | "BLOCKED" | "UNCERTAIN" | "NOT_APPLICABLE" = proposal.productIdentity;
  let productStability: "PASS" | "BLOCKED" | "UNCERTAIN" | "NOT_APPLICABLE" = proposal.productStability;
  let confidence = proposal.confidence;
  const notes: string[] = [];
  if (visibility === "NONE") {
    productStability = "NOT_APPLICABLE";
    if (proposal.productPresence === "ABSENT") {
      // The canonical reference remains authenticated, but identity comparison
      // is meaningless when the script deliberately contains no product.
      productIdentity = "NOT_APPLICABLE";
      confidence = proposal.sceneConfidence;
      notes.push("本段为纯剧情镜头，产品按分镜未出场；产品身份与稳定性检查不适用。");
    } else if (proposal.productPresence === "PRESENT") {
      productIdentity = "BLOCKED";
      notes.push("本段导演要求产品不出镜，但采样画面出现了产品，需要核实是否破坏剧情。");
    } else {
      productIdentity = "UNCERTAIN";
      notes.push("纯剧情镜头是否出现了意外产品尚不能确认，需人工看完整视频。");
    }
  } else if (proposal.productPresence === "ABSENT") {
    productIdentity = "BLOCKED";
    productStability = "UNCERTAIN";
    notes.push("当前镜头要求展示产品，但抽样画面没有产品，不得自动采用。");
  } else if (proposal.productPresence === "UNCERTAIN") {
    productIdentity = productIdentity === "BLOCKED" ? "BLOCKED" : "UNCERTAIN";
    notes.push("当前镜头应展示产品，但抽样画面无法可靠确认产品是否出现。");
  } else if (proposal.visibilityCompliance === "BLOCKED") {
    productIdentity = "BLOCKED";
    notes.push("产品虽可能出现，但未达到本段要求的部分/清晰/主视觉展示程度。");
  } else if (proposal.visibilityCompliance === "UNCERTAIN") {
    productIdentity = productIdentity === "BLOCKED" ? "BLOCKED" : "UNCERTAIN";
    notes.push("产品出现程度或构图未能可靠确认，不能自动采用。");
  }
  return { productIdentity, productStability, confidence, notes };
}

function aggregateStatus(checks: {
  productIdentity: "PASS" | "BLOCKED" | "UNCERTAIN" | "NOT_APPLICABLE";
  productStability: "PASS" | "BLOCKED" | "UNCERTAIN" | "NOT_APPLICABLE";
  usageCompliance: "PASS" | "BLOCKED" | "UNCERTAIN";
  visualQuality: "PASS" | "BLOCKED" | "UNCERTAIN";
  cutQuality: "PASS" | "BLOCKED" | "UNCERTAIN";
  storyActionAlignment?: "PASS" | "BLOCKED" | "UNCERTAIN";
}, confidence: "LOW" | "MEDIUM" | "HIGH") {
  const values = Object.values(checks);
  if (values.includes("BLOCKED")) return "BLOCKED" as const;
  if (values.includes("UNCERTAIN") || confidence !== "HIGH") {
    return "UNCERTAIN" as const;
  }
  return "PASS" as const;
}

async function verifiedFile(input: {
  projectId: string;
  artifactId: string;
  expectedHash?: string;
  artifacts: ArtifactRepository;
  store: LocalArtifactStore;
}) {
  const artifact = await input.artifacts.findById(input.artifactId);
  if (
    !artifact ||
    artifact.projectId !== input.projectId ||
    artifact.integrityStatus !== "READY" ||
    !artifact.sha256 ||
    (input.expectedHash && artifact.sha256 !== input.expectedHash)
  ) {
    throw new DomainValidationError("视觉审片素材缺失、已变化或不属于当前项目");
  }
  const file = input.store.resolveArtifactPath(artifact.relativePath);
  const bytes = await fs.readFile(file).catch(() => null);
  if (!bytes || sha256Bytes(bytes) !== artifact.sha256) {
    throw new DomainValidationError("视觉审片素材实际文件缺失或校验失败");
  }
  return { artifact: { ...artifact, sha256: artifact.sha256 }, file, bytes };
}

/** Read-only status for the exact current Clip + GenerationAttempt.
 * Old v1 assessments are kept but explicitly labeled outdated, never reused.
 */
export type VisualReviewReadSummary = {
  clipId: string;
  attemptId: string;
  status: "PASS" | "BLOCKED" | "UNCERTAIN" | "OUTDATED";
  confidence?: "LOW" | "MEDIUM" | "HIGH";
  autoAcceptEligible: boolean;
  productVisibility?: Clip["productVisibility"];
  productPresence?: "ABSENT" | "PRESENT" | "UNCERTAIN";
  productIdentity?: VisualClipAssessment["checks"]["productIdentity"];
  productStability?: VisualClipAssessment["checks"]["productStability"];
  storyActionAlignment?: "PASS" | "BLOCKED" | "UNCERTAIN";
  audioTrackPresent?: boolean;
};

export type VisualClipAssessmentResult = {
  assessment: VisualClipAssessment;
  artifactId: string;
  artifactHash: string;
  selectedWindow: { index: number; inMs: number; outMs: number };
};

export type VisualVersionComparison = {
  clipId: string;
  clipHash: string;
  candidates: Array<{
    attemptId: string;
    attemptNumber: number;
    outputArtifactId: string;
    assessmentArtifactId: string;
    assessmentArtifactHash: string;
    status: VisualClipAssessment["status"];
    confidence: VisualClipAssessment["confidence"];
    autoAcceptEligible: boolean;
    selectedWindow: { index: number; inMs: number; outMs: number };
    reasons: string[];
  }>;
  recommendedAttemptId?: string;
  recommendationReason: string;
};

function comparisonBand(value: VisualClipAssessment): [number, number] {
  const status = value.status === "PASS" ? 0 : value.status === "UNCERTAIN" ? 1 : 2;
  const confidence = value.confidence === "HIGH" ? 0 : value.confidence === "MEDIUM" ? 1 : 2;
  return [status, confidence];
}

export class VisualEditAssessmentService {
  constructor(private readonly d: {
    artifacts: ArtifactRepository;
    productInput: ProductInputStore;
    runtime: StructuredAiRuntime;
    projectsRoot: string;
  }) {}

  private store(projectId: string) {
    return new LocalArtifactStore(
      path.resolve(this.d.projectsRoot, projectId),
      this.d.artifacts
    );
  }

  /** Read saved visual audit snapshots only. Never calls an AI model, writes
   * a decision, downloads media or resumes any production task.
   */
  async readCurrentSummaries(input: {
    projectId: string;
    truthHash: string;
    clips: Array<Pick<Clip, "id" | "contentHash">>;
    attempts: Array<{ id: string; clipId: string; outputArtifactId?: string }>;
  }): Promise<VisualReviewReadSummary[]> {
    const clipMap = new Map(input.clips.map(clip => [clip.id, clip.contentHash]));
    const attemptMap = new Map(input.attempts
      .filter(attempt => Boolean(attempt.outputArtifactId))
      .map(attempt => [attempt.id, attempt]));
    const records = (await this.d.artifacts.listByProject(input.projectId, "STRUCTURED_SNAPSHOT"))
      .filter(record =>
        record.integrityStatus === "READY" &&
        record.relativePath.startsWith("post-production/visual-assessments/"))
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 180);
    const results = new Map<string, VisualReviewReadSummary>();
    const store = this.store(input.projectId);
    for (const record of records) {
      try {
        const file = await verifiedFile({
          projectId: input.projectId, artifactId: record.id,
          expectedHash: record.sha256, artifacts: this.d.artifacts, store
        });
        const review = visualClipAssessmentSchema.parse(JSON.parse(file.bytes.toString("utf8")));
        const { contentHash, ...body } = review;
        if (hashValue(body) !== contentHash) continue;
        if (clipMap.get(review.clipId) !== review.clipHash ||
            review.productTruthRef.hash !== input.truthHash) continue;
        const attempt = attemptMap.get(review.attemptId);
        if (!attempt || attempt.clipId !== review.clipId ||
            attempt.outputArtifactId !== review.outputArtifactId) continue;
        if (results.has(review.clipId)) continue;
        if (review.evaluatorVersion !== VISUAL_EDIT_EVALUATOR_VERSION) {
          results.set(review.clipId, {
            clipId: review.clipId, attemptId: review.attemptId,
            status: "OUTDATED", autoAcceptEligible: false
          });
        } else {
          results.set(review.clipId, {
            clipId: review.clipId, attemptId: review.attemptId,
            status: review.status, confidence: review.confidence,
            autoAcceptEligible: review.autoAcceptEligible,
            ...(review.productVisibility ? {productVisibility: review.productVisibility}:{}),
            ...(review.productPresence ? {productPresence: review.productPresence}:{}),
            productIdentity: review.checks.productIdentity,
            productStability: review.checks.productStability,
            ...(review.checks.storyActionAlignment ? {storyActionAlignment: review.checks.storyActionAlignment} : {}),
            ...(review.audioTrackPresent !== undefined ? {
              audioTrackPresent: review.audioTrackPresent
            } : {})
          });
        }
      } catch {
        // Corrupt/unavailable immutable evidence cannot become a PASS.
        // The rest of the saved assessments remain inspectable.
      }
    }
    return [...results.values()];
  }

  async assess(input: {
    projectId: string;
    truth: ProductTruth;
    clip: Clip;
    attemptId: string;
    outputArtifactId: string;
  }): Promise<VisualClipAssessmentResult> {
    if (input.truth.status !== "CONFIRMED") {
      throw new DomainValidationError("视觉审片需要已确认产品事实");
    }
    const store = this.store(input.projectId);
    const output = await verifiedFile({
      projectId: input.projectId,
      artifactId: input.outputArtifactId,
      artifacts: this.d.artifacts,
      store
    });
    if (output.artifact.kind !== "GENERATED_VIDEO") {
      throw new DomainValidationError("视觉审片只接受生成视频产物");
    }
    const media = await inspectMedia(output.file);
    if (!media.hasVideo) {
      throw new DomainValidationError("视觉审片产物没有可分析的视频轨");
    }

    const snapshot = await this.d.productInput.latest(input.projectId);
    const canonicalAsset = snapshot?.assets.find(
      asset => asset.id === input.truth.canonicalImageId
    );
    if (!canonicalAsset || canonicalAsset.type !== "image") {
      throw new DomainValidationError("已确认产品主图缺失，不能进行产品外观视觉审片");
    }
    const canonical = await verifiedFile({
      projectId: input.projectId,
      artifactId: canonicalAsset.artifactId,
      expectedHash: canonicalAsset.sha256,
      artifacts: this.d.artifacts,
      store
    });
    const canonicalMime = canonical.artifact.mimeType ?? canonicalAsset.mimeType;
    if (!["image/jpeg", "image/png", "image/webp"].includes(canonicalMime ?? "")) {
      throw new DomainValidationError("产品主图格式不支持视觉审片，请使用 JPEG / PNG / WebP");
    }

    const windows = candidateWindows(media.durationMs, input.clip.durationMs);
    const cacheKey = hashValue({
      evaluatorVersion: VISUAL_EDIT_EVALUATOR_VERSION,
      projectId: input.projectId,
      truthHash: input.truth.contentHash,
      clipHash: input.clip.contentHash,
      attemptId: input.attemptId,
      outputArtifactHash: output.artifact.sha256,
      canonicalImageHash: canonical.artifact.sha256,
      sourceDurationMs: media.durationMs,
      requiredDurationMs: input.clip.durationMs,
      windows
    });
    const assessmentArtifactId = "visual-edit-assessment-" + cacheKey;
    const existing = await this.d.artifacts.findById(assessmentArtifactId);
    if (existing) {
      const cached = await verifiedFile({
        projectId: input.projectId,
        artifactId: assessmentArtifactId,
        expectedHash: existing.sha256,
        artifacts: this.d.artifacts,
        store
      });
      const assessment = visualClipAssessmentSchema.parse(
        JSON.parse(cached.bytes.toString("utf8"))
      );
      const { contentHash, ...body } = assessment;
      if (hashValue(body) !== contentHash) {
        throw new DomainValidationError("视觉审片缓存记录完整性校验失败");
      }
      const selectedWindow = assessment.candidateWindows.find(
        item => item.index === assessment.recommendedWindowIndex
      )!;
      return {
        assessment,
        artifactId: cached.artifact.id,
        artifactHash: cached.artifact.sha256,
        selectedWindow
      };
    }

    const tempDir = path.join(
      this.d.projectsRoot,
      input.projectId,
      ".tmp",
      "visual-edit-" + randomUUID()
    );
    try {
      const sampled = await sampleGeneratedVisualReviewFrames({
        filePath: output.file,
        outputDir: tempDir,
        maxFrames: 6
      });
      const frames = sampled.frames;
      const frameMedia = [];
      for (const frame of frames) {
        const bytes = await fs.readFile(frame.path);
        frameMedia.push({
          type: "image" as const,
          mimeType: frame.mimeType,
          dataBase64: bytes.toString("base64"),
          label: "generated@" + frame.timestampMs + "ms"
        });
      }
      const generation = await generateStructuredJson(this.d.runtime, {
        task:
          "Evaluate a generated product-video clip for low-risk automatic selection and a fixed-duration trim window.",
        instructions: [
          "This is a visual quality gate, not a product-fact generator.",
          "First read clip.productVisibility as the authoritative visibility contract: NONE=no product in this clip, PARTIAL=at least a partial identifiable product, CLEAR=clearly visible product, HERO=prominent product showcase.",
          "Report productPresence from actual sampled frames (ABSENT/PRESENT/UNCERTAIN), independently of whether a product was expected; visibilityCompliance reports whether the authored visibility requirement was met.",
          "When productVisibility=NONE, absence is CORRECT. Do NOT lower confidence because the canonical product cannot be compared in this purely narrative clip. Product identity/stability are NOT_APPLICABLE and sceneConfidence must be based only on scene, subjects, visual quality, usage and trim. Unexpected product presence must fail.",
          "When productVisibility=PARTIAL/CLEAR/HERO, the required product must actually appear to the prescribed extent. Absence or a mismatching product is a genuine failure, not a harmless omission. For a present product compare shape, pattern, color and proportions against canonical.",
          "Compare generated frames against the canonical user-confirmed product image only when product is actually shown. Do not infer new features or claims.",
          "If product shape, color, logo/text, proportion or identity appears changed and the evidence is clear, mark the relevant check BLOCKED. If you cannot tell, mark UNCERTAIN rather than guessing.",
          "Check confirmed usage rules only against actions visibly supported by sampled frames. Never turn visual guesses into facts.",
          "Product stability means the same visible product remains structurally consistent across sampled frames without obvious morphing, duplication, missing parts or identity drift. When NONE/ABSENT, no product stability check is applicable.",
          "Non-product sceneConfidence must be independent of product visibility; missing product in NONE must not cause MEDIUM confidence, but poor visuals, unclear actions, or insufficient evidence may.",
          "Check the visually observable main story action and people/scene against clip purpose and segments. Sparse frames cannot verify exact dialogue, lip sync, full action timing, native effects or multi-clip narrative; do not claim they passed.",
          "Visual quality covers severe blur, broken geometry, unreadable required product presentation, or obvious generation defects.",
          "Cut quality chooses only from candidateWindows. Never invent timestamps and never shorten the director-required duration.",
          "Sampled frames are sparse evidence; confidence must be HIGH only when the sampled evidence clearly supports every PASS needed for automatic selection.",
          "Return concise reasons in Chinese."
        ].join(" "),
        input: {
          product: {
            productName: input.truth.productName,
            brand: input.truth.brand ?? null,
            category: input.truth.category ?? null,
            standardColors: input.truth.standardColors,
            forbiddenChanges: input.truth.forbiddenChanges,
            confirmedUsageRules: (input.truth.usageRules ?? [])
              .filter(rule => rule.status === "CONFIRMED")
              .map(rule => ({
                id: rule.id,
                category: rule.category,
                polarity: rule.polarity,
                statement: rule.statement
              }))
          },
          clip: {
            id: input.clip.id,
            purpose: input.clip.purpose,
            durationMs: input.clip.durationMs,
            productVisibility: input.clip.productVisibility,
            strictProductIdentity: input.clip.strictProductIdentity,
            strictProductIdentityScope: input.clip.strictProductIdentityScope,
            segments: input.clip.segments.map(segment => ({
              startMs: segment.startMs,
              endMs: segment.endMs,
              subjectAction: segment.subjectAction,
              productState: segment.productState
            }))
          },
          sourceDurationMs: media.durationMs,
          audioTrackPresent: media.hasAudio,
          sampledFrameTimestampsMs: frames.map(frame => frame.timestampMs),
          candidateWindows: windows
        },
        media: [
          {
            type: "image",
            mimeType: canonicalMime as "image/jpeg" | "image/png" | "image/webp",
            dataBase64: canonical.bytes.toString("base64"),
            label: "canonical-product-image"
          },
          ...frameMedia
        ],
        outputContract: {
          productIdentity: "PASS|BLOCKED|UNCERTAIN",
          productPresence: "ABSENT|PRESENT|UNCERTAIN",
          visibilityCompliance: "PASS|BLOCKED|UNCERTAIN",
          sceneConfidence: "LOW|MEDIUM|HIGH",
          storyActionAlignment: "PASS|BLOCKED|UNCERTAIN",
          productStability: "PASS|BLOCKED|UNCERTAIN",
          usageCompliance: "PASS|BLOCKED|UNCERTAIN",
          visualQuality: "PASS|BLOCKED|UNCERTAIN",
          cutQuality: "PASS|BLOCKED|UNCERTAIN",
          confidence: "LOW|MEDIUM|HIGH",
          recommendedWindowIndex: 0,
          reasons: ["string"]
        },
        context: {
          projectId: input.projectId,
          step: "AUTO_EDIT_VISUAL"
        }
      });
      const proposal = proposalSchema.parse(generation.data);
      if (!windows.some(window => window.index === proposal.recommendedWindowIndex)) {
        throw new DomainValidationError("视觉模型返回了不存在的剪辑候选区间");
      }
      const visiblePolicy = applyClipVisibilityPolicy(input.clip, proposal);
      const checks = {
        productIdentity: visiblePolicy.productIdentity,
        productStability: visiblePolicy.productStability,
        usageCompliance: proposal.usageCompliance,
        visualQuality: proposal.visualQuality,
        cutQuality: proposal.cutQuality,
        storyActionAlignment: proposal.storyActionAlignment
      };
      const status = aggregateStatus(checks, visiblePolicy.confidence);
      const createdAt = new Date().toISOString();
      const body = {
        id: "visual-assessment-" + cacheKey,
        projectId: input.projectId,
        clipId: input.clip.id,
        clipHash: input.clip.contentHash,
        attemptId: input.attemptId,
        outputArtifactId: output.artifact.id,
        outputArtifactHash: output.artifact.sha256,
        productTruthRef: truthRef(input.truth),
        productVisibility: input.clip.productVisibility,
        productPresence: proposal.productPresence,
        audioTrackPresent: media.hasAudio,
        canonicalImageAssetId: canonicalAsset.id,
        canonicalImageArtifactId: canonical.artifact.id,
        canonicalImageHash: canonical.artifact.sha256,
        evaluatorVersion: VISUAL_EDIT_EVALUATOR_VERSION,
        sourceDurationMs: media.durationMs,
        requiredDurationMs: input.clip.durationMs,
        sampledFrameTimestampsMs: frames.map(frame => frame.timestampMs),
        candidateWindows: windows,
        checks,
        confidence: visiblePolicy.confidence,
        recommendedWindowIndex: proposal.recommendedWindowIndex,
        status,
        autoAcceptEligible: status === "PASS" && visiblePolicy.confidence === "HIGH",
        reasons: [...visiblePolicy.notes, ...proposal.reasons],
        ...(generation.metadata ? { aiExecution: generation.metadata } : {}),
        createdAt
      };
      const assessment = visualClipAssessmentSchema.parse({
        ...body,
        contentHash: hashValue(body)
      });
      const stored = await store.writeImmutable({
        id: assessmentArtifactId,
        projectId: input.projectId,
        kind: "STRUCTURED_SNAPSHOT",
        immutable: true,
        relativePath:
          "post-production/visual-assessments/" + cacheKey + ".json",
        mimeType: "application/json",
        bytes: Buffer.from(JSON.stringify(assessment, null, 2), "utf8")
      });
      if (!stored.sha256) {
        throw new DomainValidationError("视觉审片结果尚未进入可用状态");
      }
      const selectedWindow = windows.find(
        window => window.index === assessment.recommendedWindowIndex
      )!;
      return {
        assessment,
        artifactId: stored.id,
        artifactHash: stored.sha256,
        selectedWindow
      };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }

  /**
   * Compare multiple successful outputs for the same current Clip.
   * The visual model evaluates each version independently against ProductTruth;
   * this method only aggregates those immutable assessments. It never creates a
   * ReviewDecision, never revives a superseded attempt and never submits video.
   */
  async compareVersions(input: {
    projectId: string;
    truth: ProductTruth;
    clip: Clip;
    attempts: Array<{
      attemptId: string;
      attemptNumber: number;
      outputArtifactId: string;
    }>;
  }): Promise<VisualVersionComparison> {
    if (input.attempts.length < 2) {
      throw new DomainValidationError("至少需要两个成功视频版本才能比较");
    }
    if (input.attempts.length > 6) {
      throw new DomainValidationError("一次最多比较最近 6 个成功版本，请先缩小比较范围");
    }
    const seenAttempts = new Set<string>();
    const results: Array<{
      attemptId: string;
      attemptNumber: number;
      outputArtifactId: string;
      result: VisualClipAssessmentResult;
    }> = [];
    for (const attempt of input.attempts) {
      if (seenAttempts.has(attempt.attemptId)) {
        throw new DomainValidationError("多版本比较不能包含重复生成记录");
      }
      seenAttempts.add(attempt.attemptId);
      results.push({
        ...attempt,
        result: await this.assess({
          projectId: input.projectId,
          truth: input.truth,
          clip: input.clip,
          attemptId: attempt.attemptId,
          outputArtifactId: attempt.outputArtifactId
        })
      });
    }
    results.sort((a, b) => {
      const aa = comparisonBand(a.result.assessment);
      const bb = comparisonBand(b.result.assessment);
      return aa[0] - bb[0] || aa[1] - bb[1] || b.attemptNumber - a.attemptNumber;
    });
    const first = results[0]!;
    const second = results[1]!;
    const firstBand = comparisonBand(first.result.assessment);
    const secondBand = comparisonBand(second.result.assessment);
    const uniquelySafer =
      firstBand[0] < secondBand[0] ||
      (firstBand[0] === secondBand[0] && firstBand[1] < secondBand[1]);
    const recommendedAttemptId =
      first.result.assessment.autoAcceptEligible && uniquelySafer
        ? first.attemptId
        : undefined;
    const candidates = results.map(item => ({
      attemptId: item.attemptId,
      attemptNumber: item.attemptNumber,
      outputArtifactId: item.outputArtifactId,
      assessmentArtifactId: item.result.artifactId,
      assessmentArtifactHash: item.result.artifactHash,
      status: item.result.assessment.status,
      confidence: item.result.assessment.confidence,
      autoAcceptEligible: item.result.assessment.autoAcceptEligible,
      selectedWindow: item.result.selectedWindow,
      reasons: item.result.assessment.reasons
    }));
    return {
      clipId: input.clip.id,
      clipHash: input.clip.contentHash,
      candidates,
      ...(recommendedAttemptId ? { recommendedAttemptId } : {}),
      recommendationReason: recommendedAttemptId
        ? "该版本是本次比较中唯一处于更安全视觉门禁档位且达到高置信自动采用条件的版本；仅作为版本建议，不会自动回退或改写审片决定。"
        : "现有视觉证据不足以可靠区分出唯一更优版本；请播放完整视频人工比较。"
    };
  }
}
