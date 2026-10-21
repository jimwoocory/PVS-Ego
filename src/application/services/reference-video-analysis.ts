import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactRepository } from "../ports/artifact-repository.js";
import type { ReferenceVideoRepository } from "../ports/reference-video-repository.js";
import type { StructuredAiRuntime } from "../ports/structured-ai-runtime.js";
import { generateStructuredJson } from "../ports/structured-ai-runtime.js";
import {
  referenceVideoProfileSchema,
  type ReferenceVideoProfile
} from "../../domain/schemas.js";
import { hashValue,sha256Bytes } from "../../domain/hashing.js";
import { DomainValidationError } from "../../domain/validation.js";
import { LocalArtifactStore } from "../../adapters/store/local-artifact-store.js";
import { readReferenceEvidence, samplingManifest, sameEvidence, evidenceDenied } from "./reference-video-evidence.js";
import {
  createReferenceVideoBrowserPreview,
  probeReferenceVideo,
  referenceVideoNeedsBrowserPreview,
  sampleReferenceFrames
} from "../../adapters/media/reference-video-media.js";

const proposalSchema = z.object({
  analysisConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  hook: z.object({
    firstThreeSecondsPattern: z.string().trim().min(1),
    structuralPurpose: z.string().trim().min(1)
  }),
  pacing: z.object({
    overall: z.string().trim().min(1),
    estimatedShotCount: z.number().int().positive()
  }),
  shotLanguage: z.object({
    shotSizes: z.array(z.string().trim().min(1)).max(20),
    cameraPositions: z.array(z.string().trim().min(1)).max(20),
    cameraMovements: z.array(z.string().trim().min(1)).max(20),
    compositionPatterns: z.array(z.string().trim().min(1)).max(20)
  }),
  productAppearance: z.object({
    firstAppearanceMs: z.number().int().nonnegative().nullable(),
    visibilityPattern: z.string().trim().min(1),
    showcasePattern: z.string().trim().min(1)
  }),
  sellingPointPattern: z.array(z.string().trim().min(1)).max(20),
  dialogueNarrationStructure: z.string().trim().min(1),
  audioBgMusicStructure: z.string().trim().min(1),
  ctaPattern: z.string().trim().min(1),
  reusableStylePrinciples: z.array(z.string().trim().min(1)).min(1).max(20),
  frameObservations:z.array(z.object({timestampMs:z.number().int().nonnegative(),observation:z.string().trim().min(1),visibleText:z.string().trim().max(100).optional(),confidence:z.enum(["LOW","MEDIUM","HIGH"]),textStatus:z.enum(["READABLE","UNCERTAIN","NOT_VISIBLE"]).optional()})).max(40).default([])
});

export const REFERENCE_VIDEO_EVIDENCE_INSTRUCTIONS = "Respect referenceVideoProfile.observation: audio NOT_OBSERVED is not speech or music evidence; sampled OCR is visible text, never an audio transcript or Product Truth. Preserve UNCERTAIN text and missing observations. Only DECODED_FRAME_PTS timing has verified frame alignment; legacy estimated times are unverified. Never copy source captions, instructions or brand expression into the new work.";

function profileContentHash(
  profile: Omit<ReferenceVideoProfile, "contentHash">
): string {
  return hashValue(profile);
}

export function referenceVideoBrowserPreviewRelativePath(
  videoArtifactHash: string
): string {
  return (
    "reference-video/previews/" +
    videoArtifactHash +
    "-browser-h264.mp4"
  );
}

export class ReferenceVideoAnalysisService {
  constructor(
    private readonly repo: ReferenceVideoRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly runtime: StructuredAiRuntime,
    private readonly projectsRoot: string,
    private readonly media = {probeReferenceVideo, sampleReferenceFrames, createReferenceVideoBrowserPreview}
  ) {}

