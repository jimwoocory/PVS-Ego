import { hashValue } from "../src/domain/hashing.js";
import { productionAssetSetRef, productionAssetSetSchema } from "../src/domain/production-strategy.js";
import { scriptDraftSchema, type ProductionPlan } from "../src/domain/schemas.js";
import type { SmartGenerationRun } from "../src/domain/smart-generation.js";
import type { V8PromptRecord } from "../src/domain/v8-production.js";
import { V8DetailedScreenplayService } from "../src/application/services/v8-detailed-screenplay-service.js";
import { ApplicationSmartProduction, type SmartProductionDependencies } from "../src/application/services/smart-production-adapter.js";
import { ProductDirectorService } from "../src/application/services/product-director.js";
import { HermesProductDirectorGenerator } from "../src/adapters/ai/hermes-product-director-generator.js";
import { FixtureProduction, smartOptions } from "./smart-test-support.js";
import { modelRegistry } from "./model-aware-fixtures.js";
import { ISO } from "./fixtures.js";

export const formalV8Options = { ...smartOptions, directorVersion: 3, directorPipeline: "V8", reviewMode: "MANUAL",
  generationSettings: { ...smartOptions.generationSettings, nativeAudioOutputRequested: true } };
export const voices = { 室友: { actorAssetKey: "CHARACTER_A", voiceType: "清晰青年女声" }, 主人公: { actorAssetKey: "CHARACTER_B", voiceType: "沉稳青年男声" } };
export function screenplayFixture() {
  return { title: "疑问与答案", premise: "室友发现陌生物品，主人公解释", storyConflict: "室友不知道物品来历", finalOutcome: "误会解决",
    scenes: [{ location: "卧室", interiorExterior: "INT", timeOfDay: "DAY", situation: "两位成年人在房间内对话", dramaticPurpose: "先疑问后解释",
      actorObjectives: [{ speaker: "室友", wants: "知道答案", obstacle: "缺少信息" }, { speaker: "主人公", wants: "澄清误会", obstacle: "室友困惑" }],
      beats: [
        { purpose: "HOOK", action: "室友看向桌面追问", actorAction: "室友看向主人公提出疑问", stateIn: "室友未提问", stateOut: "主人公听见问题",
          productRole: "暂不揭晓谜底", estimatedDurationMs: 5000, requiredFactIds: [], audienceKnowledgeChange: "观众只知道室友困惑",
          dialogue: [{ speaker: "室友", mode: "ONSCREEN", text: "这是什么？", tone: "疑惑", delivery: "轻声正常语速" }],
          postProductionText: [], ambience: ["室内自然环境声"], sfx: [] },
        { purpose: "PRODUCT", action: "主人公指向产品说明", actorAction: "主人公指向桌上的产品", stateIn: "等待回答", stateOut: "室友知道答案",
          productRole: "此刻才揭晓", estimatedDurationMs: 5000, requiredFactIds: ["fact-1"], audienceKnowledgeChange: "观众此刻知道谜底是产品",
          dialogue: [{ speaker: "主人公", mode: "OFFSCREEN", text: "这是我们的产品。", tone: "平静", delivery: "语速正常尾音完整" }],
          postProductionText: ["产品名称", "请按说明使用"], ambience: ["室内自然环境声"], sfx: ["手触桌面轻响"] }
      ] }] };
}

