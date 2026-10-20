import { randomUUID } from "node:crypto";
import { v8DetailedProposalSchema, type V8DetailedProposal } from "../../domain/v8-screenplay.js";
export { v8DetailedProposalSchema } from "../../domain/v8-screenplay.js";
export type { V8DetailedProposal } from "../../domain/v8-screenplay.js";
import { hashValue } from "../../domain/hashing.js";
import {
  creativeBatchSchema, productTruthSchema, scriptDraftSchema,
  type ProductTruth, type CreativeBatch, type ScriptDraft
} from "../../domain/schemas.js";
import {
  generateStructuredJson, type StructuredAiRuntime
} from "../ports/structured-ai-runtime.js";
import { DomainValidationError } from "../../domain/validation.js";

/** V8 storyboard proposal is now shared with the SmartRun domain schema. */
export type V8DetailedScreenplayOutput = {
  screenplay: V8DetailedProposal;
  legacyScriptDraft: ScriptDraft;
  sourceBrief: string;
  runModelMetadata?: {
    executionId: string;
    providerId: string;
    modelId: string;
    configVersion: number;
  };
};

/** Fails closed on unsupported/free-text dialogue without a named speaker. */
function validateProposal(input: {
  proposal: V8DetailedProposal;
  allowedFactIds: Set<string>;
  targetMs: number;
}) {
  const total = input.proposal.scenes.reduce((sum, scene) =>
    sum + scene.beats.reduce((part, beat) => part + beat.estimatedDurationMs, 0), 0);
  if (total !== input.targetMs) {
    throw new DomainValidationError(
      "V8 详细剧本的场次与节拍总时长必须严格等于用户目标，不能自动填充或删减台词。当前 " +
      total / 1000 + " 秒，目标 " + input.targetMs / 1000 + " 秒。"
    );
  }
  for (const scene of input.proposal.scenes) {
    const knownActors = new Set(scene.actorObjectives.map(actor => actor.speaker));
    for (const beat of scene.beats) {
      for (const factId of beat.requiredFactIds) {
        if (!input.allowedFactIds.has(factId)) {
          throw new DomainValidationError("V8 剧本使用了产品事实库之外的 Fact ID，禁止自动采用");
        }
      }
      let osCount = 0;
      for (const line of beat.dialogue) {
        if (!knownActors.has(line.speaker)) {
          throw new DomainValidationError("V8 剧本台词没有对应已定义的出场人物：" + line.speaker);
        }
        if (line.mode === "OS") osCount++;
        if (/[\r\n]/.test(line.text)) {
          throw new DomainValidationError("台词必须逐句保存，不允许把多人对白混进一行");
        }
      }
      if (osCount > 1) {
        throw new DomainValidationError("V8 兼容版每个 Beat 只能绑定一条明确 OS，须拆为相邻节拍");
      }
      const speechLength = beat.dialogue.map(line => [...line.text].length)
        .reduce((a,b) => a+b,0);
      // A first-pass lower bound, NOT a promise that a generation model can
      // produce understandable speech. More exact time review follows.
      if (beat.estimatedDurationMs < (speechLength / 8) * 1000) {
        throw new DomainValidationError("V8 剧本对白在本段时长内过密，不允许靠异常提速吞字");
      }
    }
  }
}