  async latest(projectId: string): Promise<ReferenceVideoProfile | null> {
    const profile=await this.repo.latestActive(projectId);
    if(profile?.observation?.version==="reference-observation-v3")await this.verifyProfileArtifacts(profile,projectId);
    return profile;
  }

  private async verifyProfileArtifacts(profile:ReferenceVideoProfile,projectId:string):Promise<void>{
    referenceVideoProfileForPrompt(profile,projectId);
    if(profile.observation?.version!=="reference-observation-v3"||!profile.observation.samplingManifest) evidenceDenied();
    await readReferenceEvidence(this.artifacts,this.projectsRoot,projectId,profile.videoArtifactId,profile.videoArtifactHash,["video/mp4","video/quicktime"]);
    for(const frame of profile.observation!.frames){
      await readReferenceEvidence(this.artifacts,this.projectsRoot,projectId,frame.artifactId,frame.sha256,["image/jpeg"],16*1024*1024);
    }
    const ref=profile.observation.samplingManifest;
    const bytes=await readReferenceEvidence(this.artifacts,this.projectsRoot,projectId,ref.artifactId,ref.sha256,["application/json"],65536);
    let manifest:unknown;try{manifest=JSON.parse(bytes.toString("utf8"));}catch{evidenceDenied();}
    if(!sameEvidence(manifest,samplingManifest(projectId,{artifactId:profile.videoArtifactId,sha256:profile.videoArtifactHash},profile.media,profile.observation.frames)))evidenceDenied();
    if(profile.observation.audio.status!==(profile.media.hasAudio?"NOT_OBSERVED":"NO_TRACK")||profile.observation.frames.length<1||profile.observation.frames.length>10)evidenceDenied();
  }

  async assertCurrentEvidence(profile:ReferenceVideoProfile,projectId:string):Promise<void>{
    const current=await this.repo.latestActive(projectId);
    if(!current||profile.status!=="ACTIVE"||current.id!==profile.id||current.version!==profile.version||current.contentHash!==profile.contentHash)evidenceDenied();
    await this.verifyProfileArtifacts(profile,projectId);
  }

  async list(projectId: string): Promise<ReferenceVideoProfile[]> {
    return this.repo.listProfiles(projectId);
  }

  async deactivate(projectId: string): Promise<void> {
    await this.repo.markActiveProfilesStale(projectId);
  }

  async analyzeUpload(input: {
    projectId: string;
    artifactId: string;
    originalFilename?: string;
    sourceUrl?: string;
  }): Promise<ReferenceVideoProfile> {
    const artifact = await this.artifacts.findById(input.artifactId);
    if (
      !artifact ||
      artifact.projectId !== input.projectId ||
      artifact.integrityStatus !== "READY" ||
      !artifact.sha256
    ) {
      throw new DomainValidationError("参考视频文件不可用");
    }
    if (
      artifact.mimeType !== "video/mp4" &&
      artifact.mimeType !== "video/quicktime"
    ) {
      throw new DomainValidationError("参考视频当前只支持 MP4 / MOV");
    }

    const projectRoot = path.resolve(this.projectsRoot, input.projectId);
    const store = new LocalArtifactStore(projectRoot, this.artifacts);
    const videoPath = store.resolveArtifactPath(artifact.relativePath);
    await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,artifact.id,artifact.sha256,["video/mp4","video/quicktime"]);
    // Reuse this project's verified current analysis, never another project's file or an unobserved historical profile.
    const cached=(await this.repo.listProfiles(input.projectId)).find(p=>p.status==="ACTIVE"&&p.videoArtifactHash===artifact.sha256);
    if(cached&&cached.observation?.version!=="reference-observation-v3")throw new DomainValidationError("历史分析没有实际帧时间戳证明；保留历史，需用户确认重新分析，不自动重提模型请求");
    if(cached){await this.assertCurrentEvidence(cached,input.projectId);return cached;}
    const mediaInfo = await this.media.probeReferenceVideo(videoPath);
    const tempDir = path.join(
      projectRoot,
      ".tmp",
      "reference-video-analysis",
      randomUUID()
    );

