# Product Video Studio — P0 技术架构

版本：0.2  
状态：Frozen specification baseline  
冻结日期：2026-09-27

## 1. 架构原则

- Headless Core 与 Web UI 分离
- domain / application / ports / adapters / web 边界明确
- Agent 输出结构化且可验证
- SQLite 是结构化工作流权威源
- 文件系统是不可变字节权威源
- project.json 仅为派生快照
- 所有确认绑定具体版本/hash
- 外部副作用可审计、可恢复、默认 fail closed
- 第三方依赖执行 P0 License Gate

## 2. 分层与依赖方向

```text
web
  ↓
application
  ↓
domain ← ports
          ↑
       adapters
```

### 2.1 domain

包含纯业务模型和不变量：
- Project、ProductTruth、ProductFact、UncertainClaim
- CreativeBatch、ScriptDraft、ProductionPlan
- Scene、Clip、Segment、ContinuityLock
- CompiledPrompt、GenerationRequest
- GenerationAttempt、PreflightReport、UserApproval
- WorkflowBlocker、ArtifactRecord、ReviewDecision(minimal)
- 状态转换、版本血缘、失效规则、validator

不得依赖 Web、SQLite、文件路径、child_process 或 dreamina 命令。

### 2.2 application

编排用例和事务边界：
- ProductTruthService
- CreativeService
- ScriptService
- ProductDirectorService
- PromptCompiler
- PreflightService
- GenerationService
- ReviewService
- RecoveryService

application 只能通过 ports 访问持久化、文件、时钟、hash、Provider 和进程能力。

### 2.3 ports

定义：
- ProjectRepository
- ArtifactStore
- HashService
- Clock
- VideoProvider
- CommandAuditStore

### 2.4 adapters

P0 adapters：
- SQLite repositories
- Local immutable ArtifactStore
- DomesticJimengCliProvider
- Node process adapter

Adapter 不得决定产品状态、跳过审批或自动降级 Provider。

### 2.5 web

负责页面、API 输入适配和只读投影。Web 不得直接写 SQLite、启动 CLI 或修改 CompiledPrompt.promptText。

## 3. 总体流程

```text
Web Workbench
  → Application API
  → Workflow Orchestrator
      → ProductTruthService
      → CreativeService
      → ScriptService
      → ProductDirectorService
      → PromptCompiler
      → PreflightService
      → GenerationService
          → VideoProvider port
              → DomesticJimengCliProvider
                  → verified official dreamina CLI
                      → Seedance 2.0
      → ReviewService
```

## 4. 权威存储边界

### 4.1 SQLite：结构化工作流权威源

SQLite 保存：
- 实体ID与关系
- 版本和 current pointer
- 状态和状态转换记录
- hash与血缘
- PreflightReport、UserApproval、WorkflowBlocker
- GenerationAttempt及外部task id
- ArtifactRecord元数据
- ReviewDecision

任何页面状态都从 SQLite 投影，不从目录名或 project.json 反推。

### 4.2 文件系统：不可变字节权威源

文件系统保存：
- 用户上传原文件
- 版本化 JSON 快照
- CompiledPrompt 和 GenerationRequest 快照
- stdout/stderr与解析结果
- Provider probe/help/version原始输出
- 下载视频

写入后以 sha256 标识，不原地覆盖。

### 4.3 project.json

project.json 是可重建的派生快照，用于人工查看或导出；它不是状态权威源，不得用于解决与 SQLite 的冲突。

## 5. 版本化项目目录

```text
projects/<project_id>/
  input/<artifact_id>/<sha256>/<original_name>
  product_truth/v0001/product-truth.json
  creative/batch-<id>/creative-batch.json
  script/v0001/script.json
  director/v0001/production-plan.json
  prompts/<clip_id>/v0001/compiled-prompt.json
  requests/<clip_id>/<request_hash>/generation-request.json
  preflight/<preflight_id>/report.json
  approvals/<approval_id>/approval.json
  generation/<clip_id>/attempt-0001/
    command-attempts.jsonl
    stdout.log
    stderr.log
    submit-result.json
    reconcile.json
    output/<artifact_id>.mp4
  provider/probes/<capability_fingerprint>/
    identity.json
    version.txt
    help.txt
    capability.json
  exports/project.json
```

