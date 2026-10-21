# Go 生命周期持久化、异常恢复与只读研究接线

2026-10-20。沿用本地 HEAD `67fcac5` 和全部未提交改动。用户要求按“空白库持久化 → 异常路径 → 自有动态页面研究证据”顺序继续；本轮均在 PVS-Ego 隔离仓库执行，未提交或推送。

## 实施结果

### 1. 保留租约的进度保存与恢复

原服务在能力执行期间保留租约。现在在首次 RUNNING 落库前写入本机执行标记，随后由同一租约拥有者串行保存有界进度：阶段变化、首个样本、每十个样本及取消请求；终态仍由原动作保存。GET 的进程内视图与数据库修订号相配，不新增第二个任务库或迁移表。

本机进度最多64个样本，拒绝计数下降、状态倒退、非终态声明退出以及工作程序自行声明取消许可。取消只有当前版本、同项目、同动作、同上下文的进程内句柄可接收；重复请求不会重复发送信号。取消中保持 RUNNING，收到工作程序退出确认后才保存本机 CANCELLED；完成先于取消时保留成功结果并停止后续调度。

进程死亡后，沿用原仓库的 PID 存活检查和死租约回收。带本机执行标记的 READ 动作恢复为 BLOCKED，HUMAN_DECISION 动作为 OUTCOME_UNKNOWN；旧句柄不可复活，不恢复授权、不自动重提或进入模型规划。此时用户取消只停止后续调度，保留未确认 worker 退出的事实。默认未注入本机接口的能力保留原执行路径。

### 2. 异常路径

实际空白 SQLite/Prisma、两个客户端与独立进程验证了：

- 活动租约下进度可持久读取，其他服务实例不能取得活动锁或发取消。
- 版本、项目、并发推进限制与原幂等键保持有效。
- 重复取消、取消与成功的两个顺序均不重复执行或回滚成功。
- 超时、断线、缺少 worker 退出确认均阻断，不宣称已停止或自动重试。
- 迟到事件不改变终态，非法、递减或倒退进度被拒绝。
- 真正退出的自有进程留下的租约由新进程回收，终态、样本、文件和请求键可读回。

最终 `go-lifecycle-durability-isolated.test.mjs` 为 **10 PASS / 0 FAIL，套件退出0**（9子项+父项）。正常子进程退出0；3次显式故障注入使自有进程退出73，测试实际观察该退出后才尝试恢复。这些73是预期中断证据，不能描述为“所有子进程正常退出0”。执行端口为明确的 `INERT_FAULT_FIXTURE`；该套件未调用真实Go、浏览器或平台。数据库和服务均为真实实现。

### 3. Go正文进入既有研究链

固定工作程序增加 `capture`，只访问配置绑定的 `http://127.0.0.1:<随机端口>/bridge-fixture/<nonce>`。等待自有页面的动态正文就绪，核对实例、Profile、Space控制权、最终网址和nonce，返回最多4000字符的正文、标题、时间和截断标记。Go端校验事件形状、顺序、唯一正文及URL/大小/时间界限；没有任意网址、脚本或平台动作入口。

新增未注册到默认工厂的 `GoLocalResearchProvider`，复用 `WebResearchProvider`、原 ResearchRepository、ArtifactRepository 和 LocalArtifactStore。它要求明确绑定的项目和自有来源，核对研究run归属与状态，在项目目录保存不可变JSON正文文件、SHA256及来源回执。相同run的有效文件可复用；跨项目、其他来源、失效run和文件哈希变化均拒绝，不自动换来源或重取。scope始终只是事件关联数据；实际执行仍先经过原Agent具体动作确认、版本与上下文门。

`ResearchService.startRun` 增加显式 `collectOnly`：只允许 BASIC 指定来源采集；去重后写入原Evidence流程，然后以 `BRIEF_GENERATION_NOT_AUTHORIZED` 暂停。没有生成Brief，没有采用产品事实，也没有把证据采集成功写成完整业务研究完成。它不会进入DEEP搜索、媒体分析或模型摘要。既有默认研究路径未被切换；原Ego研究适配器的截图要求未放宽。

最终 `go-research-isolated.test.mjs` 为 **6 PASS / 0 FAIL，套件退出0**（5子项+父项）：

- 新建专用空白Ego Profile，使用原未修改的CLI、SDK、Electron/Chromium宿主；原probe、取消、超时语义实测通过。
- 原Agent确认 → 实际Go固定采集 → 真实动态DOM正文 → ResearchService → 空白Prisma Evidence → 不可变Artifact，通过实际执行。
- 重复来源和同requestKey不增加执行；新进程读回相同证据、正文哈希和文件SHA256。
- 跨项目/任意URL/无效run及临时损坏文件均拒绝，损坏夹具恢复后哈希与原证据一致。
- 关闭本轮自有宿主后，新run失败阻断；只尝试一次，不复用旧run正文冒充新采集，不重启宿主。

Go编译、TypeScript编译和全部自有研究子进程退出0。真实模型调用0、搜索调用0。动态网页正文含“页面数据不能授予权限”的合成文本，仅作为Evidence数据保存。没有调用业务模型来解释页面，也没有外发素材。

## 证据范围与限制

两项定向套件分轮执行，日志先追加 `.runtime/p3-report.md`，再写各自checkpoint；没有运行npm全量测试或平台验收。最终回执只在观察套件与子进程退出后写出，带有对应源码SHA256；不把早先9项持久化候选和最终10项累加。

前轮工作台原生点击9/9属于历史证据，本轮没有重跑交互式工作台套件，也没有新增界面代码。Tabbit截图超时仍BLOCKED，研究正文回执不含截图；不能据此宣称视觉验收或真实网站研究通过。

这是自有页面和空白库的本机闭环，尚未接入生产工厂、真实Research能力注册或正式账号。真实平台E2E、U3编辑态、U1多Space与登录归还等缺口保留；U4已有父评论真实第二页、U5真实建议尚未采用的事实保持原样。实际模型费用UNKNOWN、音频NOT_OBSERVED均未改变。

原15秒成片、72积分历史、原源码和正式项目保留；没有复制正式配置、数据库、浏览器账号或用户素材。没有模型调用、真实上传、付费生成、发布、回复、部署、原3090/辅助服务停止或重启、Git提交/推送或无关AgentDock操作。

## 复核

使用已有本地依赖和工具链，不安装、不下载。每次只选择一个定向套件；修改TS后先build。

```text
npm run build
npm run test:go-durable
```

```text
npm run build
npm run test:go-research -- --go <本机go.exe绝对路径> --ego-root <现有ego-lite仓库绝对路径>
```

新库由本仓库迁移SQL创建，未复制已有数据库；不对现有库迁移或重置。故障端口和真实Go集成的结论分别保留。

本机位置指针：`.runtime/go-durable-active.json`、`.runtime/go-research-active.json`、`.runtime/lifecycle-durable-location.json`。原始事件、进程日志、空白库、浏览器Profile、JSON正文和失败尝试仅留`.runtime`，不进入Git。最新汇总为 `.runtime/go-durable-research-checkpoint-20261020.json`；各阶段checkpoint保留独立证据。