    try {
      if (referenceVideoNeedsBrowserPreview(mediaInfo)) {
        const previewRelativePath =
          referenceVideoBrowserPreviewRelativePath(artifact.sha256);
        const existingPreview = (
          await this.artifacts.listByProject(input.projectId, "OTHER")
        ).find(
          (item) =>
            item.relativePath === previewRelativePath &&
            item.integrityStatus === "READY" &&
            item.mimeType === "video/mp4"
        );
        if(existingPreview){await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,existingPreview.id,existingPreview.sha256??"",["video/mp4"]);}
        if (!existingPreview) {
          const previewPath = path.join(
            tempDir,
            "browser-preview.mp4"
          );
          await this.media.createReferenceVideoBrowserPreview({
            filePath: videoPath,
            outputPath: previewPath
          });
          const previewBytes = await fs.readFile(previewPath);
          await store.writeImmutable({
            id: randomUUID(),
            projectId: input.projectId,
            kind: "OTHER",
            relativePath: previewRelativePath,
            immutable: true,
            mimeType: "video/mp4",
            bytes: previewBytes
          });
        }
      }

      const sampledFrames = await this.media.sampleReferenceFrames({
        filePath: videoPath,
        outputDir: tempDir,
        durationMs: mediaInfo.durationMs,
        maxFrames: 10
      });
      const frameEvidence:NonNullable<ReferenceVideoProfile["observation"]>["frames"]=[];
      if(!sampledFrames.length||sampledFrames.length>10||sampledFrames.some((f,i)=>f.mimeType!=="image/jpeg"||!Number.isSafeInteger(f.timestampMs)||f.timestampMs<0||f.timestampMs>=mediaInfo.durationMs||(i>0&&f.timestampMs<=sampledFrames[i-1]!.timestampMs)))evidenceDenied();
      const media = [];
      for(const frame of sampledFrames){const bytes=await fs.readFile(frame.path),sha256=sha256Bytes(bytes),key=hashValue({projectId:input.projectId,source:artifact.sha256,timestampMs:frame.timestampMs,sha256});
        let saved=await this.artifacts.findById("reference-frame:"+key);
        if(!saved)saved=await store.writeImmutable({id:"reference-frame:"+key,projectId:input.projectId,kind:"OTHER",relativePath:"reference-video/evidence/"+key+".jpg",bytes,mimeType:"image/jpeg",immutable:true});
        const verified=await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,saved.id,sha256,["image/jpeg"],16*1024*1024);
        frameEvidence.push({artifactId:saved.id,sha256,timestampMs:frame.timestampMs});
        media.push({
          type: "image" as const,
          mimeType: frame.mimeType,
          dataBase64: verified.toString("base64"),
          label: "sample@" + frame.timestampMs + "ms"
        });
      }
      const observedMedia={durationMs:mediaInfo.durationMs,...(mediaInfo.width?{width:mediaInfo.width}:{}),...(mediaInfo.height?{height:mediaInfo.height}:{}),...(mediaInfo.frameRate?{frameRate:mediaInfo.frameRate}:{}),hasAudio:mediaInfo.hasAudio,sampledFrameCount:frameEvidence.length,sceneCutTimestampsMs:mediaInfo.sceneCutTimestampsMs};
      const manifestBytes=Buffer.from(JSON.stringify(samplingManifest(input.projectId,{artifactId:artifact.id,sha256:artifact.sha256},observedMedia,frameEvidence)));
      const manifestHash=sha256Bytes(manifestBytes),manifestId="reference-sampling:"+manifestHash;
      if(!await this.artifacts.findById(manifestId))await store.writeImmutable({id:manifestId,projectId:input.projectId,kind:"OTHER",relativePath:"reference-video/evidence/"+manifestHash+".json",bytes:manifestBytes,mimeType:"application/json",immutable:true});
      const manifestRef={artifactId:manifestId,sha256:manifestHash};
      const verifyInputs=async()=>{
        await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,artifact.id,artifact.sha256!,["video/mp4","video/quicktime"]);
        for(const frame of frameEvidence)await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,frame.artifactId,frame.sha256,["image/jpeg"],16*1024*1024);
        await readReferenceEvidence(this.artifacts,this.projectsRoot,input.projectId,manifestId,manifestHash,["application/json"],65536);
      };
      await verifyInputs();
      const generation = await generateStructuredJson(this.runtime, {
        task:
          "Analyze a reference marketing video into a reusable ReferenceVideoProfile for a new, original product video.",
        instructions: [
          "所有可读分析字段必须使用简体中文输出；只有无法自然翻译的必要技术名词可保留英文。",
          "Analyze structure and production method only.",
          "Do not reproduce or quote source dialogue, captions, slogans, shot descriptions, character identity, brand-specific expression, or copyrighted creative wording.",
          "Describe the first-three-second hook by function and pattern, not by copying its content.",
          "Use sampled frames and local media metadata as evidence. If audio semantics cannot be reliably observed, say so instead of inventing dialogue or lyrics.",
          "This request includes images only: audio has NOT been sent or observed. Do not infer any spoken words, music or sound semantics from the existence of an audio track.",
          "frameObservations must cite only the supplied exact timestampMs. OCR is limited to text actually readable in those frames, at most 100 characters per frame; uncertain text stays uncertain. Never turn visible captions into an audio transcript.",
          "estimatedShotCount may use local scene-cut timestamps as a lower-bound clue, but sampled frames are not every source frame.",
          "Product facts from the reference video are not Product Truth and must not be inferred into factual claims.",
          "Return concise reusable principles that Creative, Script and Director can adapt to a different product."
        ].join(" "),
        input: {
          sourceVideo: {
            artifactId: artifact.id,
            sha256: artifact.sha256,
            originalFilename: input.originalFilename,
            relativePath: artifact.relativePath,
            durationMs: mediaInfo.durationMs,
            width: mediaInfo.width,
            height: mediaInfo.height,
            frameRate: mediaInfo.frameRate,
            hasAudio: mediaInfo.hasAudio,
            sceneCutTimestampsMs: mediaInfo.sceneCutTimestampsMs
          },
          sampledFrames: frameEvidence,
          observation:{samplingManifest:manifestRef,frames:frameEvidence,timing:{status:"DECODED_FRAME_PTS",origin:"FIRST_VIDEO_FRAME",precisionMs:1},audio:{status:mediaInfo.hasAudio?"NOT_OBSERVED":"NO_TRACK"},samplingIsPartial:true},
          copyPolicy: "STRUCTURE_AND_METHOD_ONLY"
        },
        media,
        outputContract: {
          analysisConfidence: "LOW|MEDIUM|HIGH",
          hook: {
            firstThreeSecondsPattern: "string",
            structuralPurpose: "string"
          },
          pacing: {
            overall: "string",
            estimatedShotCount: 8
          },
          shotLanguage: {
            shotSizes: ["string"],
            cameraPositions: ["string"],
            cameraMovements: ["string"],
            compositionPatterns: ["string"]
          },
          productAppearance: {
            firstAppearanceMs: 1000,
            visibilityPattern: "string",
            showcasePattern: "string"
          },
          sellingPointPattern: ["string"],
          dialogueNarrationStructure: "string",
          audioBgMusicStructure: "string",
          ctaPattern: "string",
          reusableStylePrinciples: ["string"],
          frameObservations:[{timestampMs:"exact supplied sample timestamp",observation:"visible structure only",visibleText:"optional readable text, at most 100 characters",confidence:"LOW|MEDIUM|HIGH",textStatus:"READABLE|UNCERTAIN|NOT_VISIBLE"}]
        },
        context: {
          projectId: input.projectId,
          step: "REFERENCE_VIDEO_ANALYSIS"
        }
      });
      await verifyInputs();
      const proposal = proposalSchema.parse(generation.data);
      if(proposal.frameObservations.some(f=>!sampledFrames.some(s=>s.timestampMs===f.timestampMs)))throw new DomainValidationError("参考视频分析引用了未实际采样的时间戳");
      if(new Set(proposal.frameObservations.map(f=>f.timestampMs)).size!==proposal.frameObservations.length)throw new DomainValidationError("参考视频同一帧出现重复识别结果，停止保存");
      const frameObservations=proposal.frameObservations.map(item=>{
        const frame=frameEvidence.find(f=>f.timestampMs===item.timestampMs)!;
        const textStatus=item.visibleText?(item.confidence==="LOW"?"UNCERTAIN":item.textStatus??"UNCERTAIN"):"NOT_VISIBLE";
        if(item.visibleText&&textStatus==="NOT_VISIBLE")throw new DomainValidationError("参考帧文字识别状态与结果冲突");
        return {...item,textStatus,frameArtifactId:frame.artifactId,frameSha256:frame.sha256};
      });
      const localShotCount =
        mediaInfo.sceneCutTimestampsMs.length > 0
          ? mediaInfo.sceneCutTimestampsMs.length + 1
          : undefined;
      const estimatedShotCount = Math.max(
        1,
        localShotCount ?? proposal.pacing.estimatedShotCount
      );
      const averageShotDurationMs = Math.max(
        1,
        Math.round(mediaInfo.durationMs / estimatedShotCount)
      );
      const version = await this.repo.nextVersion(input.projectId);
      const createdAt = new Date().toISOString();
      const profileWithoutHash: Omit<
        ReferenceVideoProfile,
        "contentHash"
      > = {
        id: randomUUID(),
        projectId: input.projectId,
        version,
        status: "ACTIVE",
        sourceType: input.sourceUrl ? "URL" : "UPLOAD",
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        videoArtifactId: artifact.id,
        videoArtifactHash: artifact.sha256,
        ...(input.originalFilename
          ? { originalFilename: input.originalFilename }
          : {}),
        media: {
          durationMs: mediaInfo.durationMs,
          ...(mediaInfo.width ? { width: mediaInfo.width } : {}),
          ...(mediaInfo.height ? { height: mediaInfo.height } : {}),
          ...(mediaInfo.frameRate ? { frameRate: mediaInfo.frameRate } : {}),
          hasAudio: mediaInfo.hasAudio,
          sampledFrameCount: sampledFrames.length,
          sceneCutTimestampsMs: mediaInfo.sceneCutTimestampsMs
        },
        analysisConfidence: proposal.analysisConfidence,
        hook: proposal.hook,
        pacing: {
          overall: proposal.pacing.overall,
          estimatedShotCount,
          averageShotDurationMs
        },
        shotLanguage: proposal.shotLanguage,
        productAppearance: proposal.productAppearance,
        sellingPointPattern: proposal.sellingPointPattern,
        dialogueNarrationStructure: mediaInfo.hasAudio
          ? "源视频有音轨，但本次只分析采样帧，未听取音频；对白/旁白语义不可观察。"
          : "源视频无音轨；没有旁白/对话结构可分析。",
        audioBgMusicStructure: mediaInfo.hasAudio
          ? "源视频有音轨，但未向模型提供音频；音乐、环境声及其语义未验证。"
          : "源视频无音轨；没有 BGM/环境声结构可分析。",
        ctaPattern: proposal.ctaPattern,
        reusableStylePrinciples: proposal.reusableStylePrinciples,
        copyGuard: "STRUCTURE_AND_METHOD_ONLY",
        observation:{version:"reference-observation-v3",sourceSha256:artifact.sha256,samplingManifest:manifestRef,frames:frameEvidence,
          timing:{status:"DECODED_FRAME_PTS",origin:"FIRST_VIDEO_FRAME",precisionMs:1},
          audio:{status:mediaInfo.hasAudio?"NOT_OBSERVED":"NO_TRACK",reason:mediaInfo.hasAudio?"本次仅发送真实采样帧；外发音频和可能收费的分析需适用许可与已配置模型能力，不自动切模型。":"文件无音轨。"},
          ocr:{status:proposal.frameObservations.some(f=>f.visibleText)?"SAMPLED_FRAMES_ONLY":"NOT_OBSERVED",reason:"仅能观察已保存采样帧，不代表全文字幕、完整视频或音频转写。"},
          frameObservations,limitations:["采样帧不是全片逐帧观察，镜头切分仅为本地检测线索。","音轨存在不代表已经听懂对白；不推导原产品事实或商业效果。","帧时间相对首个视频解码帧，按毫秒取整；采样帧文字不代表字幕出现和消失的完整时间区间。",`本次 ${frameEvidence.length} 张采样帧中 ${frameEvidence.length-frameObservations.length} 张未返回画面识别；低置信文字保留为不确定。`]},
        ...(generation.metadata
          ? { aiExecution: generation.metadata }
          : {}),
        createdAt
      };
      const profile = referenceVideoProfileSchema.parse({
        ...profileWithoutHash,
        contentHash: profileContentHash(profileWithoutHash)
      });
      await this.verifyProfileArtifacts(profile,input.projectId);
      return this.repo.saveProfile(profile);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