## 6. Artifact 原子写入协议

跨 SQLite 与文件系统不存在单一原子事务，必须使用可恢复协议：

1. SQLite事务创建 ArtifactRecord，integrityStatus=PENDING。
2. 写入同目录临时文件。
3. flush/fsync（平台支持时）、计算sha256并校验。
4. 原子rename到最终不可变路径。
5. SQLite事务写入size/hash/path并标记READY。
6. 失败标记CORRUPT或MISSING，不得伪装成功。
7. RecoveryService在启动时调和PENDING、缺失文件和孤儿文件。

## 7. 版本血缘

所有版本化实体保存 inputRefs 和 inputHash：

```text
ProductTruth
→ CreativeBatch
→ selected CreativeConcept
→ ScriptDraft
→ ProductionPlan
→ Clip / Segment
→ CompiledPrompt
→ GenerationRequest
→ PreflightReport
→ UserApproval
→ GenerationAttempt
→ ArtifactRecord
→ ReviewDecision
```

每个确认门必须绑定具体ID、版本和hash，禁止只绑定“当前值”。历史对象不可覆盖。

## 8. 下游失效矩阵

| 上游变化 | 必须变为 STALE 的下游 |
|---|---|
| 原始输入/产品资产 | ProductTruth及全部下游 |
| ProductTruth | CreativeBatch及全部下游 |
| CreativeBatch或selectedCreativeId | Script及全部下游 |
| Script | ProductionPlan及全部下游 |
| ProductionPlan/Clip/Segment/ContinuityLock/ForbiddenChange/资产角色 | CompiledPrompt、GenerationRequest、PreflightReport、UserApproval |
| compilerTemplateVersion | CompiledPrompt及全部提交链 |
| Provider/model/生成参数 | GenerationRequest、PreflightReport、UserApproval |
| CLI executable hash/version/help/capability fingerprint | PreflightReport、UserApproval；命令序列变化时还包括GenerationRequest |
| 成本快照变化或过期 | UserApproval |

STALE 对象保留历史，但禁止用于submit或满足COMPLETED。

## 9. 状态模型

### 9.1 ProjectStatus

```text
DRAFT
→ PRODUCT_TRUTH_REVIEW
→ CREATIVE_REVIEW
→ SCRIPT_REVIEW
→ DIRECTOR_REVIEW
→ READY_TO_GENERATE
→ GENERATING
→ GENERATION_REVIEW
→ COMPLETED

任意阶段仅在不可恢复的项目级损坏时 → FAILED
```

WAITING_FOR_USER 不是 ProjectStatus。外部阻塞保留当前ProjectStatus，并创建 WorkflowBlocker。

### 9.2 Clip 聚合状态

```text
PLANNED
READY
GENERATING
NEEDS_REVIEW
ACTION_REQUIRED
ACCEPTED
STALE
```

Clip状态由当前版本及其GenerationAttempt/ReviewDecision聚合，不能保存单次命令状态。

### 9.3 GenerationAttemptStatus

```text
CREATED
SUBMITTING
SUBMITTED
PROCESSING
SUCCEEDED
FAILED
SUBMISSION_OUTCOME_UNKNOWN
RECONCILING
RECONCILED_SUCCEEDED
RECONCILED_FAILED
```

SUBMISSION_OUTCOME_UNKNOWN 不是可自动重试状态。

### 9.4 PreflightStatus

仅允许：PASS / BLOCKED / STALE。

### 9.5 项目聚合规则

- 任一当前attempt为SUBMITTING、SUBMITTED、PROCESSING或RECONCILING：GENERATING。
- 无运行attempt但存在成功待审、失败可重做或未知结果：GENERATION_REVIEW。
- 部分Clip成功、部分失败：GENERATION_REVIEW。
- 全部当前Clip有匹配当前hash的ACCEPT ReviewDecision，且无STALE、无blocker、无未知结果：COMPLETED。
- CLI缺失、未登录、额度不足、身份未验证或单个Clip失败均不得聚合为FAILED。

## 10. WorkflowBlocker

WorkflowBlocker 是独立阻塞维度，scope为PROJECT、PREFLIGHT、GENERATION_ATTEMPT或PROVIDER。

