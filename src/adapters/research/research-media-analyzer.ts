import "../../isolation/require-isolation.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ResearchMediaAnalysis,
  ResearchMediaAnalyzer,
  WebResearchMedia
} from "../../application/ports/research-provider.js";
import type {
  ResearchEvidenceSourceType
} from "../../application/ports/research-repository.js";
import type { StructuredAiRuntime } from "../../application/ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../../application/ports/structured-ai-runtime.js";
import {
  extractReferenceAudio,
  probeReferenceVideo,
  sampleReferenceFrames
} from "../media/reference-video-media.js";
import { assertSafeResearchUrl } from "./http-web-research-provider.js";
import type { ResearchReferenceSink } from "../../application/ports/creative-reference-repository.js";
import { sampleResearchReferenceFrames } from "../media/research-reference-frames.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const analysisSchema = z.object({
  productIdentityMatch: z
    .enum(["CONFIRMED", "UNCERTAIN", "NOT_PRODUCT"])
    .default("UNCERTAIN"),
  identityReason: z
    .string()
    .trim()
    .min(1)
    .default("未提供充分产品身份依据"),
  summary: z.string().trim().min(1),
  observations: z.array(
    z.object({
      category: z.enum([
        "IDENTITY",
        "USAGE_METHOD",
        "WEARING_POSITION",
        "PRECAUTION",
        "FUNCTION_EFFECT",
        "USAGE_SCENARIO",
        "OTHER"
      ]),
      statement: z.string().trim().min(1),
      confidence: z.enum(["LOW", "MEDIUM", "HIGH"])
    })
  ).max(20)
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceConfidence(
  sourceType: ResearchEvidenceSourceType
): "LOW" | "MEDIUM" | "HIGH" {
  if (sourceType === "OFFICIAL") return "HIGH";
  if (
    sourceType === "USER_URL" ||
    sourceType === "PUBLIC_PRODUCT" ||
    sourceType === "INDUSTRY"
  ) {
    return "MEDIUM";
  }
  return "LOW";
}