export function assertReferenceVideoInputBinding(profile:ReferenceVideoProfile|null|undefined,projectId:string,refs:Array<{entityId:string;version:number;hash:string}|undefined>){
  const active=profile?.status==="ACTIVE"?profile:undefined;
  if(active)referenceVideoProfileForPrompt(active,projectId);
  for(const ref of refs){
    if(ref&&(!active||ref.entityId!==active.id||ref.version!==active.version||ref.hash!==active.contentHash))throw new DomainValidationError("参考视频版本与上游输入绑定不一致，停止请求");
  }
}

export function referenceVideoProfileForPrompt(
  profile?: ReferenceVideoProfile | null,
  expectedProjectId?:string
): unknown | undefined {
  if (!profile || profile.status !== "ACTIVE") return undefined;
  if(expectedProjectId&&profile.projectId!==expectedProjectId)throw new DomainValidationError("参考视频分析不属于当前项目");
  if(profile.observation?.version==="reference-observation-v3"){
    referenceVideoProfileSchema.parse(profile);
    const {contentHash,...body}=profile;
    if(profileContentHash(body)!==contentHash)throw new DomainValidationError("参考视频分析内容哈希已失效");
  }
  return {
    profileRef: {
      entityType: "ReferenceVideoProfile",
      entityId: profile.id,
      version: profile.version,
      hash: profile.contentHash
    },
    policy: profile.copyGuard,
    hook: profile.hook,
    pacing: profile.pacing,
    shotLanguage: profile.shotLanguage,
    productAppearance: profile.productAppearance,
    sellingPointPattern: profile.sellingPointPattern,
    dialogueNarrationStructure: profile.observation?profile.dialogueNarrationStructure:"历史分析未记录音频观察证据，不将其对白描述作为已听取的语义。",
    audioBgMusicStructure: profile.observation?profile.audioBgMusicStructure:"历史分析未记录音频观察证据，音乐与环境声描述未验证。",
    ctaPattern: profile.ctaPattern,
    reusableStylePrinciples: profile.reusableStylePrinciples,
    ...(profile.observation?{observation:profile.observation.version==="reference-observation-v3"?profile.observation:{...profile.observation,timing:{status:"LEGACY_ESTIMATED"},limitations:[...profile.observation.limitations,"历史采样时间按帧号估算，尚无实际解码时间对齐证明。"]}}:{observation:{legacyUnverified:true,audio:{status:"NOT_OBSERVED"},limitations:["历史分析没有逐帧Artifact和音频观察回执；不把存在音轨当作音频语义证据。"]}})
  };
}