创建场景：
- DREAMINA_NOT_FOUND
- PROVIDER_IDENTITY_UNVERIFIED
- AUTHENTICATION_REQUIRED
- INTERACTIVE_LOGIN_REQUIRED
- ENTITLEMENT_INSUFFICIENT
- CAPABILITY_UNSUPPORTED
- COST_CONFIRMATION_REQUIRED
- SUBMISSION_RECONCILIATION_REQUIRED

UI以未解决 WorkflowBlocker 派生 WAITING_FOR_USER。阻塞记录必须包含requiredUserAction与resumeCheckpoint。

## 11. Segment 与 Director validator

- Clip durationMs必须在4000–15000。
- 至少1个Segment。
- 第一段startMs=0，最后一段endMs=durationMs。
- 每段endMs>startMs。
- 相邻段previous.endMs=next.startMs。
- 无gap/overlap，完整覆盖。
- 时间只用整数毫秒进入domain。
- 声音使用显式NONE结构，不允许optional/null/空字符串。
- dialogue/narration时长必须可在Segment内执行。
- 首Segment continuityIn.stateHash等于Clip.openingState.stateHash。
- 末Segment continuityOut.stateHash等于Clip.closingState.stateHash。
- Scene/Clip/Segment requiredFactIds只能引用ProductFact。
- ForbiddenChange在所有层保持结构化。

## 12. Prompt Compiler 确定性

相同规范化输入与相同compilerTemplateVersion必须产生相同compiledPromptHash。

Compiler必须：
- 固定字段顺序和规范化规则
- 编译ProductFact、ForbiddenChange、ContinuityLock、Segment和Asset角色
- 输出factMapping、segmentMapping和constraintMapping
- 保存所有输入版本/hash
- 不调用自由生成Agent补写事实

用户不得直接编辑CompiledPrompt。结构化输入变化必须创建新版本并重编译。

## 13. GenerationRequest、Preflight 与审批链

GenerationService只接受：

```text
GenerationRequest.requestHash
= PreflightReport.requestHash
= UserApproval.requestHash
```

同时必须满足：
- PreflightReport.status=PASS
- capabilityFingerprint一致
- providerIdentityHash一致
- UserApproval未撤销、未过期、未STALE
- GenerationRequest引用的全部ArtifactRecord为READY且hash一致

成本UNKNOWN允许通过强化确认；能力或身份UNKNOWN必须BLOCKED。

## 14. VideoProvider 契约

```ts
interface VideoProvider {
  id: "domestic-jimeng-cli";
  probe(): Promise<ProviderProbeResult>;
  accountStatus(identity: ProviderIdentity): Promise<AccountStatus>;
  estimate(requests: GenerationRequest[]): Promise<CostEstimate>;
  submit(request: GenerationRequest): Promise<SubmitResult>;
  status(handle: GenerationHandle): Promise<GenerationStatus>;
  download(handle: GenerationHandle, target: ArtifactTarget): Promise<DownloadedAsset>;
  reconcileSubmission(input: ReconcileSubmissionInput): Promise<ReconcileResult>;
}
```

P0只实现DomesticJimengCliProvider。业务层不得直接拼接CLI参数。

## 15. ProviderIdentity 与官方CLI认定

命令名dreamina不是官方身份凭据。ProviderIdentity必须记录并验证：
- officialSourceUrl或官方安装渠道描述
- publisher/packageName
- executablePath
- executableSha256或签名信息
- cliVersion
- rawVersionArtifactId
- rawHelpArtifactId
- capabilityFingerprint
- 官方登录域名/客户端证据
- verificationStatus

verificationStatus不是VERIFIED时，Preflight必须BLOCKED并创建PROVIDER_IDENTITY_UNVERIFIED blocker。

禁止：
- 国际Dreamina
- 第三方逆向Jimeng CLI
- MIT wrapper作为runtime依赖
- 自动触发交互式登录
- 在用户未显式操作时扫码、授权或写入凭据

## 16. 命令审计与敏感信息

每次命令尝试保存：
- executable/argv的安全表示
- startedAt/completedAt
- exitCode/signal/timeout
- stdout/stderr ArtifactRecord
- parserVersion
- parsedResult

