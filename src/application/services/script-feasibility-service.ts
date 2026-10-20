import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  scriptDraftSchema,
  productTruthSchema,
  type CreativeBatch,
  type ProductTruth,
  type ScriptDraft
} from "../../domain/schemas.js";
import {
  DIRECTOR_V3_VERSION,
  scriptFeasibilityReportSchema,
  type ScriptFeasibilityIssue,
  type ScriptFeasibilityReport
} from "../../domain/director-v3.js";
import { hashValue } from "../../domain/hashing.js";
import { auditNarrativeTiming, isScriptDurationWithinTolerance } from "./script-narrative-timing.js";
import {
  assertFactReferences,
  DomainValidationError
} from "../../domain/validation.js";
import {
  generateStructuredJson,
  type StructuredAiRuntime
} from "../ports/structured-ai-runtime.js";

const ACTION_VERB =
  /拍|翻|切|收拾|合上|关闭|打开|揉|背|甩|离开|进入|回家|取出|拿出|托住|放下|放到|拆开|拉开|揭开|分装|摆放|排列|按压|轻压|压|捏|调整|贴近|展示|抽出|填入|封口|整理|归位|转身|起身|走|撕开|掀开|称量|注视|看向|拿起|放平/g;
const EDITING_DIRECTIVE =
  /(?:\d+(?:\.\d+)?\s*秒|硬切|快切|切到|镜头|机位|俯拍|特写|运镜|平均单镜头|字幕安全区)/g;
const BURNED_TEXT_DIRECTIVE =
  /(?:字幕|大字|打出|文字|画面下方|画面上方|屏幕下方|屏幕上方|字样)/g;
const PRODUCT_STATE =
  /(?:翻面|拆开|打开外罩|拉开|内胆|填充|分层|闭合|封口|拍平|压平|平铺|定帧|成品|过程态)/g;
const STRUCTURAL_PRODUCT_CHANGE =
  /(?:产品.{0,10}(?:翻面|拆开|打开|内胆|填充|分层|闭合|封口|平铺)|(?:拆开产品|打开产品|打开外罩|拉开内胆|展示内胆))/;
const SCENE_TRANSITION =
  /(?:回家|切到|转到|进入|离开|来到|从.+到|办公室|工位|卧室|床头|客厅|户外)/g;

const repairProposalSchema = z.object({
  beats: z.array(
    z.object({
      purpose: z.enum([
        "HOOK",
        "PAIN",
        "PRODUCT",
        "FEATURE",
        "PROOF",
        "RESULT",
        "CTA",
        "OTHER"
      ]),
      text: z.string().trim().min(1),
      estimatedDurationMs: z.number().int().positive(),
      requiredFactIds: z.array(z.string().trim().min(1)),
      videoIntent: z.object({
        location: z.string().trim().min(1),
        storyAction: z.string().trim().min(1),
        productRole: z.string().trim().min(1),
        stateIn: z.string().trim().min(1),
        stateOut: z.string().trim().min(1),
        productStateIn: z.string().trim().min(1).optional(),
        productStateOut: z.string().trim().min(1).optional(),
        dialogue: z.string().trim().min(1).optional(),
        os: z.string().trim().min(1).optional(),
        audioIntent: z.object({
          ambience: z.array(z.string().trim().min(1)).default([]),
          sfx: z.array(z.string().trim().min(1)).default([]),
          bgm: z.literal(false)
        }).strict(),
        postProductionText: z.array(z.string().trim().min(1)).default([])
      }).strict()
    })
  ).min(1)
});

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : pattern.flags + "g";
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

function scriptRef(script: ScriptDraft) {
  return {
    entityType: "ScriptDraft" as const,
    entityId: script.id,
    version: script.version,
    hash: script.contentHash
  };
}

function reportHash(input: Omit<ScriptFeasibilityReport, "contentHash">) {
  return hashValue(input);
}

function contentHash(value: object): string {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.contentHash;
  delete copy.confirmedAt;
  return hashValue(copy);
}

export class ScriptFeasibilityService {
  constructor(private readonly runtime: StructuredAiRuntime) {}

