# Product Video Studio — P0 核心数据模型

版本：0.2  
状态：Frozen specification baseline  
冻结日期：2026-09-27

本文件定义P0规范类型。实现可使用Zod并导出JSON Schema，但不得放宽本文不变量。

## 1. 通用类型

```ts
type ISODateTime = string;
type Sha256 = string;
type EntityId = string;
type VersionStatus = "DRAFT" | "CONFIRMED" | "STALE";
type GateStatus = "PASS" | "BLOCKED" | "STALE";
type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

interface VersionRef {
  entityType: string;
  entityId: EntityId;
  version: number;
  hash: Sha256;
}
```

所有hash必须基于规范化序列化结果计算。

## 2. Project

```ts
type ProjectStatus =
  | "DRAFT"
  | "PRODUCT_TRUTH_REVIEW"
  | "CREATIVE_REVIEW"
  | "SCRIPT_REVIEW"
  | "DIRECTOR_REVIEW"
  | "READY_TO_GENERATE"
  | "GENERATING"
  | "GENERATION_REVIEW"
  | "COMPLETED"
  | "FAILED";

interface Project {
  id: EntityId;
  name: string;
  status: ProjectStatus;
  targetPlatform: "douyin";
  targetDurationMs: number; // 60000-120000
  aspectRatio: "9:16";
  currentProductTruthRef?: VersionRef;
  currentCreativeBatchRef?: VersionRef;
  selectedCreativeId?: EntityId;
  currentScriptRef?: VersionRef;
  currentProductionPlanRef?: VersionRef;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

WAITING_FOR_USER不得加入ProjectStatus；它由未解决WorkflowBlocker派生。

## 3. ArtifactRecord 与 AssetRef

```ts
type ArtifactIntegrityStatus = "PENDING" | "READY" | "MISSING" | "CORRUPT";

interface ArtifactRecord {
  id: EntityId;
  projectId: EntityId;
  kind:
    | "USER_INPUT"
    | "STRUCTURED_SNAPSHOT"
    | "PROMPT"
    | "REQUEST"
    | "PROVIDER_PROBE"
    | "STDOUT"
    | "STDERR"
    | "PROVIDER_RESULT"
    | "GENERATED_VIDEO"
    | "OTHER";
  relativePath: string;
  sha256?: Sha256;
  sizeBytes?: number;
  mimeType?: string;
  integrityStatus: ArtifactIntegrityStatus;
  immutable: true;
  createdAt: ISODateTime;
}

interface AssetRef {
  id: EntityId;
  artifactId: EntityId;
  type: "image" | "video" | "audio" | "logo" | "document";
  source: "user_upload" | "generated" | "external";
  originalFilename?: string;
  sha256: Sha256;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  provenance?: string;
  createdAt: ISODateTime;
}
```

SQLite中的ArtifactRecord是结构化索引权威；文件系统中的sha256对应文件是字节权威。project.json不属于权威源。

## 4. Product Truth

```ts
interface ProductFact {
  id: EntityId; // fact namespace
  statement: string;
  sourceType: "user" | "official" | "external";
  evidenceRef?: string;
  createdAt: ISODateTime;
}

interface ForbiddenChange {
  id: EntityId;
  field:
    | "logo"
    | "color"
    | "shape"
    | "packaging"
    | "text"
    | "model"
    | "proportion"
    | "other";
  description: string;
  severity: "HARD" | "SOFT";
}

type UncertainClaimStatus = "UNVERIFIED" | "REJECTED" | "PROMOTED";

interface UncertainClaim {
  id: EntityId; // claim namespace, never a fact id
  statement: string;
  reason: string;
  status: UncertainClaimStatus;
  dispositionConfirmedByUser: boolean;
  promotedFactId?: EntityId; // required only for PROMOTED
}

interface ProductTruth {
  id: EntityId;
  projectId: EntityId;
  version: number;
  status: VersionStatus;
  productName: string;
  brand?: string;
  category?: string;
  referenceImageIds: EntityId[];
  canonicalImageId: EntityId;
  logoAssetId?: EntityId;
  standardColors: string[];
  confirmedFeatures: ProductFact[];
  sellingPoints: ProductFact[];
  forbiddenChanges: ForbiddenChange[];
  uncertainClaims: UncertainClaim[];
  evidenceRefs: string[];
  inputRefs: VersionRef[];
  contentHash: Sha256;
  confirmedAt?: ISODateTime;
}
```

约束：
- requiredFactIds只能引用ProductFact.id。
- UncertainClaim.id不得出现在任何事实引用链。
- ProductTruth可在保留UNVERIFIED claim时CONFIRMED，但每条claim必须有用户确认的处置。
- PROMOTED必须指向同一或后续ProductTruth版本中新建的ProductFact。
- ForbiddenChange始终使用上述结构，不得转换为string[]。

## 5. CreativeBatch

```ts
interface CreativeConcept {
  id: EntityId;
  title: string;
  targetAudience: string;
  painPoint: string;
  hook: string;
  coreSellingPoint: string;
  narrativePattern: string;
  expectedDurationMs: number;
  productShowcaseStrategy: string;
  generationRisk: RiskLevel;
  requiredFactIds: EntityId[];
}

