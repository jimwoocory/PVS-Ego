import { randomUUID } from "node:crypto";
import {
  type DirectorGenerationTarget,
  type ScriptDraft,
  scriptDraftSchema
} from "../../domain/schemas.js";
import {
  DIRECTOR_V3_VERSION,
  directorV3PlanSchema,
  type DirectorV3ClipContract,
  type DirectorV3Plan
} from "../../domain/director-v3.js";
import { hashValue } from "../../domain/hashing.js";
import { isScriptDurationWithinTolerance } from "./script-narrative-timing.js";
import { DomainValidationError } from "../../domain/validation.js";

type Beat = ScriptDraft["beats"][number];

type BeatGroup = {
  beats: Beat[];
  estimatedMs: number;
};

function locationOf(beat: Beat): string {
  return beat.videoIntent?.location?.trim() || "未指定场景";
}

function isNoProductRole(value: string | undefined): boolean {
  return Boolean(
    value &&
      /(?:不出现|无产品|未出现|未入画|不入画|产品未出|产品不出)/.test(
        value
      )
  );
}

function actionParts(beat: Beat): number {
  const text = beat.videoIntent?.storyAction ?? beat.text;
  const pieces = text
    .split(/(?:，|,|、|；|;|然后|随后|接着|再|并且|并|→|->)/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Math.max(1, pieces.length);
}

function productStateChange(beat: Beat): number {
  if (!beat.videoIntent) return 0;
  if (isNoProductRole(beat.videoIntent.productRole)) return 0;
  if (
    beat.videoIntent.productStateIn &&
    beat.videoIntent.productStateOut
  ) {
    return beat.videoIntent.productStateIn ===
      beat.videoIntent.productStateOut
      ? 0
      : 1;
  }
  const text = beat.videoIntent.storyAction + " " + beat.text;
  return Number(
    /(?:产品.{0,10}(?:翻面|拆开|打开|内胆|填充|分层|闭合|封口|平铺)|(?:拆开产品|打开产品|打开外罩|拉开内胆|展示内胆))/.test(text)
  );
}

function groupComplexity(group: BeatGroup) {
  return {
    actions: group.beats.reduce(
      (sum, beat) => sum + actionParts(beat),
      0
    ),
    productStateChanges: group.beats.reduce(
      (sum, beat) => sum + productStateChange(beat),
      0
    )
  };
}

function commonBounds(target: DirectorGenerationTarget) {
  const constraints = target.operationConstraints.filter(
    (item) =>
      item.operation === "text2video" ||
      item.operation === "multimodal2video"
  );
  if (!constraints.length) {
    throw new DomainValidationError(
      "Director V3 找不到可用的 Seedance 文生/参考视频能力"
    );
  }
  const minimums = constraints
    .map((item) => item.durationMinSeconds)
    .filter((value): value is number => value !== undefined);
  const maximums = constraints
    .map((item) => item.durationMaxSeconds)
    .filter((value): value is number => value !== undefined);
  if (
    minimums.length !== constraints.length ||
    maximums.length !== constraints.length
  ) {
    throw new DomainValidationError(
      "Director V3 当前模型能力缺少明确的单段时长边界"
    );
  }
  const minSeconds = Math.max(...minimums);
  const maxSeconds = Math.min(...maximums);
  if (
    !Number.isInteger(minSeconds) ||
    !Number.isInteger(maxSeconds) ||
    minSeconds <= 0 ||
    maxSeconds < minSeconds
  ) {
    throw new DomainValidationError(
      "Director V3 模型时长能力无效"
    );
  }
  return { minSeconds, maxSeconds };
}

function initialGroups(script: ScriptDraft): BeatGroup[] {
  const groups: BeatGroup[] = [];
  for (const beat of script.beats) {
    const current = groups.at(-1);
    const candidate: BeatGroup = current
      ? {
          beats: [...current.beats, beat],
          estimatedMs:
            current.estimatedMs + beat.estimatedDurationMs
        }
      : {
          beats: [beat],
          estimatedMs: beat.estimatedDurationMs
        };
    const complexity = groupComplexity(candidate);
    const dynamicActionBudget = Math.max(
      2,
      Math.min(
        4,
        Math.floor(candidate.estimatedMs / 1800)
      )
    );
    const sameLocation =
      !current ||
      locationOf(current.beats[0]!) === locationOf(beat);
    const canJoin =
      Boolean(current) &&
      sameLocation &&
      current!.beats.length < 2 &&
      complexity.actions <= dynamicActionBudget &&
      complexity.productStateChanges <= 2;
    if (canJoin) {
      groups[groups.length - 1] = candidate;
    } else {
      groups.push({
        beats: [beat],
        estimatedMs: beat.estimatedDurationMs
      });
    }
  }
  return groups;
}

function mergeSmallestBoundary(groups: BeatGroup[]) {
  if (groups.length <= 1) return;
  let bestIndex = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let i = 0; i < groups.length - 1; i += 1) {
    const left = groups[i]!;
    const right = groups[i + 1]!;
    const sameLocation =
      locationOf(left.beats[0]!) ===
      locationOf(right.beats[0]!);
    const merged: BeatGroup = {
      beats: [...left.beats, ...right.beats],
      estimatedMs: left.estimatedMs + right.estimatedMs
    };
    const complexity = groupComplexity(merged);
    const penalty =
      (sameLocation ? 0 : 100) +
      complexity.actions * 4 +
      complexity.productStateChanges * 8;
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestIndex = i;
    }
  }
  const left = groups[bestIndex]!;
  const right = groups[bestIndex + 1]!;
  groups.splice(bestIndex, 2, {
    beats: [...left.beats, ...right.beats],
    estimatedMs: left.estimatedMs + right.estimatedMs
  });
}

