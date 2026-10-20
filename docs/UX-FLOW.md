# Product Video Studio — P0 页面与交互流程

版本：0.2  
状态：Frozen specification baseline  
冻结日期：2026-09-27

## 1. 页面流

```text
/projects
  ↓
/projects/:id/product
  ↓
/projects/:id/truth
  ↓
/projects/:id/creative
  ↓
/projects/:id/script
  ↓
/projects/:id/director
  ↓
/projects/:id/generate
```

P0保持7个工作面，不新增完整Timeline或Human Review页面。

## 2. 全局页面契约

每个页面必须固定展示：
1. 当前结果及其版本/hash。
2. 当前ProjectStatus。
3. 未解决WorkflowBlocker；存在时显示WAITING_FOR_USER。
4. 上游修改会使哪些下游对象STALE。
5. 唯一主要下一步按钮。
6. 失败或中断后的恢复入口。

不得同时展示多个含义相同的主要动作。危险、付费、失效或重提动作必须二次确认。

WAITING_FOR_USER不是ProjectStatus；页面从未解决WorkflowBlocker派生该表现。

## 3. Projects

显示：
- 项目名称
- 当前ProjectStatus
- 当前阶段结果摘要
- 未解决WorkflowBlocker数量和首要原因
- 最近更新时间
- 当前唯一下一步

唯一主要动作：
- 新项目：`开始填写产品资料`
- 已有项目：根据resumeCheckpoint显示`继续项目`
- COMPLETED：`查看已接受结果`
- FAILED：`查看不可恢复错误`

P0不做团队权限、分享、计费和高级筛选。

## 4. Product Input

字段：
- 产品名称*
- 产品功能介绍*
- 品牌
- 类别
- 产品图片*（至少1张）
- Logo
- ForbiddenChange[]

ForbiddenChange必须按field、description、severity编辑，禁止自由文本数组替代结构化对象。

当前结果：输入资产列表、sha256、完整性状态。  
唯一主要动作：`生成新的 Product Truth 版本`。

修改已存在输入时必须先提示：当前ProductTruth及全部下游将变为STALE；历史版本和历史输出仍保留。

恢复：上传中断只重传受影响ArtifactRecord，不要求重建项目。

## 5. Product Truth Review

显示：
- Canonical Product Image
- 标准颜色
- ProductFact列表
- 卖点
- Logo
- 结构化ForbiddenChange
- UncertainClaim列表及处置
- ProductTruth版本和contentHash

UncertainClaim操作：
- `保留为未验证`：继续隔离，不进入事实链
- `拒绝`
- `提升为事实`：创建新ProductTruth版本和新ProductFact

页面必须明确提示：UNVERIFIED不会用于Creative、Script、Director或Prompt。

确认前校验：
- 每条UncertainClaim已有用户确认处置
- canonical image存在且ArtifactRecord=READY
- ForbiddenChange结构合法

唯一主要动作：`确认此 Product Truth 版本并生成创意`。

修改已确认ProductTruth时创建新版本，并提示CreativeBatch及全部下游将STALE。

## 6. Creative Selection

显示当前CreativeBatch：
- batch版本/hash
- 绑定的ProductTruth版本/hash
- 4–6个CreativeConcept
- 每张卡的目标人群、痛点、Hook、卖点、结构、时长、展示策略、风险和事实依据

操作：
- 选择一个CreativeConcept
- 重新生成全部：必须创建新的CreativeBatch，不覆盖旧批次
- 查看requiredFactIds及ProductFact来源

唯一主要动作：`确认所选创意并生成脚本`。

更换选择或批次时提示Script及全部下游将STALE。

## 7. Script Review

显示：
- Script版本/hash
- 预计总时长
- ScriptBeat列表
- Hook、CTA
- 每个Beat的requiredFactIds
- ProductFact来源

允许：
- 编辑结构化Beat
- 单Beat重写
- 整体重写

任何修改必须创建新Script版本，不原地覆盖已确认版本。

确认前必须验证所有requiredFactIds指向当前ProductTruth中的ProductFact，禁止UncertainClaim进入事实链。

唯一主要动作：`确认此脚本版本并生成 Production Plan`。

修改已确认Script时提示ProductionPlan及全部下游将STALE。

## 8. Director / Clip Planner

布局：
- 左侧Scene列表
- 中间Clip卡片
- 右侧Segment与CompiledPrompt Inspector

### 8.1 Scene/Clip显示

每个Scene显示sourceBeatIds、requiredFactIds和环境状态。

每个Clip显示：
- Clip ID
- duration，4–15秒
- openingState / closingState
- 产品可见性
- strictProductIdentity及适用范围
- Segment数量，至少1
- riskAssessment唯一权威风险
- referenceAssets的role/priority/required
- sourceBeatIds和requiredFactIds
- aggregateStatus

### 8.2 Segment编辑

时间UI可以显示秒，但保存时必须转换为整数毫秒。编辑器实时验证：
- 从0开始到Clip duration结束
- 连续完整覆盖
- 无gap/overlap
- 每段end>start
- 首尾continuity与Clip opening/closing stateHash一致

声音必须显式选择：
- 对白/旁白：NONE / DIALOGUE / NARRATION
- 环境声：NONE / AMBIENT

禁止留空代替NONE。DIALOGUE/NARRATION超出Segment可执行时长时阻止确认。

### 8.3 Prompt Inspector

允许：
- 查看/复制CompiledPrompt
- 查看factMapping、segmentMapping、constraintMapping
- 查看compilerTemplateVersion和输入hash

禁止：
- 直接编辑最终promptText
- 绕过结构化ForbiddenChange

需要修改Prompt时唯一入口为：`修改结构化 Production Plan`，保存新版本后确定性重编译。