interface CreativeBatch {
  id: EntityId;
  projectId: EntityId;
  version: number;
  status: "ACTIVE" | "STALE";
  productTruthRef: VersionRef;
  generatorVersion: string;
  concepts: CreativeConcept[]; // 4-6
  selectedCreativeId?: EntityId;
  contentHash: Sha256;
  createdAt: ISODateTime;
}
```

重新生成创意必须新建CreativeBatch，禁止覆盖旧批次。

## 6. ScriptDraft 与事实追溯

```ts
interface ScriptBeat {
  id: EntityId;
  order: number;
  purpose: "HOOK" | "PAIN" | "PRODUCT" | "FEATURE" | "PROOF" | "RESULT" | "CTA" | "OTHER";
  text: string;
  estimatedDurationMs: number;
  requiredFactIds: EntityId[];
}

interface ScriptDraft {
  id: EntityId;
  projectId: EntityId;
  version: number;
  status: VersionStatus;
  productTruthRef: VersionRef;
  creativeBatchRef: VersionRef;
  selectedCreativeId: EntityId;
  targetDurationMs: number;
  beats: ScriptBeat[];
  contentHash: Sha256;
  confirmedAt?: ISODateTime;
}
```

## 7. ContinuityState 与声音

```ts
interface ContinuityState {
  description: string;
  productState: string;
  characterState?: string;
  environmentState: string;
  stateHash: Sha256;
}

type DialogueOrNarration =
  | { kind: "NONE" }
  | {
      kind: "DIALOGUE" | "NARRATION";
      text: string;
      estimatedDurationMs: number;
      estimatorVersion: string;
    };

type AmbientSound =
  | { kind: "NONE" }
  | { kind: "AMBIENT"; description: string };
```

禁止使用undefined、null或空字符串表示无声音。

## 8. ProductionPlan / Scene / Clip / Segment

```ts
interface ReferenceAssetUse {
  assetId: EntityId;
  role: "PRIMARY_PRODUCT" | "LOGO" | "STYLE" | "ENVIRONMENT" | "CHARACTER" | "OTHER";
  priority: number;
  required: boolean;
}

interface ClipRiskAssessment {
  level: RiskLevel;
  reasonCodes: string[];
  mitigations: string[];
  source: "PRODUCT_DIRECTOR" | "USER_OVERRIDE";
}

interface Segment {
  id: EntityId;
  order: number;
  startMs: number;
  endMs: number;
  shotSize: string;
  cameraPosition: string;
  cameraAngle: string;
  cameraMovement: string;
  composition: string;
  subjectAction: string;
  productState: string;
  dialogueOrNarration: DialogueOrNarration;
  ambientSound: AmbientSound;
  lighting: string;
  continuityIn: ContinuityState;
  continuityOut: ContinuityState;
  sourceBeatIds: EntityId[];
  requiredFactIds: EntityId[];
}

type ClipAggregateStatus =
  | "PLANNED"
  | "READY"
  | "GENERATING"
  | "NEEDS_REVIEW"
  | "ACTION_REQUIRED"
  | "ACCEPTED"
  | "STALE";

interface Clip {
  id: EntityId;
  sceneId: EntityId;
  order: number;
  durationMs: number; // 4000-15000
  purpose: string;
  openingState: ContinuityState;
  closingState: ContinuityState;
  referenceAssets: ReferenceAssetUse[];
  productVisibility: "NONE" | "PARTIAL" | "CLEAR" | "HERO";
  strictProductIdentity: boolean;
  strictProductIdentityScope: string[];
  riskAssessment: ClipRiskAssessment;
  sourceBeatIds: EntityId[];
  requiredFactIds: EntityId[];
  segments: Segment[];
  aggregateStatus: ClipAggregateStatus;
  contentHash: Sha256;
}

interface Scene {
  id: EntityId;
  order: number;
  purpose: string;
  location: string;
  timeOfDay?: string;
  visualState: string;
  sourceBeatIds: EntityId[];
  requiredFactIds: EntityId[];
  clips: Clip[];
}