function toLegacy(input: {
  screenplay: V8DetailedProposal;
  projectId: string;
  selectedCreativeId: string;
  targetDurationMs: number;
  truth: ProductTruth;
  batch: CreativeBatch;
  version: number;
  metadata?: V8DetailedScreenplayOutput["runModelMetadata"];
  reuseBeatIds?: string[];
}): ScriptDraft {
  let number = 0;
  const beats = input.screenplay.scenes.flatMap(scene =>
    scene.beats.map(beat => {
      number++;
      const spoken = beat.dialogue.filter(line => line.mode !== "OS");
      const os = beat.dialogue.filter(line => line.mode === "OS");
      const projection = {
        id: input.reuseBeatIds?.[number - 1] ?? randomUUID(), order: number, purpose: beat.purpose,
        text: beat.action,
        estimatedDurationMs: beat.estimatedDurationMs,
        requiredFactIds: beat.requiredFactIds,
        videoIntent: {
          location: scene.location,
          storyAction: beat.actorAction,
          productRole: beat.productRole,
          stateIn: beat.stateIn, stateOut: beat.stateOut,
          ...(spoken.length ? {
            dialogue: spoken.map(line=>line.speaker + "：“" + line.text + "”").join("")
          } : {}),
          ...(os.length ? { os: os[0]!.text } : {}),
          audioIntent: { ambience: beat.ambience, sfx: beat.sfx, bgm: false as const },
          postProductionText: beat.postProductionText
        }
      };
      return projection;
    })
  );
  const draft = {
    id: randomUUID(), projectId: input.projectId,
    version: input.version, status: "DRAFT" as const,
    productTruthRef: {
      entityType: "ProductTruth" as const,
      entityId: input.truth.id,
      version: input.truth.version,
      hash: input.truth.contentHash
    },
    creativeBatchRef: {
      entityType: "CreativeBatch" as const,
      entityId: input.batch.id,
      version: input.batch.version,
      hash: input.batch.contentHash
    },
    selectedCreativeId: input.selectedCreativeId,
    targetDurationMs: input.targetDurationMs,
    ...(input.metadata ? { aiExecution: input.metadata } : {}),
    beats
  };
  return scriptDraftSchema.parse({ ...draft, contentHash: hashValue(draft) });
}

/**
 * Explicit human edit: deterministic, no AI/API invocation. Rebuilds a new
 * ScriptDraft while preserving stable Beat IDs for unchanged shot positions.
 * A change to the number of Beats requires a separately reviewed screenplay.
 */
export function reviseV8DetailedProposal(input: {
  screenplay: unknown;
  existingScript: ScriptDraft;
  truth: ProductTruth;
  batch: CreativeBatch;
  selectedCreativeId: string;
  targetDurationMs: number;
}): ScriptDraft {
  const proposal = v8DetailedProposalSchema.parse(input.screenplay);
  const truth = productTruthSchema.parse(input.truth);
  const batch = creativeBatchSchema.parse(input.batch);
  const source = scriptDraftSchema.parse(input.existingScript);
  if (truth.status !== "CONFIRMED" || batch.status !== "ACTIVE" ||
      source.projectId !== truth.projectId ||
      source.selectedCreativeId !== input.selectedCreativeId ||
      !batch.concepts.some(item => item.id === input.selectedCreativeId) ||
      source.targetDurationMs !== input.targetDurationMs) {
    throw new DomainValidationError("V8 人工修改必须绑定本任务已确认的产品事实、创意和目标时长");
  }
  const beatCount = proposal.scenes.reduce((total, scene)=>total+scene.beats.length,0);
  if (beatCount !== source.beats.length) {
    throw new DomainValidationError("本轮只能修改原有场次/节拍内容，增删节拍需要重新规划独立版本");
  }
  validateProposal({
    proposal,
    allowedFactIds: new Set([...truth.confirmedFeatures, ...truth.sellingPoints].map(fact=>fact.id)),
    targetMs: input.targetDurationMs
  });
  return toLegacy({
    screenplay:proposal,
    projectId:truth.projectId,
    selectedCreativeId:input.selectedCreativeId,
    targetDurationMs:input.targetDurationMs,
    truth,batch,
    version:source.version+1,
    reuseBeatIds: [...source.beats].sort((a,b)=>a.order-b.order).map(beat=>beat.id)
  });
}

export class V8DetailedScreenplayService {
  constructor(private readonly runtime: StructuredAiRuntime) {}