  review(input: ScriptDraft): ScriptFeasibilityReport {
    const script = scriptDraftSchema.parse(input);
    const joined = script.beats.map((beat) => beat.text).join("\n");
    const structuredActions = script.beats.reduce(
      (sum, beat) =>
        sum +
        countMatches(
          beat.videoIntent?.storyAction ?? beat.text,
          ACTION_VERB
        ),
      0
    );
    const locations = script.beats
      .map((beat) => beat.videoIntent?.location?.trim())
      .filter((value): value is string => Boolean(value));
    const structuredTransitions = locations.reduce(
      (count, location, index) =>
        index > 0 && locations[index - 1] !== location
          ? count + 1
          : count,
      0
    );
    const textualTransitions = countMatches(joined, SCENE_TRANSITION);
    const sceneTransitionCount = script.beats.every(
      (beat) => Boolean(beat.videoIntent?.location)
    )
      ? structuredTransitions
      : Math.max(structuredTransitions, textualTransitions);
    const productStateChanges = script.beats.reduce(
      (sum, beat) => {
        const intent = beat.videoIntent;
        if (!intent) {
          return sum + countMatches(beat.text, PRODUCT_STATE);
        }
        if (/不出现|无产品/.test(intent.productRole)) {
          return sum;
        }
        if (intent.productStateIn && intent.productStateOut) {
          return sum + Number(
            intent.productStateIn !== intent.productStateOut
          );
        }
        return sum + Number(
          STRUCTURAL_PRODUCT_CHANGE.test(
            intent.storyAction + " " + beat.text
          )
        );
      },
      0
    );
    const editingDirectiveCount = countMatches(
      joined,
      EDITING_DIRECTIVE
    );
    const burnedTextDirectiveCount = countMatches(
      joined,
      BURNED_TEXT_DIRECTIVE
    );
    const totalMs = script.beats.reduce(
      (sum, beat) => sum + beat.estimatedDurationMs,
      0
    );
    const targetSeconds = script.targetDurationMs / 1000;
    const maxBeats = Math.max(
      3,
      Math.ceil(targetSeconds / 5)
    );
    const maxActions = Math.max(
      4,
      Math.ceil(targetSeconds / 2.5)
    );
    const maxTransitions =
      targetSeconds <= 30 ? 2 : Math.ceil(targetSeconds / 15);
    const maxProductStateChanges =
      targetSeconds <= 30 ? 3 : Math.ceil(targetSeconds / 8);

    const timingAudit = auditNarrativeTiming(script);
    const issues: ScriptFeasibilityIssue[] = [...timingAudit.issues];
    if (script.beats.length > maxBeats) {
      issues.push({
        code: "TOO_MANY_BEATS",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "当前时长内剧情 Beat 过多，容易把剪辑脚本误当成单次视频生成任务。",
        suggestion:
          "合并重复功能展示和过细动作，让每个 Beat 只承担一个明确的故事推进。"
      });
    }
    if (structuredActions > maxActions) {
      issues.push({
        code: "ACTION_DENSITY_HIGH",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "动作密度高于当前时长适合的 AI 视频生成范围。",
        suggestion:
          "删除装饰性微动作，保留能推动故事或展示产品状态的主要动作。"
      });
    }
    if (sceneTransitionCount > maxTransitions) {
      issues.push({
        code: "SCENE_DENSITY_HIGH",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "短时长内场景/地点切换过多，生成模型容易混合不同空间。",
        suggestion:
          "减少地点切换；同一 Clip 尽量保持一个地点，跨地点交给 Storyboard 分 Clip。"
      });
    }
    if (productStateChanges > maxProductStateChanges) {
      issues.push({
        code: "PRODUCT_STATE_DENSITY_HIGH",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "产品状态变化过密，容易导致外观和结构漂移。",
        suggestion:
          "把打开、内胆、按压、闭合、Hero 等状态分配到不同 Clip，不在短片段内反复变形。"
      });
    }
    if (editingDirectiveCount > 0) {
      issues.push({
        code: "EDITING_INSTRUCTION_IN_STORY",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "Script 中混入硬切、机位、特写或精确秒点等剪辑/分镜指令。",
        suggestion:
          "Script 只保留故事动作和状态；镜头、切点和摄影交给 Storyboard Director。"
      });
    }
    if (burnedTextDirectiveCount > 0) {
      issues.push({
        code: "BURNED_TEXT_INSTRUCTION",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "Script 正文混入字幕/大字/画面文字指令，容易被模型烧进像素形成乱码。",
        suggestion:
          "把精确文案放入 videoIntent.postProductionText，由后期字幕层渲染。"
      });
    }
    if (
      script.beats.some(
        (beat) =>
          !beat.videoIntent ||
          (
            beat.videoIntent.audioIntent.ambience.length === 0 &&
            beat.videoIntent.audioIntent.sfx.length === 0 &&
            !beat.videoIntent.dialogue &&
            !beat.videoIntent.os
          )
      )
    ) {
      issues.push({
        code: "AUDIO_INTENT_MISSING",
        severity: "REVISE",
        beatIds: script.beats
          .filter(
            (beat) =>
              !beat.videoIntent ||
              (
                beat.videoIntent.audioIntent.ambience.length === 0 &&
                beat.videoIntent.audioIntent.sfx.length === 0 &&
                !beat.videoIntent.dialogue &&
                !beat.videoIntent.os
              )
          )
          .map((beat) => beat.id),
        message:
          "部分剧情 Beat 没有原生声音意图，后续可能错误关闭 Seedance 音轨。",
        suggestion:
          "为每个 Beat 明确自然环境声和必要交互音效；有对白/OS 时单独声明，BGM 固定为 false。"
      });
    }
    if (
      !isScriptDurationWithinTolerance(script.targetDurationMs, totalMs)
    ) {
      issues.push({
        code: "DURATION_OVERLOAD",
        severity: "REVISE",
        beatIds: script.beats.map((beat) => beat.id),
        message:
          "剧本总时长超出了用户要求的 ±10% 范围。",
        suggestion:
          "根据对白、动作和情绪停顿重新编排，使总时长落在目标 ±10% 内；不得平均缩放每段。"
      });
    }

    const base = {
      version: DIRECTOR_V3_VERSION,
      projectId: script.projectId,
      scriptRef: scriptRef(script),
      status: issues.some((issue) => issue.severity === "REVISE")
        ? "REVISE" as const
        : "PASS" as const,
      metrics: {
        beatCount: script.beats.length,
        estimatedTotalMs: totalMs,
        detectedActionCount: structuredActions,
        detectedSceneTransitionCount: sceneTransitionCount,
        detectedProductStateChangeCount: productStateChanges,
        editingDirectiveCount,
        burnedTextDirectiveCount
      },
      issues,
      timingAudit: timingAudit.beats,
      createdAt: new Date().toISOString()
    };
    return scriptFeasibilityReportSchema.parse({
      ...base,
      contentHash: reportHash(base)
    });
  }