interface ContinuityLock {
  product: {
    stableAttributes: string[];
    forbiddenChanges: ForbiddenChange[];
  };
  characters: Array<{
    name: string;
    stableAppearance: string;
    wardrobe: string;
  }>;
  environments: Array<{
    sceneId: EntityId;
    stableElements: string[];
  }>;
}

interface ProductionPlan {
  id: EntityId;
  projectId: EntityId;
  version: number;
  status: VersionStatus;
  productTruthRef: VersionRef;
  scriptRef: VersionRef;
  selectedCreativeId: EntityId;
  visualDirection: string;
  soundDirection: string;
  productShowcaseRules: string[];
  continuityLock: ContinuityLock;
  scenes: Scene[];
  contentHash: Sha256;
  confirmedAt?: ISODateTime;
}
```

### 8.1 Clip/Segment精确validator

必须全部成立：
- `4000 <= clip.durationMs <= 15000`
- `clip.segments.length >= 1`
- 所有时间均为整数毫秒
- `segments[0].startMs === 0`
- `segments[last].endMs === clip.durationMs`
- 每段 `endMs > startMs`
- 每个相邻对 `segments[i].endMs === segments[i+1].startMs`
- 无gap、无overlap并完整覆盖
- 首段 `continuityIn.stateHash === clip.openingState.stateHash`
- 末段 `continuityOut.stateHash === clip.closingState.stateHash`
- DIALOGUE/NARRATION的`estimatedDurationMs <= endMs-startMs`
- requiredFactIds全部解析到当前ProductTruth的ProductFact
- sourceBeatIds全部解析到当前confirmed Script

## 9. CompiledPrompt

```ts
interface PromptFactMapping {
  factId: EntityId;
  sourceBeatIds: EntityId[];
  sceneIds: EntityId[];
  clipId: EntityId;
  segmentIds: EntityId[];
  promptSection: string;
}

interface CompiledPrompt {
  id: EntityId;
  projectId: EntityId;
  clipId: EntityId;
  version: number;
  status: "CURRENT" | "STALE";
  provider: "domestic-jimeng-cli";
  model: "seedance-2.0";
  productTruthRef: VersionRef;
  creativeBatchRef: VersionRef;
  selectedCreativeId: EntityId;
  scriptRef: VersionRef;
  productionPlanRef: VersionRef;
  clipHash: Sha256;
  segmentHashes: Record<EntityId, Sha256>;
  compilerTemplateVersion: string;
  promptText: string;
  inputAssetManifest: Array<{
    assetId: EntityId;
    artifactHash: Sha256;
    role: ReferenceAssetUse["role"];
    priority: number;
    required: boolean;
  }>;
  factMapping: PromptFactMapping[];
  segmentMapping: Array<{ segmentId: EntityId; promptSection: string }>;
  constraintMapping: Array<{
    forbiddenChangeId: EntityId;
    promptSection: string;
  }>;
  generationParams: {
    durationMs: number;
    aspectRatio: "9:16";
    generateAudio: boolean;
  };
  compiledPromptHash: Sha256;
  createdAt: ISODateTime;
}
```

promptText是编译产物，不提供用户编辑操作。相同规范化输入与compilerTemplateVersion必须得到相同compiledPromptHash。

## 10. ProviderIdentity 与能力

```ts
type ProviderIdentityStatus = "VERIFIED" | "UNVERIFIED" | "REJECTED";

interface ProviderIdentity {
  id: EntityId;
  provider: "domestic-jimeng-cli";
  officialSourceUrl?: string;
  publisher?: string;
  packageName?: string;
  executablePath: string;
  executableSha256: Sha256;
  signatureInfo?: string;
  cliVersion: string;
  rawVersionArtifactId: EntityId;
  rawHelpArtifactId: EntityId;
  officialLoginOrigins: string[];
  capabilityFingerprint: Sha256;
  verificationStatus: ProviderIdentityStatus;
  verifiedAt?: ISODateTime;
}