function categoryLabel(value: z.infer<typeof analysisSchema>["observations"][number]["category"]): string {
  return {
    IDENTITY: "产品身份",
    USAGE_METHOD: "使用方法",
    WEARING_POSITION: "佩戴/安装位置",
    PRECAUTION: "注意事项/限制",
    FUNCTION_EFFECT: "功能作用",
    USAGE_SCENARIO: "使用场景",
    OTHER: "其他"
  }[value];
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("研究媒体超过允许大小");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class DefaultResearchMediaAnalyzer implements ResearchMediaAnalyzer {
  constructor(
    private readonly runtime: StructuredAiRuntime,
    private readonly options: {
      allowPrivateNetwork?: boolean;
      timeoutMs?: number;
      maxImageBytes?: number;
      maxVideoBytes?: number;
      maxItemsPerPage?: number;
    } = {},
    private readonly referenceSink?: ResearchReferenceSink
  ) {}

  private async fetchMedia(
    rawUrl: string,
    maxBytes: number
  ): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
    let url = await assertSafeResearchUrl(
      rawUrl,
      this.options.allowPrivateNetwork === true
    );
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? 30_000
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "image/*,video/*;q=0.9,*/*;q=0.1",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            "user-agent": USER_AGENT
          }
        });
      } finally {
        clearTimeout(timer);
      }
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        if (redirect >= 4) throw new Error("研究媒体重定向次数过多");
        url = await assertSafeResearchUrl(
          new URL(response.headers.get("location")!, url).toString(),
          this.options.allowPrivateNetwork === true
        );
        continue;
      }
      if (!response.ok) {
        throw new Error("研究媒体返回 HTTP " + response.status);
      }
      const bodyTimer=setTimeout(()=>controller.abort(),this.options.timeoutMs??30_000);
      try {
        return {bytes:await readLimitedBytes(response,maxBytes),contentType:(response.headers.get("content-type")??"").toLowerCase(),finalUrl:url.toString()};
      } finally { clearTimeout(bodyTimer); }
    }
    throw new Error("研究媒体请求失败");
  }

  private async analyzeFrames(input: {
    projectId: string;
    pageTitle: string;
    parentSourceUrl: string;
    mediaUrl: string;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
    media: Array<{
      type: "image";
      mimeType: "image/jpeg" | "image/png" | "image/webp";
      dataBase64: string;
      label: string;
    }>;
    context: string;
  }) {
    return generateStructuredJson(this.runtime, {
      task:
        "Analyze visual research evidence for a product-video system. Extract only what is visibly supported.",
      instructions: [
        "重点检查：产品正确使用方法、佩戴或安装位置、注意事项与限制、功能实际作用、适用使用场景、产品状态。",
        "先判断画面是否能明确确认是当前研究产品。只有品牌/型号文字、来源上下文与外观身份足够一致时才可标为 CONFIRMED；仅凭形状相似必须标为 UNCERTAIN；明显不是该产品时标为 NOT_PRODUCT。",
        "不要把视觉推测当成产品事实；看不清、无法确认或只有营销暗示时必须降低置信度。",
        "不要从竞品视觉材料推导用户产品事实。",
        "如果画面出现文字，可读取文字，但不要补写看不到的内容。",
        "视频分析基于采样帧，不代表完整视频；音频语义未提供时不得猜测旁白。"
      ].join(" "),
      input: {
        productIdentity: input.productIdentity ?? null,
        parentSourceUrl: input.parentSourceUrl,
        mediaUrl: input.mediaUrl,
        pageTitle: input.pageTitle,
        context: input.context
      },
      media: input.media,
      outputContract: {
        productIdentityMatch: "CONFIRMED|UNCERTAIN|NOT_PRODUCT",
        identityReason: "string",
        summary: "string",
        observations: [
          {
            category:
              "IDENTITY|USAGE_METHOD|WEARING_POSITION|PRECAUTION|FUNCTION_EFFECT|USAGE_SCENARIO|OTHER",
            statement: "string",
            confidence: "LOW|MEDIUM|HIGH"
          }
        ]
      },
      context: {
        projectId: input.projectId,
        step: "RESEARCH"
      }
    });
  }

  private textFromProposal(proposal: z.infer<typeof analysisSchema>): string {
    const lines = [
      `[产品身份匹配][${proposal.productIdentityMatch}] ${proposal.identityReason}`,
      proposal.summary
    ];
    for (const item of proposal.observations) {
      lines.push(
        `[${categoryLabel(item.category)}][${item.confidence}] ${item.statement}`
      );
    }
    return lines.join("\n");
  }

  private async analyzeAudio(input: {
    projectId: string;
    parentSourceUrl: string;
    pageTitle: string;
    sourceType: ResearchEvidenceSourceType;
    mediaUrl: string;
    audioPath: string;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
  }): Promise<ResearchMediaAnalysis> {
    const bytes = await fs.readFile(input.audioPath);
    if (bytes.byteLength > 12 * 1024 * 1024) {
      throw new Error("提取音频超过 12MB，跳过音频多模态分析");
    }
    const generation = await generateStructuredJson(this.runtime, {
      task:
        "Analyze spoken/audio research evidence for a product-video system and extract product usage constraints.",
      instructions: [
        "重点识别旁白或语音中明确说明的使用方法、佩戴/安装位置、注意事项、限制、功能作用和使用场景。",
        "先判断音频是否明确提到当前研究产品的品牌、型号或足以确认身份的上下文；否则 productIdentityMatch 必须为 UNCERTAIN。",
        "只能依据可听到的内容，不要补写或猜测听不清的语句。",
        "营销夸张表达不得自动视为技术事实；不确定时降低置信度。",
        "不要从竞品音频推导用户产品事实。"
      ].join(" "),
      input: {
        productIdentity: input.productIdentity ?? null,
        parentSourceUrl: input.parentSourceUrl,
        mediaUrl: input.mediaUrl,
        pageTitle: input.pageTitle,
        context: "从视频中提取的单声道 16kHz MP3 音频，最长分析前 300 秒"
      },
      media: [
        {
          type: "audio",
          mimeType: "audio/mpeg",
          dataBase64: bytes.toString("base64"),
          label: "research-video-audio"
        }
      ],
      outputContract: {
        productIdentityMatch: "CONFIRMED|UNCERTAIN|NOT_PRODUCT",
        identityReason: "string",
        summary: "string",
        observations: [
          {
            category:
              "IDENTITY|USAGE_METHOD|WEARING_POSITION|PRECAUTION|FUNCTION_EFFECT|USAGE_SCENARIO|OTHER",
            statement: "string",
            confidence: "LOW|MEDIUM|HIGH"
          }
        ]
      },
      context: {
        projectId: input.projectId,
        step: "RESEARCH"
      }
    });
    const proposal = analysisSchema.parse(generation.data);
    return {
      sourceUrl: input.mediaUrl,
      title: `视频音频证据 · ${input.pageTitle}`,
      text: this.textFromProposal(proposal),
      contentHash: sha256(bytes),
      confidence:
        proposal.productIdentityMatch === "CONFIRMED"
          ? sourceConfidence(input.sourceType)
          : "LOW",
      mediaContext: {
        type: "AUDIO",
        parentSourceUrl: input.parentSourceUrl,
        mediaUrl: input.mediaUrl,
        analysisMethod: "AUDIO_MULTIMODAL",
        productIdentityMatch: proposal.productIdentityMatch,
        identityReason: proposal.identityReason
      }
    };
  }

  private async analyzeImage(input: {
    projectId: string;
    runId: string;
    parentSourceUrl: string;
    pageTitle: string;
    sourceType: ResearchEvidenceSourceType;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
    media: WebResearchMedia;
  }): Promise<ResearchMediaAnalysis & { referenceCaptureWarning?: string }> {
    const fetched = await this.fetchMedia(
      input.media.url,
      this.options.maxImageBytes ?? 8 * 1024 * 1024
    );
    const mimeType = fetched.contentType.split(";")[0]!.trim();
    if (
      mimeType !== "image/jpeg" &&
      mimeType !== "image/png" &&
      mimeType !== "image/webp"
    ) {
      throw new Error("当前视觉分析只支持 JPEG/PNG/WebP 图片");
    }
    let referenceCaptureWarning: string | undefined;
    try {
      await this.referenceSink?.capture({ projectId:input.projectId,runId:input.runId,parentSourceUrl:input.parentSourceUrl,mediaUrl:fetched.finalUrl,
        title:input.pageTitle,sourceType:input.sourceType,sourceBytes:fetched.bytes,sourceMimeType:mimeType,images:[{bytes:fetched.bytes,mimeType}] });
    } catch { referenceCaptureWarning = "参考素材候选留存失败，普通证据分析继续；该媒体尚未成为可用创作参考"; }
    const generation = await this.analyzeFrames({
      projectId: input.projectId,
      pageTitle: input.pageTitle,
      parentSourceUrl: input.parentSourceUrl,
      mediaUrl: fetched.finalUrl,
      productIdentity: input.productIdentity,
      media: [
        {
          type: "image",
          mimeType,
          dataBase64: Buffer.from(fetched.bytes).toString("base64"),
          label: input.media.label ?? "research-image"
        }
      ],
      context: "单张网页图片证据"
    });
    const proposal = analysisSchema.parse(generation.data);
    return {
      sourceUrl: fetched.finalUrl,
      title: `图片证据 · ${input.pageTitle}`,
      ...(referenceCaptureWarning ? {referenceCaptureWarning} : {}),
      text: this.textFromProposal(proposal),
      contentHash: sha256(fetched.bytes),
      confidence:
        proposal.productIdentityMatch === "CONFIRMED"
          ? sourceConfidence(input.sourceType)
          : "LOW",
      mediaContext: {
        type: "IMAGE",
        parentSourceUrl: input.parentSourceUrl,
        mediaUrl: fetched.finalUrl,
        analysisMethod: "VISION",
        productIdentityMatch: proposal.productIdentityMatch,
        identityReason: proposal.identityReason
      }
    };
  }

  private async analyzeVideo(input: {
    projectId: string;
    runId: string;
    parentSourceUrl: string;
    pageTitle: string;
    sourceType: ResearchEvidenceSourceType;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
    media: WebResearchMedia;
  }): Promise<{
    analyses: ResearchMediaAnalysis[];
    failures: string[];
  }> {
    const fetched = await this.fetchMedia(
      input.media.url,
      this.options.maxVideoBytes ?? 80 * 1024 * 1024
    );
    const mimeType = fetched.contentType.split(";")[0]!.trim();
    if (!mimeType.startsWith("video/")) {
      throw new Error("媒体链接不是可直接分析的视频文件");
    }

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pvs-research-video-")
    );
    try {
      const videoPath = path.join(tempRoot, "source.mp4");
      await fs.writeFile(videoPath, fetched.bytes);
      const info = await probeReferenceVideo(videoPath);
      const frames = this.referenceSink ? await sampleResearchReferenceFrames(videoPath,path.join(tempRoot,"frames"),8) : await sampleReferenceFrames({
        filePath: videoPath,
        outputDir: path.join(tempRoot, "frames"),
        durationMs: info.durationMs,
        maxFrames: 8
      });
      const media = [];
      for (const frame of frames) {
        const bytes = await fs.readFile(frame.path);
        media.push({
          type: "image" as const,
          mimeType: frame.mimeType,
          dataBase64: bytes.toString("base64"),
          label: `video-frame@${frame.timestampMs}ms`
        });
      }
      const failures: string[] = [];
      if (this.referenceSink) try {
        await this.referenceSink.capture({projectId:input.projectId,runId:input.runId,parentSourceUrl:input.parentSourceUrl,mediaUrl:fetched.finalUrl,
          title:input.pageTitle,sourceType:input.sourceType,sourceBytes:fetched.bytes,sourceMimeType:mimeType,
          images:await Promise.all(frames.map(async(frame,index)=>({bytes:await fs.readFile(frame.path),mimeType:frame.mimeType,timestampMs:frame.timestampMs,frameIndex:index}))) });
      } catch { failures.push("视频帧候选留存失败，普通证据分析继续；未确认帧不会进入创作参考"); }
      const generation = await this.analyzeFrames({
        projectId: input.projectId,
        pageTitle: input.pageTitle,
        parentSourceUrl: input.parentSourceUrl,
        mediaUrl: fetched.finalUrl,
        productIdentity: input.productIdentity,
        media,
        context: `视频采样帧；durationMs=${info.durationMs}; hasAudio=${info.hasAudio}; 音频未转写`
      });
      const proposal = analysisSchema.parse(generation.data);
      const analyses: ResearchMediaAnalysis[] = [{
        sourceUrl: fetched.finalUrl,
        title: `视频画面证据 · ${input.pageTitle}`,
        text: this.textFromProposal(proposal),
        contentHash: sha256(fetched.bytes),
        confidence:
          proposal.productIdentityMatch === "CONFIRMED"
            ? sourceConfidence(input.sourceType)
            : "LOW",
        mediaContext: {
          type: "VIDEO_FRAMES",
          parentSourceUrl: input.parentSourceUrl,
          mediaUrl: fetched.finalUrl,
          analysisMethod: "VIDEO_FRAME_SAMPLING",
          productIdentityMatch: proposal.productIdentityMatch,
          identityReason: proposal.identityReason,
          timestampsMs: frames.map((frame) => frame.timestampMs)
        }
      }];
      if (info.hasAudio) {
        try {
          const audio = await extractReferenceAudio({
            filePath: videoPath,
            outputPath: path.join(tempRoot, "audio.mp3"),
            maxDurationSeconds: Math.min(300, Math.ceil(info.durationMs / 1000))
          });
          analyses.push(
            await this.analyzeAudio({
              projectId: input.projectId,
              parentSourceUrl: input.parentSourceUrl,
              pageTitle: input.pageTitle,
              sourceType: input.sourceType,
              mediaUrl: fetched.finalUrl,
              audioPath: audio.path,
              productIdentity: input.productIdentity
            })
          );
        } catch (error) {
          failures.push(
            `音频分析：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      return { analyses, failures };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  async analyze(input: {
    projectId: string;
    runId: string;
    parentSourceUrl: string;
    pageTitle: string;
    sourceType: ResearchEvidenceSourceType;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
    media: WebResearchMedia[];
  }): Promise<{ analyses: ResearchMediaAnalysis[]; failures: string[] }> {
    const analyses: ResearchMediaAnalysis[] = [];
    const failures: string[] = [];
    const items = input.media.slice(0, this.options.maxItemsPerPage ?? 2);
    for (const media of items) {
      try {
        if (media.type === "IMAGE") {
          const analyzed = await this.analyzeImage({ ...input, media });
          analyses.push(analyzed);
          if (analyzed.referenceCaptureWarning) failures.push(analyzed.referenceCaptureWarning);
        } else {
          const video = await this.analyzeVideo({ ...input, media });
          analyses.push(...video.analyses);
          failures.push(...video.failures);
        }
      } catch (error) {
        failures.push(
          `${media.url}：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return { analyses, failures };
  }
}
