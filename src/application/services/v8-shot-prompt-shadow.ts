import { hashValue } from "../../domain/hashing.js";
import type { ScriptDraft, ProductionPlan } from "../../domain/schemas.js";
import type { ProductionAssetSet } from "../../domain/production-strategy.js";
import type { DirectorV3Plan } from "../../domain/director-v3.js";

/**
 * V8 shadow compiler: mirrors the EXISTING confirmed ProductionPlan's real
 * Segments. It never sends a generation request or mutates the original Run.
 */
export type V8Issue = {
  code: string;
  level: "BLOCKER" | "REVIEW";
  clipIndex?: number;
  shotIndex?: number;
  beatId?: string;
  message: string;
};
export type V8SpeakerBinding = Record<string, string>;
export type V8ShadowInput = {
  script: ScriptDraft;
  plan: ProductionPlan;
  director?: DirectorV3Plan;
  productionAssetSet?: ProductionAssetSet;
  speakerBindings?: V8SpeakerBinding;
  format?: { aspectRatio: string; model: string; resolution?: string };
};
export type V8CompiledClip = {
  clipId: string;
  clipIndex: number;
  durationMs: number;
  promptText: string;
  sourceBeatIds: string[];
  sourceShotIds: string[];
  dialogueLines: Array<{ beatId: string; speaker: string; text: string }>;
  requiredPostProductionTexts: string[];
  missingPostProductionTexts: string[];
};
export type V8ShadowReport = {
  version: "v8-shot-shadow-1";
  status: "PASS" | "REVIEW_REQUIRED" | "BLOCKED";
  scriptHash: string;
  productionPlanHash: string;
  generatedAt: string;
  clips: V8CompiledClip[];
  issues: V8Issue[];
  coverage: {
    sourceBeatCount: number;
    coveredBeatCount: number;
    sourceDialogueCount: number;
    mappedDialogueCount: number;
    requiredTextCount: number;
    mappedTextCount: number;
  };
  contentHash: string;
};
type SpokenLine = { speaker: string; text: string };
const SPEAKER_PATTERN = /([\p{L}\p{N}_·（）()]{1,32})\s*[:：]\s*[“"]([^”"]+)[”"]/gu;
export function extractV8DialogueLines(value: string): SpokenLine[] {
  return [...value.matchAll(SPEAKER_PATTERN)].map(match => ({
    speaker: match[1]!.trim(),
    text: match[2]!.trim()
  }));
}
const extractSpokenLines = extractV8DialogueLines;
function lineKey(line: SpokenLine): string {
  return line.speaker + "\u0000" + line.text;
}
function seconds(ms: number): string {
  return (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1);
}
function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function addIssue(issues: V8Issue[], code: string, level: V8Issue["level"], message: string, clipIndex?: number, shotIndex?: number, beatId?: string): void {
  issues.push({ code, level, message, ...(clipIndex === undefined ? {} : { clipIndex }), ...(shotIndex === undefined ? {} : { shotIndex }), ...(beatId === undefined ? {} : { beatId }) });
}

/**
 * A binding is an explicit user/producer decision. Never infer a character's
 * identity by ordering reference photos: a two-person video can swap voices.
 */
export function compileV8ShotShadow(input: V8ShadowInput): V8ShadowReport {
  const issues: V8Issue[] = [];
  const beatById = new Map(input.script.beats.map(beat => [beat.id, beat]));
  const actorByKey = new Map(
    (input.productionAssetSet?.entries ?? [])
      .filter(entry => entry.kind === "CHARACTER" && entry.status === "READY")
      .map(entry => [entry.key, entry])
  );
  const bindings = input.speakerBindings ?? {};
  const allSegments = input.plan.scenes.flatMap(scene => scene.clips.flatMap(clip => clip.segments));
  const productionClips = input.plan.scenes.flatMap(scene => scene.clips.map(clip => ({ scene, clip })));
  const expectedSpeech = input.script.beats.flatMap(beat => {
    const dialogue = beat.videoIntent?.dialogue ?? "";
    const os = beat.videoIntent?.os ?? "";
    return [
      ...extractSpokenLines(dialogue).map(line => ({ ...line, beatId: beat.id })),
      ...(os ? [{ speaker: "OS", text: os, beatId: beat.id }] : [])
    ];
  });
  const actualSpeech: Array<{ speaker: string; text: string; beatId: string }> = [];
  const coveredOs = new Set<string>();
  const semanticParts = new Map<string, { nextIndex: number; partCount: number; assembled: string }>();
  // Independent, order-aware proof of split speech. No isolated fragment is
  // credited as a complete source line until all parts reconstruct the original.
  const consumePart = (
    beatId: string, speaker: string, original: string, part: string,
    index: number, count: number, mode: "DIALOGUE" | "OS"
  ): boolean => {
    const key = JSON.stringify([beatId, speaker, original, mode]);
    const pending = semanticParts.get(key);
    if (!Number.isInteger(index) || !Number.isInteger(count) ||
        index < 1 || count < 1 || index > count ||
        (pending && (pending.nextIndex !== index || pending.partCount !== count)) ||
        (!pending && index !== 1)) {
      addIssue(issues, "DIALOGUE_PART_ORDER", "BLOCKER",
        "原句跨镜语义段缺失、重复或顺序错误：" + speaker, undefined, undefined, beatId);
      return false;
    }
    const assembled = (pending?.assembled ?? "") + part;
    if (index < count) {
      semanticParts.set(key, { nextIndex: index + 1, partCount: count, assembled });
      return false;
    }
    semanticParts.delete(key);
    if (assembled !== original) {
      addIssue(issues, "DIALOGUE_PART_LOSS", "BLOCKER",
        "拆分后的台词无法逐字还原原句：" + speaker, undefined, undefined, beatId);
      return false;
    }
    return true;
  };
  const beatCoverage = new Set<string>();
  const requiredCues = input.script.beats.flatMap(beat =>
    (beat.videoIntent?.postProductionText ?? []).map(text => ({ beatId: beat.id, text }))
  );
  const plannedCues = allSegments.flatMap(segment =>
    segment.postProductionText.map(cue => ({ sourceBeatIds: cue.sourceBeatIds, text: cue.text }))
  );
  const noDuplicateCues = unique(requiredCues.map(item => item.beatId + "\u0000" + item.text));
  const mappedCues = noDuplicateCues.filter(key => {
    const pos = key.indexOf("\u0000");
    const beatId = key.slice(0, pos);
    const text = key.slice(pos + 1);
    return plannedCues.some(cue => cue.text === text && cue.sourceBeatIds.includes(beatId));
  });
  for (const key of noDuplicateCues) {
    if (!mappedCues.includes(key)) {
      const [beatId, ...value] = key.split("\u0000");
      addIssue(issues, "POST_PRODUCTION_CUE_MISSING", "BLOCKER",
        "剧本后期文字未在正式分镜中安排： " + value.join(""), undefined, undefined, beatId);
    }
  }

  if (input.plan.scriptRef.hash !== input.script.contentHash ||
      input.plan.scriptRef.entityId !== input.script.id ||
      input.plan.scriptRef.version !== input.script.version) {
    addIssue(issues, "PLAN_SCRIPT_VERSION_MISMATCH", "BLOCKER", "正式分镜与剧本引用的版本或哈希不一致");
  }
  if (input.director && (input.director.scriptRef.hash !== input.script.contentHash ||
      input.director.clipContracts.length !== productionClips.length)) {
    addIssue(issues, "DIRECTOR_CONTRACT_DRIFT", "BLOCKER", "Director V3 与正式分镜的版本或视频编号不匹配");
  }
  const clips: V8CompiledClip[] = [];
  for (const [index, { scene, clip }] of productionClips.entries()) {
    const clipNumber = index + 1;
    const contract = input.director?.clipContracts[index];
    if (contract && (contract.durationMs !== clip.durationMs ||
        contract.sourceBeatIds.join(",") !== clip.sourceBeatIds.join(","))) {
      addIssue(issues, "CLIP_CONTRACT_DRIFT", "BLOCKER", "视频编号与 Director 合同不一致", clipNumber);
    }
    const startState = clip.openingState;
    const selectedActorAssets = clip.referenceAssets
      .filter(ref => ref.role === "CHARACTER")
      .map(ref => (input.productionAssetSet?.entries ?? []).find(entry => entry.referenceAssetId === ref.assetId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const lines = [
      "【项目规格】",
      "画幅：" + (input.format?.aspectRatio ?? input.plan.generationTarget?.aspectRatio ?? "以项目设置为准"),
      "模型：" + (input.format?.model ?? input.plan.generationTarget?.requestedModelVersion ?? "以项目设置为准"),
      "分辨率：" + (input.format?.resolution ?? input.plan.generationTarget?.videoResolution ?? "以模型能力为准"),
      "视觉类型：按已确认剧本和参考素材，不改变角色与产品身份",
      "",
      "【全局视觉】",
      input.plan.visualDirection,
      "全片不生成背景音乐；无字幕、可读文字、水印或无关 UI；对白和必要环境声保留，后期文案独立制作。",
      "",
      "【视频编号 " + String(clipNumber).padStart(2, "0") + "】",
      "总时长：" + seconds(clip.durationMs) + " 秒",
      "剧情任务：" + clip.purpose,
      "【场景与连续状态】",
      "地点：" + (scene.location ?? contract?.location ?? "原剧本所在场景"),
      "本段开始：" + startState.description,
      "人物与道具位置：" + startState.environmentState,
      "产品开始状态：" + startState.productState,
      "本段结束：" + clip.closingState.description,
      "结束位置与环境：" + clip.closingState.environmentState,
      "",
      "【光线】",
      clip.segments[0]?.lighting ?? "以已确认场景与光源为准",
      "",
      "【出场人物及配音绑定】"
    ];
    if (selectedActorAssets.length === 0) lines.push("本段无可确认的固定角色参考，具体身份需审核。");
    for (const actor of selectedActorAssets) {
      const assignedNames = Object.entries(bindings).filter(([, key]) => key === actor.key).map(([name]) => name);
      lines.push("角色资产：" + actor.label + "（" + actor.key + "），" +
        (assignedNames.length ? "对应角色：" + assignedNames.join("、") : "尚未绑定剧本角色名称，必须先核对") +
        "；参考图只锁定外观身份，不固定参考图姿势。");
    }
    const clipSpeech: V8CompiledClip["dialogueLines"] = [];
    for (const [shotIndex, segment] of clip.segments.entries()) {
      const shotNumber = shotIndex + 1;
      for (const beatId of segment.sourceBeatIds) {
        if (!beatById.has(beatId)) {
          addIssue(issues, "UNKNOWN_SOURCE_BEAT", "BLOCKER", "分镜引用的剧本 Beat 不存在", clipNumber, shotNumber, beatId);
        } else beatCoverage.add(beatId);
      }
      lines.push("",
        "【镜头 " + String(shotNumber).padStart(2, "0") + "】 " +
          seconds(segment.endMs - segment.startMs) + "s（" +
          seconds(segment.startMs) + "–" + seconds(segment.endMs) + "s）",
        "镜头目的：" + clip.purpose,
        "景别、角度与运镜：" + [segment.shotSize, segment.cameraAngle, segment.cameraMovement].join("；"),
        "构图与焦点：" + segment.composition,
        "画面动作：" + segment.subjectAction,
        "场内人物及物件承接：" + segment.continuityIn.environmentState,
        "产品状态：" + segment.productState,
        "光线：" + segment.lighting);
      if (segment.dialogueOrNarration.kind === "DIALOGUE") {
        const locked = segment.v8?.spoken;
        const split = Boolean(locked && locked.sourcePartCount && locked.sourcePartCount > 1);
        if (split && (!locked?.sourceLineText || !locked.sourcePartIndex || locked.mode === "OS")) {
          addIssue(issues, "DIALOGUE_PART_METADATA_MISSING", "BLOCKER",
            "跨镜台词缺少原句或语义段标识", clipNumber, shotNumber);
        }
        const separated = split && locked
          ? [{ speaker: locked.speaker, text: locked.exactText }]
          : extractSpokenLines(segment.dialogueOrNarration.text);
        if (split && locked) {
          // A split V8 Shot has exactly one actor/fragment. Check its actual
          // rendered text instead of trusting only optional director metadata.
          const captured = /^\s*([^：“"：]{1,40})\s*[:：]\s*[“"]([^”"]+)[”"]\s*$/u
            .exec(segment.dialogueOrNarration.text);
          if (!captured || captured[1]!.trim() !== locked.speaker ||
              captured[2] !== locked.exactText) {
            addIssue(issues, "DIALOGUE_FRAGMENT_DRIFT", "BLOCKER",
              "分镜文字与 V8 已锁定的分句不一致", clipNumber, shotNumber);
          }
        }
        if (!separated.length) {
          addIssue(issues, "DIALOGUE_SPEAKER_UNPARSEABLE", "BLOCKER",
            "分镜的对白没有可确认的说话人和完整原文", clipNumber, shotNumber);
          lines.push("声音与台词：对白说话者待确认：" + segment.dialogueOrNarration.text);
        } else {
          for (const voice of separated) {
            const actorKey = bindings[voice.speaker];
            const actor = actorKey ? actorByKey.get(actorKey) : undefined;
            if (!actor) {
              addIssue(issues, "SPEAKER_ASSET_UNBOUND", "BLOCKER",
                "对白角色“" + voice.speaker + "”没有经过确认的演员资产和配音绑定", clipNumber, shotNumber);
            }
            const sourceBeatIds = segment.sourceBeatIds;
            const sourceText = split && locked?.sourceLineText
              ? locked.sourceLineText : voice.text;
            const matchingBeat = sourceBeatIds.find(beatId => {
              const beat = beatById.get(beatId);
              return Boolean(beat?.videoIntent?.dialogue && extractSpokenLines(beat.videoIntent.dialogue)
                .some(line => lineKey(line) === lineKey({speaker:voice.speaker,text:sourceText})));
            });
            if (!matchingBeat) {
              addIssue(issues, "DIALOGUE_NOT_IN_SOURCE", "BLOCKER",
                "分镜对白不属于当前镜头关联的剧本原句：" + voice.speaker, clipNumber, shotNumber);
            } else {
              if (split && locked?.sourcePartIndex && locked.sourcePartCount) {
                if (consumePart(matchingBeat, voice.speaker, sourceText, voice.text,
                    locked.sourcePartIndex, locked.sourcePartCount, "DIALOGUE")) {
                  actualSpeech.push({ speaker:voice.speaker, text:sourceText, beatId:matchingBeat });
                }
              } else {
                actualSpeech.push({ ...voice, beatId: matchingBeat });
              }
              clipSpeech.push({ ...voice, beatId: matchingBeat });
            }
            lines.push("声音与台词：配音指令：" + voice.speaker + "|" +
              (actor ? "保持同一角色声线" : "声线待审核") +
              "|依剧本情绪自然表演|咬字清楚/正常语速/完整尾音；" +
              voice.speaker + "开口说：“" + voice.text + "”");
          }
        }
      } else if (segment.dialogueOrNarration.kind === "NARRATION") {
        const spoken = segment.v8?.spoken;
        if (spoken?.mode === "OS" && (spoken.sourcePartCount ?? 1) > 1) {
          if (!spoken.sourceLineText || !spoken.sourcePartIndex || !spoken.sourcePartCount) {
            addIssue(issues, "OS_PART_METADATA_MISSING", "BLOCKER",
              "跨镜 OS 缺少原句或语义段标识", clipNumber, shotNumber);
          } else {
            const matchingBeat = segment.sourceBeatIds.find(id =>
              beatById.get(id)?.videoIntent?.os === spoken.sourceLineText);
            if (!matchingBeat) {
              addIssue(issues, "OS_NOT_IN_SOURCE", "BLOCKER",
                "本镜跨镜 OS 不属于原剧本", clipNumber, shotNumber);
            } else if (segment.dialogueOrNarration.text !== spoken.exactText) {
              addIssue(issues, "OS_FRAGMENT_DRIFT", "BLOCKER",
                "本镜 OS 与已锁定的原句语义段不同", clipNumber, shotNumber);
            } else if (consumePart(matchingBeat, spoken.speaker, spoken.sourceLineText,
                spoken.exactText, spoken.sourcePartIndex, spoken.sourcePartCount, "OS")) {
              coveredOs.add(matchingBeat);
            }
          }
        }
        lines.push("声音与台词：明确旁白：“" + segment.dialogueOrNarration.text + "”");
      } else {
        lines.push("声音与台词：本镜无台词；保留必要环境声与物理音效。");
      }
      lines.push("环境及交互声：" +
        (segment.ambientSound.kind === "NONE" ? "无额外声效" : segment.ambientSound.description),
        "镜头结束承接：" + segment.continuityOut.description + "；" + segment.continuityOut.environmentState);
    }
    const missing = requiredCues.filter(item => clip.sourceBeatIds.includes(item.beatId) &&
      !plannedCues.some(cue => cue.text === item.text && cue.sourceBeatIds.includes(item.beatId)))
      .map(item => item.text);
    lines.push("", "【后期字幕及画外文案（不得烧入视频画面）】");
    const cueLines = clip.segments.flatMap(segment => segment.postProductionText.map(cue =>
      seconds(cue.startMs) + "–" + seconds(cue.endMs) + "秒，" + cue.kind + "：" + cue.text));
    lines.push(...(cueLines.length ? cueLines : ["本段正式分镜未安排后期文案。"]));
    if (missing.length) lines.push("待排布的剧本后期文案：" + unique(missing).join("、") + "（需审查位置及时间后才能正式采用）");
    lines.push("", "【本视频编号完整性约束】",
      "只能发生上述剧本动作；保持已确认演员、道具、产品和场景的连续性，不新增事件、台词或未证实功效。");
    clips.push({
      clipId: clip.id, clipIndex: clipNumber, durationMs: clip.durationMs,
      promptText: lines.join("\n"),
      sourceBeatIds: [...clip.sourceBeatIds],
      sourceShotIds: clip.segments.map(segment => segment.id),
      dialogueLines: clipSpeech,
      requiredPostProductionTexts: requiredCues.filter(item => clip.sourceBeatIds.includes(item.beatId)).map(item => item.text),
      missingPostProductionTexts: unique(missing)
    });
  }
  for (const key of semanticParts.keys()) {
    addIssue(issues, "DIALOGUE_PART_INCOMPLETE", "BLOCKER",
      "原句跨镜语义段不完整，禁止将片段当作一整句通过：" + key);
  }
  for (const beat of input.script.beats) {
    if (!beatCoverage.has(beat.id)) addIssue(issues, "BEAT_NOT_STORYBOARDED", "BLOCKER", "剧本 Beat 未被分镜覆盖", undefined, undefined, beat.id);
  }
  const consumed = new Map<string, number>();
  for (const item of actualSpeech) {
    const key = item.beatId + "\u0000" + lineKey(item);
    consumed.set(key, (consumed.get(key) ?? 0) + 1);
  }
  for (const item of expectedSpeech.filter(line => line.speaker !== "OS")) {
    const key = item.beatId + "\u0000" + lineKey(item);
    if ((consumed.get(key) ?? 0) !== 1) {
      addIssue(issues, "SCRIPT_DIALOGUE_COVERAGE", "BLOCKER",
        "原剧本对白在分镜中遗漏或重复：" + item.speaker + "：" + item.text, undefined, undefined, item.beatId);
    }
  }
  // If a beat contains OS, it must also be represented, never silently omitted.
  for (const beat of input.script.beats.filter(item => item.videoIntent?.os)) {
    if (!coveredOs.has(beat.id) && !allSegments.some(segment => segment.sourceBeatIds.includes(beat.id) &&
        segment.dialogueOrNarration.kind === "NARRATION" &&
        segment.dialogueOrNarration.text === beat.videoIntent!.os)) {
      addIssue(issues, "OS_NOT_STORYBOARDED", "BLOCKER", "剧本 OS 未被分镜准确保留", undefined, undefined, beat.id);
    }
  }
  if (productionClips.length > 0) {
    const sum = productionClips.reduce((total, row) => total + row.clip.durationMs, 0);
    if (sum !== input.script.targetDurationMs) {
      addIssue(issues, "CLIP_DURATION_MISMATCH", "BLOCKER",
        "全部视频编号时长与剧本目标时长不一致");
    }
  }
  const report = {
    version: "v8-shot-shadow-1" as const,
    status: (issues.some(issue => issue.level === "BLOCKER") ? "BLOCKED" :
      issues.length ? "REVIEW_REQUIRED" : "PASS") as V8ShadowReport["status"],
    scriptHash: input.script.contentHash,
    productionPlanHash: input.plan.contentHash,
    generatedAt: new Date().toISOString(),
    clips, issues,
    coverage: {
      sourceBeatCount: input.script.beats.length,
      coveredBeatCount: beatCoverage.size,
      sourceDialogueCount: expectedSpeech.filter(item => item.speaker !== "OS").length,
      mappedDialogueCount: actualSpeech.length,
      requiredTextCount: noDuplicateCues.length,
      mappedTextCount: mappedCues.length
    }
  };
  return { ...report, contentHash: hashValue(report) };
}