interface ProviderCapability {
  provider: "domestic-jimeng-cli";
  providerIdentityId?: EntityId;
  cliFound: boolean;
  authenticated: boolean | "UNKNOWN";
  supportedOperations: string[];
  supportedModels: string[];
  supportedDurationsMs?: number[];
  rawProbeArtifactId: EntityId;
  capabilityFingerprint: Sha256;
  probedAt: ISODateTime;
}
```

只有ProviderIdentity.verificationStatus=VERIFIED时才可能Preflight PASS。

## 11. GenerationRequest

```ts
interface GenerationRequest {
  id: EntityId;
  projectId: EntityId;
  clipId: EntityId;
  compiledPromptId: EntityId;
  compiledPromptHash: Sha256;
  provider: "domestic-jimeng-cli";
  providerIdentityHash: Sha256;
  capabilityFingerprint: Sha256;
  model: "seedance-2.0";
  promptText: string;
  assetManifest: CompiledPrompt["inputAssetManifest"];
  durationMs: number;
  aspectRatio: "9:16";
  generateAudio: boolean;
  inputVersionRefs: VersionRef[];
  createdAt: ISODateTime;
  requestHash: Sha256;
}
```

GenerationRequest是submit的唯一业务输入快照。

## 12. PreflightReport

```ts
interface CostEstimate {
  status: "KNOWN" | "UNKNOWN";
  estimatedCredits?: number;
  estimatedCostText?: string;
  observedAt: ISODateTime;
  expiresAt?: ISODateTime;
}

interface PreflightReport {
  id: EntityId;
  projectId: EntityId;
  generationRequestId: EntityId;
  requestHash: Sha256;
  status: GateStatus; // PASS/BLOCKED/STALE
  providerIdentityHash: Sha256;
  capabilityFingerprint: Sha256;
  clipCount: number;
  totalGeneratedMs: number;
  highRiskClipIds: EntityId[];
  costEstimate: CostEstimate;
  blockers: string[];
  warnings: string[];
  reportHash: Sha256;
  createdAt: ISODateTime;
  staleAt?: ISODateTime;
}
```

成本UNKNOWN可为PASS；能力、模型、参数或身份UNKNOWN必须BLOCKED。

## 13. UserApproval

```ts
interface UserApproval {
  id: EntityId;
  projectId: EntityId;
  generationRequestId: EntityId;
  requestHash: Sha256;
  preflightReportId: EntityId;
  preflightHash: Sha256;
  providerIdentityHash: Sha256;
  capabilityFingerprint: Sha256;
  costSnapshot: CostEstimate;
  acceptedUnknownCostRisk: boolean;
  acceptedDuplicateSubmissionRisk: boolean;
  status: "ACTIVE" | "STALE" | "REVOKED";
  approvedAt: ISODateTime;
  expiresAt?: ISODateTime;
  approvalHash: Sha256;
}
```

ACTIVE审批只授权一次GenerationAttempt的submit。任何重提必须新UserApproval。

## 14. GenerationAttempt

```ts
type GenerationAttemptStatus =
  | "CREATED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "SUBMISSION_OUTCOME_UNKNOWN"
  | "RECONCILING"
  | "RECONCILED_SUCCEEDED"
  | "RECONCILED_FAILED";

interface ProviderHandle {
  externalTaskId?: string;
  submitId?: string;
  opaqueHandle?: string;
}

interface CommandAttemptRecord {
  id: EntityId;
  operation: "PROBE" | "ACCOUNT" | "ESTIMATE" | "SUBMIT" | "STATUS" | "DOWNLOAD" | "RECONCILE";
  attemptNumber: number;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  stdoutArtifactId?: EntityId;
  stderrArtifactId?: EntityId;
  redactionRulesVersion: string;
  parserVersion: string;
  errorCode?: string;
}

interface GenerationAttempt {
  id: EntityId;
  projectId: EntityId;
  clipId: EntityId;
  attemptNumber: number;
  generationRequestId: EntityId;
  requestHash: Sha256;
  preflightReportId: EntityId;
  userApprovalId: EntityId;
  approvalHash: Sha256;
  submissionFingerprint: Sha256;
  status: GenerationAttemptStatus;
  providerHandle?: ProviderHandle;
  commandAttempts: CommandAttemptRecord[];
  outputArtifactId?: EntityId;
  createdAt: ISODateTime;
  submittedAt?: ISODateTime;
  completedAt?: ISODateTime;
  errorCode?: string;
  errorMessage?: string;
}
```

约束：
- `(clipId, attemptNumber)`唯一。
- submit自动重试次数为0。
- 每次重提新建GenerationAttempt、PreflightReport、UserApproval。
- SUBMISSION_OUTCOME_UNKNOWN时不得创建自动重提。
- status/download技术重试不得创建新GenerationAttempt。

## 15. reconcileSubmission

```ts
interface ReconcileSubmissionInput {
  generationAttemptId: EntityId;
  requestHash: Sha256;
  submissionFingerprint: Sha256;
  providerIdentityHash: Sha256;
  capabilityFingerprint: Sha256;
  knownHandle?: ProviderHandle;
}