function splitLargestMultiBeat(groups: BeatGroup[]): boolean {
  let selected = -1;
  let largest = -1;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    if (
      group.beats.length > 1 &&
      group.estimatedMs > largest
    ) {
      selected = i;
      largest = group.estimatedMs;
    }
  }
  if (selected < 0) return false;
  const group = groups[selected]!;
  const pivot = Math.ceil(group.beats.length / 2);
  const left = group.beats.slice(0, pivot);
  const right = group.beats.slice(pivot);
  groups.splice(
    selected,
    1,
    {
      beats: left,
      estimatedMs: left.reduce(
        (sum, beat) => sum + beat.estimatedDurationMs,
        0
      )
    },
    {
      beats: right,
      estimatedMs: right.reduce(
        (sum, beat) => sum + beat.estimatedDurationMs,
        0
      )
    }
  );
  return true;
}

function normalizeDurations(
  groups: BeatGroup[],
  targetMs: number,
  minSeconds: number,
  maxSeconds: number
): number[] {
  const targetSeconds = targetMs / 1000;
  if (!Number.isInteger(targetSeconds)) {
    throw new DomainValidationError(
      "Director V3 目前要求项目总时长为整秒"
    );
  }
  while (
    groups.length > 1 &&
    groups.length * minSeconds > targetSeconds
  ) {
    mergeSmallestBoundary(groups);
  }
  while (groups.length * maxSeconds < targetSeconds) {
    if (!splitLargestMultiBeat(groups)) {
      throw new DomainValidationError(
        "Director V3 需要更多剧情 Beat 才能在当前模型单段时长限制内覆盖总时长"
      );
    }
  }
  if (
    groups.length * minSeconds > targetSeconds ||
    groups.length * maxSeconds < targetSeconds
  ) {
    throw new DomainValidationError(
      "Director V3 无法在当前模型时长边界内分配 Clip"
    );
  }

  const totalWeight = groups.reduce(
    (sum, group) => sum + Math.max(1, group.estimatedMs),
    0
  );
  const values = groups.map((group) => {
    const raw =
      (Math.max(1, group.estimatedMs) / totalWeight) *
      targetSeconds;
    return Math.min(
      maxSeconds,
      Math.max(minSeconds, Math.round(raw))
    );
  });
  let delta =
    targetSeconds - values.reduce((sum, value) => sum + value, 0);
  while (delta !== 0) {
    let changed = false;
    const order = values
      .map((value, index) => ({
        index,
        room:
          delta > 0
            ? maxSeconds - value
            : value - minSeconds,
        weight: groups[index]!.estimatedMs
      }))
      .filter((item) => item.room > 0)
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          b.room - a.room ||
          a.index - b.index
      );
    for (const item of order) {
      if (delta === 0) break;
      values[item.index]! += delta > 0 ? 1 : -1;
      delta += delta > 0 ? -1 : 1;
      changed = true;
    }
    if (!changed) {
      throw new DomainValidationError(
        "Director V3 Clip 时长无法归一化到模型整秒限制"
      );
    }
  }
  return values.map((seconds) => seconds * 1000);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function cameraFor(beats: Beat[]) {
  const productHeavy = beats.some((beat) =>
    ["PRODUCT", "FEATURE", "PROOF", "RESULT"].includes(
      beat.purpose
    )
  );
  return productHeavy
    ? {
        shotSize: "近景到中近景",
        position: "围绕产品与手部的稳定机位",
        angle: "轻俯视",
        movement: "固定机位或单一轻跟随，不做复杂运镜"
      }
    : {
        shotSize: "中景",
        position: "人物动作与环境关系清晰的稳定机位",
        angle: "平视略俯",
        movement: "单一轻跟随，不做复杂运镜"
      };
}

function actionsFor(
  beats: Beat[],
  durationMs: number
): DirectorV3ClipContract["actions"] {
  const total = beats.reduce(
    (sum, beat) => sum + beat.estimatedDurationMs,
    0
  );
  let cursor = 0;
  return beats.map((beat, index) => {
    const isLast = index === beats.length - 1;
    const endMs = isLast
      ? durationMs
      : Math.max(
          cursor + 500,
          Math.min(
            durationMs - 500 * (beats.length - index - 1),
            Math.round(
              (
                cursor +
                durationMs *
                  (beat.estimatedDurationMs / Math.max(1, total))
              ) /
                100
            ) * 100
          )
        );
    const action = {
      order: index + 1,
      startMs: cursor,
      endMs,
      description:
        beat.videoIntent?.storyAction ?? beat.text,
      ...(beat.videoIntent?.productRole &&
      !isNoProductRole(beat.videoIntent.productRole)
        ? {
            productState:
              beat.videoIntent.productStateOut ??
              beat.videoIntent.stateOut
          }
        : {})
    };
    cursor = endMs;
    return action;
  });
}