  async propose(input: {
    truth: ProductTruth;
    batch: CreativeBatch;
    selectedCreativeId: string;
    userBrief: string;
    targetDurationMs: number;
    version: number;
    researchPatterns?: string[];
  }): Promise<V8DetailedScreenplayOutput> {
    const truth = productTruthSchema.parse(input.truth);
    const batch = creativeBatchSchema.parse(input.batch);
    if (truth.status !== "CONFIRMED" || batch.status !== "ACTIVE") {
      throw new DomainValidationError("V8 剧本创作需要先确认产品事实并选定可用创意");
    }
    const selected = batch.concepts.find(concept => concept.id === input.selectedCreativeId);
    if (!selected) throw new DomainValidationError("选择的创意不属于当前项目");
    if (!input.userBrief.trim()) throw new DomainValidationError("需要至少一段用户创作要求");
    if (input.targetDurationMs < 10000 || input.targetDurationMs > 120000) {
      throw new DomainValidationError("当前兼容链路仅支持 10 到 120 秒的目标时长");
    }
    const allowedFacts = [...truth.confirmedFeatures, ...truth.sellingPoints]
      .map(fact => ({id:fact.id,statement:fact.statement}));
    const result = await generateStructuredJson(this.runtime, {
      task: "根据用户可能极模糊的创作意图，创作可拍、可演、指定时长的原创中文真人短剧广告详细剧本（不写分镜和摄影机提示词）。",
      instructions: [
        "创作剧本不是生成商品问答。先建立有意义的人物目标、障碍、事件因果和结局；如生活广告无需强冲突，不要机械套用爽剧。",
        "严格依照用户本轮意图、选定创意、总时长和已确认产品事实；研究提供的是结构参考，不可照抄竞品创意、角色或台词。",
        "按场次列出内/外、地点、昼夜、具体可视动作、人物想达到的目标、阻碍、观众何时得到新的事实。",
        "每个 Beat 有人物能表演的具体动作和开始/结束状态，不要只写摘要或抽象心理，也不要在剧本中提前写机位、逐帧剪辑或视频生成命令。",
        "每句对白必须拆成独立 speaker、原文、声音语气和表演执行参数。必须通过语言和表演时长的估算，所有 Beat 时长相加准确等于用户目标。",
        "若有旁白必须源于剧本本身，OS 与演员开口说话必须区别；不要自动添加 BGM。",
        "所有与产品有关的陈述必须且只能引用 allowedFacts 的精确 Fact ID。未经确认的疗效、效果、产地、参数不能当成事实；不得修改参考产品身份。",
        "将字幕/商品名称/法律文案放进 postProductionText，不能让生成视频烧字。",
        "不得输出任何系统 ID、哈希或 API 访问记录，只输出 JSON 契约里的 fields。",
        "当 Brief 信息很少，用原创合理的生活情景自然补足创作结构，但不凭空改变产品事实或用户明确限制。"
      ].join("\n"),
      input: {
        requestText: input.userBrief,
        targetDurationMs: input.targetDurationMs,
        selectedCreative: selected,
        allowedFacts,
        uncertainClaims: truth.uncertainClaims.map(c=>({statement:c.statement,status:c.status})),
        forbiddenChanges: truth.forbiddenChanges,
        usageRules: (truth.usageRules??[]).filter(r=>r.status==="CONFIRMED")
          .map(r=>({statement:r.statement,category:r.category})),
        referenceStructureOnly: (input.researchPatterns??[]).slice(0,8)
      },
      outputContract: {
        title:"string",premise:"string",storyConflict:"string",finalOutcome:"string",
        scenes:[{
          location:"string",interiorExterior:"INT|EXT",timeOfDay:"DAY|NIGHT|UNSPECIFIED",
          situation:"string",dramaticPurpose:"string",
          actorObjectives:[{speaker:"string",wants:"string",obstacle:"string"}],
          beats:[{
            purpose:"HOOK|PAIN|PRODUCT|FEATURE|PROOF|RESULT|CTA|OTHER",
            action:"what visibly happens",actorAction:"performable action",
            stateIn:"before scene state",stateOut:"after action state",
            productRole:"product visual/narrative role",estimatedDurationMs:8000,
            requiredFactIds:["only allowedFacts ids"],audienceKnowledgeChange:"viewer discovers ...",
            dialogue:[{speaker:"actor from actorObjectives",mode:"ONSCREEN|OFFSCREEN|OS",
              text:"exact dialogue",tone:"emotional delivery",delivery:"breath/speed/volume/ending"}],
            postProductionText:[],ambience:[],sfx:[]
          }]
        }]
      },
      context: { projectId: truth.projectId, step:"SCRIPT" }
    });
    const screenplay = v8DetailedProposalSchema.parse(result.data);
    validateProposal({ proposal:screenplay,
      allowedFactIds:new Set(allowedFacts.map(f=>f.id)),
      targetMs:input.targetDurationMs
    });
    const legacyScriptDraft = toLegacy({
      screenplay, projectId:truth.projectId,
      selectedCreativeId:input.selectedCreativeId,
      targetDurationMs:input.targetDurationMs,
      truth,batch,version:input.version,metadata:result.metadata
    });
    return {
      screenplay, legacyScriptDraft,
      sourceBrief: input.userBrief,
      ...(result.metadata ? { runModelMetadata: result.metadata } : {})
    };
  }
}
