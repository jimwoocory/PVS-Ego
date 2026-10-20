import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { GenerationRequest } from "../../domain/schemas.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../ports/structured-ai-runtime.js";
import { inspectMedia } from "../../adapters/media/inspect-media.js";
import { sanitizeGeneratedClipAudio } from "../../adapters/media/sanitize-generated-audio.js";

const execute = promisify(execFile);

const assessmentSchema = z.object({
  music: z.enum(["ABSENT", "PRESENT", "UNCERTAIN"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  reason: z.string().trim().min(1)
}).strict();

export type GeneratedAudioSanitizeResult = {
  path: string;
  nativeAudioState:
    | "NOT_REQUESTED"
    | "PRESERVED_VERIFIED_NO_MUSIC"
    | "PRESERVED_V3_NATIVE_BGM_SUSPECTED"
    | "STRIPPED_MUSIC_OR_UNCERTAIN"
    | "ABSENT";
  reason?: string;
};

function isV2Request(request: GenerationRequest): boolean {
  return request.inputVersionRefs.some(
    ref => ref.entityType === "ProductionAssetSet"
  );
}

/**
 * Strict V2 rule:
 * - Silent clips never keep provider audio.
 * - Native-audio clips keep provider audio only when an audio-capable model
 *   returns HIGH confidence that no music bed is present.
 * - Any classifier failure/uncertainty strips provider audio and lets
 *   post-production SOURCE_OR_LOCAL_TTS rebuild the required speech.
 */
export class GeneratedAudioQcService {
  constructor(
    private readonly runtime: StructuredAiRuntime,
    private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg"
  ) {}

  async sanitize(
    file: string,
    request: GenerationRequest,
    tempDir: string
  ): Promise<GeneratedAudioSanitizeResult> {
    const v3Native =
      request.audioPolicy === "V3_NATIVE_NO_BGM";
    if (!request.generateAudio) {
      if (v3Native) {
        return {
          path: file,
          nativeAudioState:
            "PRESERVED_V3_NATIVE_BGM_SUSPECTED",
          reason:
            "Director V3 原生声音策略与 request.generateAudio=false 冲突；为避免误删对白/环境声，保留原始媒体并要求重新生成链路。"
        };
      }
      const stripped = await sanitizeGeneratedClipAudio(
        file,
        false,
        tempDir,
        this.ffmpeg
      );
      return {
        path: stripped,
        nativeAudioState: "NOT_REQUESTED",
        reason: "该分镜没有原生声音需求；正式素材不保留模型音轨"
      };
    }

    const media = await inspectMedia(file);
    if (!media.hasAudio) {
      return {
        path: file,
        nativeAudioState: "ABSENT",
        reason: "模型未返回原生音轨"
      };
    }

    if (!isV2Request(request)) {
      return {
        path: file,
        nativeAudioState: "PRESERVED_VERIFIED_NO_MUSIC",
        reason: "V1 兼容：保留原有原生音轨策略"
      };
    }

    const audioPath = path.join(tempDir, "native-audio-qc.wav");
    try {
      await execute(
        this.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          file,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-t",
          "15",
          "-c:a",
          "pcm_s16le",
          "-y",
          audioPath
        ],
        {
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024
        }
      );
      const bytes = await fs.readFile(audioPath);
      const result = await generateStructuredJson(this.runtime, {
        task:
          "Detect whether this generated short-video audio contains any background music, musical score, song, instrumental bed or rhythmic music layer.",
        instructions: [
          "This is a strict audio contamination gate.",
          "Music means any background music, score, song, melody, instrumental bed, jingle or sustained rhythmic musical layer.",
          "Dialogue, narration, room tone, cloth movement, footsteps and natural action sounds are not music.",
          "Return ABSENT/HIGH only when you are highly confident there is no music anywhere in the supplied audio.",
          "If music may be present, if the evidence is ambiguous, or if you cannot reliably hear the full sample, return PRESENT or UNCERTAIN.",
          "Do not judge video quality or product content."
        ].join(" "),
        input: {
          durationMs: media.durationMs,
          policy: "NO_MODEL_BGM_STRICT"
        },
        outputContract: {
          music: "ABSENT|PRESENT|UNCERTAIN",
          confidence: "HIGH|MEDIUM|LOW",
          reason: "brief evidence-based reason"
        },
        media: [
          {
            type: "audio",
            mimeType: "audio/wav",
            dataBase64: bytes.toString("base64"),
            label: "seedance-native-audio"
          }
        ],
        context: {
          projectId: request.projectId,
          step: "AUTO_EDIT_VISUAL"
        }
      });
      const assessment = assessmentSchema.parse(result.data);
      if (
        assessment.music === "ABSENT" &&
        assessment.confidence === "HIGH"
      ) {
        return {
          path: file,
          nativeAudioState: "PRESERVED_VERIFIED_NO_MUSIC",
          reason: assessment.reason
        };
      }
      if (v3Native) {
        return {
          path: file,
          nativeAudioState:
            "PRESERVED_V3_NATIVE_BGM_SUSPECTED",
          reason:
            assessment.music +
            "/" +
            assessment.confidence +
            "：" +
            assessment.reason +
            "。Director V3 保留 Seedance 原生对白/OS/环境声/音效，不做整轨剥离；建议重新生成该 Clip。"
        };
      }
      const stripped = await sanitizeGeneratedClipAudio(
        file,
        false,
        tempDir,
        this.ffmpeg
      );
      return {
        path: stripped,
        nativeAudioState: "STRIPPED_MUSIC_OR_UNCERTAIN",
        reason:
          assessment.music +
          "/" +
          assessment.confidence +
          "：" +
          assessment.reason
      };
    } catch (error) {
      if (v3Native) {
        return {
          path: file,
          nativeAudioState:
            "PRESERVED_V3_NATIVE_BGM_SUSPECTED",
          reason:
            "原生音轨无 BGM 检测失败；Director V3 不会因此删除整条音轨，保留原始媒体并建议人工审听/重新生成：" +
            (error instanceof Error ? error.message : String(error))
        };
      }
      const stripped = await sanitizeGeneratedClipAudio(
        file,
        false,
        tempDir,
        this.ffmpeg
      );
      return {
        path: stripped,
        nativeAudioState: "STRIPPED_MUSIC_OR_UNCERTAIN",
        reason:
          "原生音轨无法高置信完成无音乐验证，按 V2 严格策略移除：" +
          (error instanceof Error ? error.message : String(error))
      };
    } finally {
      await fs.rm(audioPath, { force: true }).catch(() => undefined);
    }
  }
}