export class FormalV8Production extends FixtureProduction {
  registry = modelRegistry(15, true);
  adapter: ApplicationSmartProduction;
  visualCalls = 0;
  mutateProposal?: (proposal: ReturnType<FormalV8Production["proposal"]>) => void;
  constructor() {
    super();
    const director = new ProductDirectorService(new HermesProductDirectorGenerator({ id: "isolated-director", version: "1",
      generateJson: async request => {
        this.visualCalls++;
        const input = request.input as { v8DirectorDecision: { clips: Array<{ durationMs: number; location: string; sourceBeatIds: string[]; shots: Array<Record<string, unknown>> }> } };
        const proposal = this.proposal(input.v8DirectorDecision.clips);
        this.mutateProposal?.(proposal);
        return proposal;
      } }));
    this.adapter = new ApplicationSmartProduction({
      productFlow: { getWorkspace: async () => ({ productTruth: this.c.input.productTruth }), nextVersion: async () => 1 },
      dreaminaCapability: { registry: async () => this.registry }, productDirector: director
    } as unknown as SmartProductionDependencies);
  }
  proposal(clips: Array<{ durationMs: number; location: string; sourceBeatIds: string[]; shots: Array<Record<string, unknown>> }>) {
    const state = { description: "人物位于桌边", productState: "保持参考产品原貌", environmentState: "房间和桌面保持一致" };
    return { visualDirection: "真人写实，保持人物视线连续", soundDirection: "原生对白及自然环境声，不生成背景音乐", productShowcaseRules: ["保持已确认外观"],
      characters: [{ name: "室友", stableAppearance: "CHARACTER_A", wardrobe: "保持参考" }, { name: "主人公", stableAppearance: "CHARACTER_B", wardrobe: "保持参考" }],
      scenes: clips.map(clip => ({ purpose: "疑问到解答", location: clip.location, timeOfDay: "DAY", visualState: "人物与桌面", stableElements: ["桌面"],
        sourceBeatIds: clip.sourceBeatIds, requiredFactIds: [], clips: [{ ...this.c.proposal.scenes[0]!.clips[0]!,
          durationMs: clip.durationMs, sourceBeatIds: clip.sourceBeatIds, requiredFactIds: [],
          openingState: state, closingState: state,
          referenceAssets: [{ assetId: this.c.input.productTruth.canonicalImageId, role: "PRIMARY_PRODUCT", priority: 0, required: true },
            { assetId: "actor-a", role: "CHARACTER", priority: 1, required: true }, { assetId: "actor-b", role: "CHARACTER", priority: 2, required: true }],
          segments: clip.shots.map(shot => {
            const speechInput = shot.spoken as { speaker: string; exactText: string; mode: string; speechEstimatedMs: number } | undefined;
            const spoken = speechInput ? Object.fromEntries(Object.entries(speechInput).filter(([k])=>k !== "speechEstimatedMs")) : undefined;
            const sounds = [...shot.ambience as string[], ...shot.sfx as string[]];
            return { startMs: shot.startMs, endMs: shot.endMs, shotSize: "中景", cameraPosition: "人物视线高度", cameraAngle: "平视", cameraMovement: "稳定机位",
              composition: "室友在左主人公在右，保持同一轴线与视线", subjectAction: shot.visibleAction, productState: "保持参考产品原貌", lighting: "窗边自然光",
              dialogueOrNarration: spoken ? { kind: spoken.mode === "OS" ? "NARRATION" : "DIALOGUE", text: spoken.mode === "OS" ? spoken.exactText : spoken.speaker+'：“'+spoken.exactText+'”', estimatedDurationMs: speechInput!.speechEstimatedMs, estimatorVersion: "isolated" } : { kind: "NONE" },
              ambientSound: sounds.length ? { kind: "AMBIENT", description: sounds.join("；") } : { kind: "NONE" },
              continuityIn: state, continuityOut: state, sourceBeatIds: [shot.sourceBeatId], requiredFactIds: [],
              v8: { sourceShotId: shot.sourceShotId, sourceBeatId: shot.sourceBeatId, sourceActionHash: shot.sourceActionHash, shotFunction: shot.shotFunction,
                ...(spoken ? { spoken } : {}), ...(shot.audienceKnowledgeChange ? { audienceKnowledgeChange: shot.audienceKnowledgeChange } : {}) },
              postProductionText: (shot.postProductionText as string[]).map(text => ({ kind: "LABEL", text, startMs: shot.startMs, endMs: shot.endMs,
                position: "BOTTOM", fontScale: 1, sourceBeatIds: [shot.sourceBeatId], requiredFactIds: [] })) };
          }) }] })) };
  }
  override async initial() { return { targetDurationMs: 10000, binding: {} }; }
  override async prepareProductionAssets(run: SmartGenerationRun) {
    const { set } = await super.prepareProductionAssets(run);
    const { contentHash: _h, ...base } = set;
    const entry = set.entries[0]!;
    const next = { ...base, entries: [{...entry, referenceAssetId:this.c.input.productTruth.canonicalImageId}, ...["A", "B"].map((letter, i) => ({ ...entry, kind: "CHARACTER" as const,
      key: "CHARACTER_"+letter, label: i ? "主人公" : "室友", referenceAssetId: "actor-"+letter.toLowerCase(),
      sourceReferenceAssetIds: ["actor-"+letter.toLowerCase()], artifactIds: ["actor-artifact-"+letter] }))] };
    return { set: productionAssetSetSchema.parse({ ...next, contentHash: hashValue(next) }) };
  }
  async scriptV8(run: SmartGenerationRun) {
    const service = new V8DetailedScreenplayService({ id: "isolated-screenplay", version: "1", generateJson: async () => screenplayFixture() });
    const result = await service.propose({ truth: this.c.input.productTruth, batch: run.creativeBatch!, selectedCreativeId: run.selectedCreativeId!,
      userBrief: run.options.requestText, targetDurationMs: run.targetDurationMs, version: 1 });
    const { contentHash: _h, ...base } = result.legacyScriptDraft;
    const bound = { ...base, productionAssetSetRef: productionAssetSetRef(run.productionAssetSet!) };
    return { script: scriptDraftSchema.parse({ ...bound, contentHash: hashValue(bound) }), screenplay: result.screenplay };
  }
  buildDirectorV8(run: SmartGenerationRun) { return this.adapter.buildDirectorV8(run); }
  directorV8(run: SmartGenerationRun): Promise<ProductionPlan> { return this.adapter.directorV8(run); }
  compilePromptsV8(run: SmartGenerationRun, binding: V8PromptRecord["voiceBindings"]) { return this.adapter.compilePromptsV8(run, binding); }
  validatePromptsV8(run: SmartGenerationRun) { return this.adapter.validatePromptsV8(run); }
  reviseV8Screenplay(run: SmartGenerationRun, screenplay: unknown) {
    return this.adapter.reviseV8Screenplay(run, screenplay);
  }
  override async preparePaidScope(run: SmartGenerationRun) {
    const scope = await super.preparePaidScope(run);
    const v8Binding = { runId: run.id, screenplayHash: run.v8Screenplay!.screenplayHash, directorRecordHash: run.v8Director!.contentHash, promptRecordHash: run.v8Prompts!.contentHash };
    return { ...scope, v8Binding, hash: hashValue({ planRef: scope.planRef, requests: scope.requests, v8Binding }) };
  }
}