stdout/stderr在持久化前必须执行凭据检测与脱敏；Cookie、Token、Authorization、会话密钥不得写入项目文件。必须记录“已脱敏”及规则版本，不能因安全处理而丢失退出码和可审计结构。

## 17. Submit 崩溃窗口与 reconcile

外部submit与本地数据库不能原子提交：

1. 事务创建GenerationAttempt=CREATED，保存requestHash与submissionFingerprint。
2. 写入命令意图并转为SUBMITTING。
3. 调用CLI；submit自动重试次数为0。
4. 能可靠取得handle时，事务保存handle并转SUBMITTED。
5. 如果外部副作用可能发生但handle未可靠落库，转SUBMISSION_OUTCOME_UNKNOWN。
6. RecoveryService调用reconcileSubmission。
7. 调和前禁止任何重提。
8. 调和失败则创建WorkflowBlocker。
9. 用户明确接受重复成本风险后，才能创建全新的GenerationAttempt，并重新Preflight和审批。

status/download允许有上限的技术重试，但每次尝试必须持久化，且不得创建新生成任务。

## 18. GenerationAttempt 不可变规则

- 一个Clip可有多个GenerationAttempt。
- 每次重提必须新attemptNumber、新PreflightReport、新UserApproval。
- 旧Attempt的request、日志、handle、状态和输出不可覆盖。
- Plan/Prompt不变也不能复用旧审批，因为每次submit都是新的成本动作。

## 19. ReviewDecision(minimal)

P0下载成功后必须进入NEEDS_REVIEW。用户播放后提交：
- ACCEPT：该输出可满足当前Clip；必须绑定clipHash、attemptId和outputArtifactHash。
- REDO：不接受；创建重做意图，但不自动submit。

完整审片标注、评分和自动QC属于P1。

## 20. 恢复矩阵

至少覆盖：
- DB提交前进程退出：无外部副作用，可安全恢复。
- SUBMITTING期间退出：进入UNKNOWN并reconcile。
- task id已返回但写库前退出：UNKNOWN并reconcile。
- polling失败：保留handle，有限技术重试或blocker。
- download中断：保留远程handle，创建新下载命令尝试，不创建新生成Attempt。
- 文件rename后DB未READY：启动时校验hash并完成或标错。
- DB指向缺失文件：ArtifactRecord=MISSING并阻止完成。
- CLI版本/help变化：旧Preflight/UserApproval=STALE。

## 21. License Gate

在安装或提交业务依赖前：
- 依赖必须列入dependency-allowlist.json
- 许可证副本进入third_party/licenses/
- 归属信息进入THIRD_PARTY_NOTICES.md
- GPL/AGPL/SSPL/UNKNOWN/无LICENSE/default-deny全部失败
- 检查直接与传递依赖

官方dreamina作为external-runtime登记，但不提交二进制，不因外部运行时身份而绕过来源/条款验证。

## 22. P1 扩展点

仅预留接口，不在P0实现：ResearchProvider、EvidenceStore、ProductQCProvider、TimelineEngine、RenderEngine、PublishProvider。

## 23. 2026-09-28 P0 范围修订：FinalAssembly 与 DouyinPublish

本节覆盖第22节中 RenderEngine/PublishProvider 完全留到 P1 的旧表述。P0 不实现通用 RenderEngine 或 TimelineEngine，而实现两个窄服务：FinalAssemblyService 只按当前 ProductionPlan 顺序拼接已 ACCEPT 且未 SKIP 的 GENERATED_VIDEO；DouyinPublishService 只对接抖音开放平台官方 OAuth 与 video.create 发布链路。

新增状态链：GENERATION_REVIEW → READY_TO_ASSEMBLE → FINAL_REVIEW → READY_TO_PUBLISH → PUBLISHING → PUBLISHED。

FinalAssembly 必须绑定 productionPlanHash、selectedClipIds、输入 Artifact/hash 与输出 Artifact/hash。FFmpeg 只作为已登记、非捆绑 external-runtime 使用，不承担 Timeline 编辑。

Douyin OAuth token/refresh token 只能保存在 .runtime-secrets/，不得进入 Artifact、project.json 或日志。未授权时创建 PROVIDER scope WorkflowBlocker，resumeCheckpoint=publish.douyin.oauth。每次 publish 都要求显式用户确认。