  async repair(input: {
    truth: ProductTruth;
    batch: CreativeBatch;
    script: ScriptDraft;
    report: ScriptFeasibilityReport;
    outputVersion?: number;
  }): Promise<ScriptDraft> {
    const truth = productTruthSchema.parse(input.truth);
    const script = scriptDraftSchema.parse(input.script);
    const report = scriptFeasibilityReportSchema.parse(input.report);
    if (report.status === "PASS") return script;

    const allowedFacts = [
      ...truth.confirmedFeatures,
      ...truth.sellingPoints
    ].map((fact) => ({
      id: fact.id,
      statement: fact.statement
    }));
    const allowedFactIds = allowedFacts.map((fact) => fact.id);
    const maxBeatCount = Math.max(
      3,
      Math.ceil(script.targetDurationMs / 5000)
    );
    const targetSeconds = script.targetDurationMs / 1000;
    const maxActionCount = Math.max(
      4,
      Math.ceil(targetSeconds / 2.5)
    );
    const maxSceneTransitions =
      targetSeconds <= 30
        ? 1
        : Math.ceil(targetSeconds / 15);
    const maxUniqueLocations = maxSceneTransitions + 1;
    const maxProductStateChanges =
      targetSeconds <= 30
        ? 3
        : Math.ceil(targetSeconds / 8);
    const selected = input.batch.concepts.find(
      (concept) => concept.id === script.selectedCreativeId
    );
    if (!selected) {
      throw new DomainValidationError(
        "Director V3 无法找到当前脚本对应的创意方案"
      );
    }

    const generated = await generateStructuredJson(
      this.runtime,
      {
        task:
          "Repair the product-video script for reliable AI video generation while preserving the selected story idea and all confirmed product facts.",
        instructions: [
          "Return story beats only; do not write a storyboard or final Seedance prompt.",
          "Use at most " + maxBeatCount + " beats for this duration.",
          "Across the whole script use at most " + maxActionCount + " meaningful physical actions. Each videoIntent.storyAction may contain at most two physical actions; never write a comma-separated chain of micro-actions.",
          "Use at most " + maxUniqueLocations + " unique location labels and at most " + maxSceneTransitions + " location transitions. Reuse the exact same location label when the story remains in the same place.",
          "Across the whole script use at most " + maxProductStateChanges + " meaningful product structural/visual transitions. stateIn/stateOut describe overall story or position state. productStateIn/productStateOut describe only the product structural/visual state. Moving a product from a cabinet to a bed is not a product-state change. If the product structure does not change, productStateIn and productStateOut must be identical.",
          "Merge repetitive micro-actions and repeated product demonstrations.",
          "Treat targetDurationMs as approximate within ±10%; do not mechanically split or pad every Beat into the same duration.",
          "Allocate each Beat time from actual spoken dialogue, movements, reactions, emotion, pauses and reveals; speaking and acting may overlap. A repeated 7.5s allocation for different scenes is unacceptable.",
          "Every Beat must be a detailed, filmable narrative passage, not a one-line summary: state who is where, the character goal and emotion, specific action, other character's reaction, the outcome, and a clear causal link to what happens next.",
          "Important character decisions must have an explicit audience-knowledge moment before or during the decision. Keep narrative roles, motives, event order, and product claims grounded in the approved creative and Product Truth.",
          "Preserve approved plot, identities, real product facts and existing asset references; only repair missing detail, pacing, timing and continuity.",
          "Beat text must not contain camera directions, hard cuts, sub-second timing, subtitle placement, on-screen text rendering instructions or average shot duration.",
          "Every beat must include videoIntent with one clear storyAction and explicit location/state transition.",
          "postProductionText holds exact overlay copy; do not put that copy into generated-pixel instructions.",
          "audioIntent must request natural ambience and interaction/SFX appropriate to the action; bgm is always false. Include dialogue or OS only when the story needs it.",
          "Every factual claim must cite only IDs from allowedFactIds. Never invent or alter IDs.",
          "Do not introduce new product claims, unconfirmed internal structure, certifications, efficacy claims or usage methods.",
          "The total estimated Beat duration must stay within targetDurationMs ±10%, without exact equality at the expense of the plot."
        ].join(" "),
        input: {
          targetDurationMs: script.targetDurationMs,
          selectedCreative: selected,
          currentBeats: script.beats,
          narrativeTimingAudit: auditNarrativeTiming(script),
          feasibilityIssues: report.issues,
          allowedFacts,
          allowedFactIds,
          confirmedUsageRules: (truth.usageRules ?? [])
            .filter((rule) => rule.status === "CONFIRMED")
            .map((rule) => ({
              id: rule.id,
              category: rule.category,
              polarity: rule.polarity,
              statement: rule.statement
            })),
          forbiddenChanges: truth.forbiddenChanges
        },
        outputContract: {
          beats: [
            {
              purpose:
                "HOOK|PAIN|PRODUCT|FEATURE|PROOF|RESULT|CTA|OTHER",
              text: "story progression only",
              estimatedDurationMs: 5000,
              requiredFactIds: allowedFactIds,
              videoIntent: {
                location: "string",
                storyAction: "one clear story action",
                productRole: "string",
                stateIn: "overall story/position state",
                stateOut: "overall story/position state",
                productStateIn: "optional product structural/visual state",
                productStateOut: "optional product structural/visual state; keep identical when product structure does not change",
                dialogue: "optional string",
                os: "optional string",
                audioIntent: {
                  ambience: ["natural environment sound"],
                  sfx: ["interaction sound"],
                  bgm: false
                },
                postProductionText: ["optional exact overlay copy"]
              }
            }
          ]
        },
        context: {
          projectId: script.projectId,
          step: "SCRIPT"
        }
      }
    );

    const proposal = repairProposalSchema.parse(generated.data);
    const total = proposal.beats.reduce(
      (sum, beat) => sum + beat.estimatedDurationMs,
      0
    );
    if (
      !isScriptDurationWithinTolerance(script.targetDurationMs, total)
    ) {
      throw new DomainValidationError(
        "Director V3 修复后的脚本时长仍不满足项目目标"
      );
    }
    proposal.beats.forEach((beat) =>
      assertFactReferences(truth, beat.requiredFactIds)
    );

    const base = {
      ...script,
      id: randomUUID(),
      version: input.outputVersion ?? script.version,
      status: "DRAFT" as const,
      beats: proposal.beats.map((beat, index) => ({
        id: randomUUID(),
        order: index + 1,
        ...beat
      })),
      ...(generated.metadata
        ? { aiExecution: generated.metadata }
        : {})
    } as Record<string, unknown>;
    delete base.confirmedAt;
    return scriptDraftSchema.parse({
      ...base,
      contentHash: contentHash(base)
    });
  }
}