唯一主要动作：`确认 Production Plan 并进入 Preflight`。

## 9. Generate / Task Monitor

## 9.1 Preflight

显示：
- PreflightReport状态：PASS / BLOCKED / STALE
- GenerationRequest requestHash
- ProviderIdentity验证状态和identity hash
- dreamina版本、路径、可执行文件hash
- capabilityFingerprint
- 模型Seedance 2.0支持状态
- 登录状态
- Clip数与总生成时长
- 高风险Clip
- 成本/积分KNOWN或UNKNOWN
- blockers和warnings

只有PASS才能进入UserApproval。

成本UNKNOWN但能力明确支持时，显示独立确认：`我理解成本/积分未知，仍提交`。能力、身份、模型或参数UNKNOWN时必须BLOCKED。

唯一主要动作：
- PASS且未批准：`确认本次请求并开始生成`
- BLOCKED：显示WorkflowBlocker要求的唯一修复动作
- STALE：`重新运行 Preflight`

UserApproval页面必须显示绑定的requestHash、preflightHash、providerIdentityHash和capabilityFingerprint。

## 9.2 GenerationAttempt监控

每个Clip显示不可变attempt历史：
- attemptNumber
- GenerationAttempt状态
- requestHash / approvalHash
- submit/status/download/reconcile命令尝试
- externalTaskId（存在时）
- stdout/stderr与脱敏标记
- 输出ArtifactRecord

GenerationAttempt状态包括：
- CREATED
- SUBMITTING
- SUBMITTED
- PROCESSING
- SUCCEEDED
- FAILED
- SUBMISSION_OUTCOME_UNKNOWN
- RECONCILING
- RECONCILED_SUCCEEDED
- RECONCILED_FAILED

submit自动重试次数为0。status/download的有限技术重试必须显示尝试记录，但不得创建新生成任务。

## 9.3 SUBMISSION_OUTCOME_UNKNOWN

显示明确警告：任务可能已经提交并产生费用，禁止自动重提。

唯一主要动作：`调和提交结果`。

reconcile仍无结论时创建WorkflowBlocker，页面进入WAITING_FOR_USER。用户只有在勾选“我理解可能重复扣费/重复生成”后，才能发起新的重做流程；新流程必须新Preflight、新UserApproval和新GenerationAttempt。

## 9.4 成功后的播放与接受/重做

下载成功后Clip进入NEEDS_REVIEW。页面必须提供实际播放控件，并显示：
- 视频ArtifactRecord hash
- 对应GenerationAttempt
- 对应Clip hash
- CompiledPrompt只读查看
- CLI日志

用户必须选择：
- `接受此结果`：创建ACCEPT ReviewDecision(minimal)
- `重做此Clip`：创建REDO ReviewDecision(minimal)，进入新Preflight流程，不自动submit

不得仅因下载成功把Clip标为ACCEPTED或把项目标为COMPLETED。

## 10. WorkflowBlocker / WAITING_FOR_USER

以下情况必须创建WorkflowBlocker：
- DREAMINA_NOT_FOUND
- PROVIDER_IDENTITY_UNVERIFIED
- AUTHENTICATION_REQUIRED
- INTERACTIVE_LOGIN_REQUIRED
- ENTITLEMENT_INSUFFICIENT
- CAPABILITY_UNSUPPORTED
- COST_CONFIRMATION_REQUIRED
- SUBMISSION_RECONCILIATION_REQUIRED
- ARTIFACT_INTEGRITY_FAILURE

页面显示：
- reasonCode
- 对用户的说明
- requiredUserAction
- resumeCheckpoint

交互式安装、登录、扫码或授权只能由用户显式触发。系统不得自动登录或伪装为处理中。

## 11. Project完成/失败显示

COMPLETED仅在当前ProductionPlan全部Clip具有有效ACCEPT ReviewDecision、无STALE、无未解决WorkflowBlocker且无未知提交结果时显示。

部分成功/部分失败显示GENERATION_REVIEW，不显示FAILED。

FAILED仅显示不可恢复的项目级结构化状态或持久化损坏，并提供错误证据；CLI缺失、登录失败、额度不足和Clip失败不得显示Project.FAILED。

## 12. 验收状态展示

验收页或验收摘要必须区分：
- IMPLEMENTATION_PASS
- EXTERNAL_BLOCKED
- E2E_PASS

只有E2E_PASS可显示“P0 PASS”。EXTERNAL_BLOCKED必须显示当前唯一外部阻塞，不能显示为已完成。

## 13. UI原则

- 中文优先
- 核心是做视频，不做大数据驾驶舱
- 当前结果和唯一下一步始终可见
- 高风险、有成本、失效和重提操作显式确认
- 历史记录只读、可审计
- 不提供直接编辑CompiledPrompt的入口

## 14. 2026-09-28 P0 成片/发布工作面

本节覆盖前文“P0 保持 7 个工作面”的旧说明。P0 现增加“成片/发布”工作面，但仍不增加 Timeline Editor。

流程：/projects/:id/generate → /projects/:id/final。

成片页必须支持：按 ProductionPlan 顺序直接拼接已 ACCEPT Clip、显示 FINAL_VIDEO 播放器/hash、下载成片 MP4、用户明确“接受成片”。P0 不提供拖拽时间线、裁剪、转场、字幕、BGM、花字和多轨编辑。

抖音发布页必须支持：未配置时明确提示；未 OAuth 时跳转官方授权页；授权成功后显示标题/描述、显式发布确认复选框和二次确认；成功后显示 PUBLISHED 和可审计 video id/item id；失败保留 Final Video 并回到 READY_TO_PUBLISH。