type ReconcileResult =
  | { outcome: "FOUND_ACTIVE"; handle: ProviderHandle }
  | { outcome: "FOUND_SUCCEEDED"; handle: ProviderHandle }
  | { outcome: "FOUND_FAILED"; handle?: ProviderHandle; reason: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "INCONCLUSIVE"; reason: string };
```

NOT_FOUND或INCONCLUSIVE不能自动触发submit。

## 16. WorkflowBlocker

```ts
type WorkflowBlockerScope = "PROJECT" | "PREFLIGHT" | "GENERATION_ATTEMPT" | "PROVIDER";

interface WorkflowBlocker {
  id: EntityId;
  projectId: EntityId;
  scope: WorkflowBlockerScope;
  relatedEntityId?: EntityId;
  reasonCode:
    | "DREAMINA_NOT_FOUND"
    | "PROVIDER_IDENTITY_UNVERIFIED"
    | "AUTHENTICATION_REQUIRED"
    | "INTERACTIVE_LOGIN_REQUIRED"
    | "ENTITLEMENT_INSUFFICIENT"
    | "CAPABILITY_UNSUPPORTED"
    | "COST_CONFIRMATION_REQUIRED"
    | "SUBMISSION_RECONCILIATION_REQUIRED"
    | "ARTIFACT_INTEGRITY_FAILURE"
    | "OTHER";
  message: string;
  requiredUserAction: string;
  resumeCheckpoint: string;
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}
```

未解决blocker使UI显示WAITING_FOR_USER，但不改变ProjectStatus。

## 17. ReviewDecision(minimal)

```ts
interface ReviewDecision {
  id: EntityId;
  projectId: EntityId;
  clipId: EntityId;
  clipHash: Sha256;
  generationAttemptId: EntityId;
  outputArtifactId: EntityId;
  outputArtifactHash: Sha256;
  decision: "ACCEPT" | "REDO";
  note?: string;
  decidedAt: ISODateTime;
}
```

ACCEPT只有在clipHash及outputArtifactHash仍为当前值时有效。REDO只表达用户意图，不自动创建或提交GenerationAttempt。

## 18. 数据库约束最低要求

- 所有外键启用并强制检查。
- 版本化实体`(projectId, version)`唯一。
- CreativeBatch概念ID在批次内唯一。
- Scene/Clip/Segment order在父级内唯一。
- `(clipId, attemptNumber)`唯一。
- hash字段非空且格式合法。
- ArtifactRecord为READY时path/hash/size必填。
- UserApproval.requestHash必须等于关联GenerationRequest.requestHash。
- PreflightReport.requestHash必须等于关联GenerationRequest.requestHash。
- submit前必须检查Preflight=PASS、Approval=ACTIVE且三个hash一致。
- COMPLETED必须通过聚合查询计算，不允许任意API直接写入。

## 19. 失效规则

上游current pointer或hash变化时，应用事务必须将受影响的下游对象标为STALE。历史ArtifactRecord、GenerationAttempt和ReviewDecision不可删除，但不再满足当前计划。

## 20. P1预留

P0不实现完整ResearchBrief、Evidence Store、ProductQCResult、完整审片标注、Timeline、RenderJob或PublishJob。ReviewDecision(minimal)属于P0最小闭环，不等于P1 Human Review系统。

## 21. 2026-09-28 P0 成片/发布补充模型

本节覆盖上文“P0 不实现 RenderJob/PublishJob”的绝对表述：P0 仍不实现通用 Timeline/RenderJob/PublishJob，只增加窄化的 FinalAssembly 与 Douyin PublishAttempt。

ProjectStatus 增加 READY_TO_ASSEMBLE、FINAL_REVIEW、READY_TO_PUBLISH、PUBLISHING、PUBLISHED。ArtifactRecord.kind 增加 FINAL_VIDEO。

FinalAssembly 保存 productionPlanHash、selectedClipIds、inputArtifactIds/inputArtifactHashes、outputArtifactId/outputArtifactHash、status(READY/ACCEPTED/STALE)、createdAt/acceptedAt。

PublishAttempt 保存 projectId、finalAssemblyId、platform=douyin、status、title/description、externalVideoId/externalItemId、error、createdAt/confirmedAt/completedAt。

约束：FinalAssembly 只能引用 READY GENERATED_VIDEO 且输入 Clip 有有效 ACCEPT；SKIP Clip 不进入成片；输入顺序必须等于 ProductionPlan；只有 ACCEPTED FinalAssembly 才可创建真实抖音发布副作用；PublishAttempt 禁止保存 access token、refresh token、cookie 或 ClientSecret。