function contractFor(
  group: BeatGroup,
  order: number,
  durationMs: number
): DirectorV3ClipContract {
  const first = group.beats[0]!;
  const last = group.beats.at(-1)!;
  const audioBeats = group.beats.map(
    (beat) => beat.videoIntent
  );
  const dialogueOrOs = group.beats.flatMap((beat) => {
    const items: Array<{
      kind: "DIALOGUE" | "OS";
      text: string;
    }> = [];
    if (beat.videoIntent?.dialogue) {
      items.push({
        kind: "DIALOGUE",
        text: beat.videoIntent.dialogue
      });
    }
    if (beat.videoIntent?.os) {
      items.push({
        kind: "OS",
        text: beat.videoIntent.os
      });
    }
    return items;
  });
  const productStateChanges = unique(
    group.beats.flatMap((beat) => {
      const intent = beat.videoIntent;
      if (!intent || isNoProductRole(intent.productRole)) {
        return [];
      }
      if (intent.productStateIn && intent.productStateOut) {
        if (intent.productStateIn === intent.productStateOut) {
          return [];
        }
        return [
          intent.productStateIn +
            " → " +
            intent.productStateOut
        ];
      }
      const text = intent.storyAction + " " + beat.text;
      if (
        !/(?:产品.{0,10}(?:翻面|拆开|打开|内胆|填充|分层|闭合|封口|平铺)|(?:拆开产品|打开产品|打开外罩|拉开内胆|展示内胆))/.test(text)
      ) {
        return [];
      }
      return [
        intent.stateIn +
          " → " +
          intent.stateOut
      ];
    })
  );
  return {
    id: randomUUID(),
    order,
    sourceBeatIds: group.beats.map((beat) => beat.id),
    purpose: group.beats
      .map((beat) => beat.text)
      .join("；"),
    location: locationOf(first),
    durationMs,
    openingState:
      first.videoIntent?.stateIn ??
      "延续上一段故事状态",
    closingState:
      last.videoIntent?.stateOut ??
      "完成当前故事动作",
    actions: actionsFor(group.beats, durationMs),
    camera: cameraFor(group.beats),
    referenceAssetIds: [],
    productStateChanges,
    audio: {
      mode: "NATIVE",
      dialogueOrOs,
      ambience: unique(
        audioBeats.flatMap(
          (intent) => intent?.audioIntent.ambience ?? []
        )
      ),
      sfx: unique(
        audioBeats.flatMap(
          (intent) => intent?.audioIntent.sfx ?? []
        )
      ),
      bgm: false
    },
    globalConstraints: {
      preserveProductIdentity: true,
      noReadableText: true,
      noBgm: true,
      extra: []
    }
  };
}

export class DirectorV3PlannerService {
  plan(input: {
    script: ScriptDraft;
    generationTarget: DirectorGenerationTarget;
  }): DirectorV3Plan {
    const script = scriptDraftSchema.parse(input.script);
    if (script.beats.some((beat) => !beat.videoIntent)) {
      throw new DomainValidationError(
        "Director V3 要求脚本每个 Beat 都包含 videoIntent"
      );
    }
    const { minSeconds, maxSeconds } = commonBounds(
      input.generationTarget
    );
    const naturalDurationMs = script.beats.reduce(
      (sum, beat) => sum + beat.estimatedDurationMs, 0
    );
    if (!isScriptDurationWithinTolerance(script.targetDurationMs, naturalDurationMs)) {
      throw new DomainValidationError("导演分镜不能采用超出用户目标 ±10% 的剧本总时长");
    }
    // Clip models require whole-second slots. The script's content-driven sum
    // is the authority inside the user-approved ±10% window, not a forced
    // normalization back to targetDurationMs.
    const plannedDurationMs = Math.round(naturalDurationMs / 1000) * 1000;
    if (plannedDurationMs < 10000 || plannedDurationMs > 120000 ||
        !isScriptDurationWithinTolerance(script.targetDurationMs, plannedDurationMs)) {
      throw new DomainValidationError("剧本内容时长无法在用户 ±10% 范围和模型整秒时长限制下编排");
    }
    const groups = initialGroups(script);
    const durations = normalizeDurations(
      groups,
      plannedDurationMs,
      minSeconds,
      maxSeconds
    );
    const clipContracts = groups.map((group, index) =>
      contractFor(group, index + 1, durations[index]!)
    );
    const base = {
      version: DIRECTOR_V3_VERSION,
      projectId: script.projectId,
      scriptRef: {
        entityType: "ScriptDraft" as const,
        entityId: script.id,
        version: script.version,
        hash: script.contentHash
      },
      targetDurationMs: plannedDurationMs,
      clipContracts,
      createdAt: new Date().toISOString()
    };
    return directorV3PlanSchema.parse({
      ...base,
      contentHash: hashValue(base)
    });
  }
}
