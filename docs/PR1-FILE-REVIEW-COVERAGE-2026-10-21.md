# PR #1 逐文件审查覆盖清单

审查日期：2026-10-21。起始 head 为 `54bbf88b60d93653c3eafbfac6281c291dcae636`，base 为 `67fcac5e5e65183c014a10bfbabfd40a53f7e900`。GitHub 与本地起始集合完全一致：**113 项，无遗漏、重复或以目录代替文件**。C1/C2/C3各新增3项，C4再新增8项（5个此前未出现在PR差异中的既有生产文件、3个新专项文件），当前范围为 **130 项**。新增项在末表单独列出，已修改的原文件仍计入原113项。

这是指定深度的静态审查与证据索引，**不是130个文件的全部路径测试通过证明，也不是独立 GitHub 审核批准**。生产文件按差异与关键调用链复核；旧测试按结构、隔离边界、断言主题与证据声明复核，没有逐条重新证明全部测试断言。原生Go前轮修复结合未变源码与当时证据复核；worker当前运行以C4为准。未报告其他已确认且未修复的代码发现，不等于保证无缺陷。

## C1 前轮补漏与限定运行证据

- **F1 / P1 已修复**：保存指标在只读展示、原计划异常续接/观察和复盘之间没有统一核对原文与投影。现在核对项目、绑定、作品、原文 SHA、数值、可见性、时长及原账号/作者，计划再核对精确 captureKey。不一致保留不可核验或未知读取意图，不推进、重读或调用模型。历史来源字段不充分时保持不可核验，不自动补签。
- **F2 / P2 已修复**：Go 本地正文缓存/显式恢复允许内部目录联接。现在要求原目录实际路径一致、逐层无联接，读取前后核对文件身份与状态；拒绝时不将 PENDING 提升 READY。
- **C1**：`npm run build` 退出 0；本轮唯一 `npm run test:pr1-final-review` **27/27、退出 0**。12 个保存指标审阅、2 个原计划负例、3 个模型前拒绝、10 个本地缓存/恢复文件案例。受原守卫约束，固定内存服务、新建本地合成文件；无业务 DB 查询、Go/SDK/宿主、HTTP/浏览器、平台或模型调用。链接拒绝可能由守卫和提供者共同完成，不据此宣称 OS 级防护。原始日志、SHA 清单、退出记录和 checkpoint 只在本地忽略目录保存。

## C2 当前共享指标 Prisma/HTTP/原生浏览器专项

以 `6174ca5` 为起点，只运行 `npm run test:pr1-metrics-integration` 一个定向套件，构建退出0。最终 **23/23（22子项加父项）、退出0**，两个实际应用进程正常退出0。使用仓库迁移新空库、实际 Prisma 仓库和原服务/HTTP/工作台；指标及空评论页由固定本地函数返回，未查询真实平台。

- **F3 / P1 已修复**：部分指标按键查询核验原版本摘要，但列表读取只解析 JSON；JSON 和内部摘要一同改变、原版本行摘要未变时，列表可能被复盘使用。现在写入返回、按键查询与列表共用版本行核验（ID/项目/类型/key/版本/状态/原摘要），普通数值行也统一核验原文与投影。失败不修复旧记录、不触发新采集。
- **F4 / P2 已修复**：原工作台概览未单独处理指标读取失败，也未按当前原账号核验列表。严格读取失败可能使工作台报错；账号不一致的记录可能进入能力上下文。现在概览核验原绑定及账号，失败返回明确 `metricReadError` 和空指标列表；工作台保持200并明确显示“不可核验”，不把错误解释为零或没有观察。
- 实际覆盖完整零值与不可见指标的两种存储、保存证据 HTTP/HTML、只读数据库不变、11类损坏记录、模型前拒绝、规则整理保存原始观察、实际应用重启、原指标意图已落库后的不重读续接，以及损坏意图不读取后续评论。原意图由夹具显式构造，不是本轮真实进程崩溃注入。
- Tabbit 原生导航、工作台证据链接、零值/不可见显示、取消保持暂停、未勾选拒绝、明确确认仅保存一次原范围续接、损坏页不可核验及损坏项目工作台警示均完成。11类负例同时检查工作台200、错误标记和空指标上下文。后端核对仅一次成功续接 POST，原预算/次数/工作区未改，浏览器期间无新增数据读取；模型配置、执行和生成尝试均为0。离线规则整理不等于真实建议被采用。
- **截图视觉仍 BLOCKED**：截图请求在60000ms执行截止后中断，未取得合格图片。原任务被终止，旧回执随后不可读取；已按恢复流程用新只读任务核对实际保存状态，未重放提交，关闭自建标签并正常 finish。初次隐式页面变为空白的控件查找失败也保留，改为已观察的自有 tab ID 后继续。原生交互成功记录与后端状态不能替代截图视觉验收。

初轮23/23后发现F4，构建成功后只复跑同一专项；最终新空库23/23包含上述工作台检查，两个应用进程及原生浏览器任务正常收尾。截图失败保留在初轮证据中，最终轮没有重复尝试截图；两轮不累计通过数。

本轮无真实 Go/SDK/宿主或平台调用、模型推理、素材外发、付费生成、上传/发布/回复。C1及H历史专项均未重跑；C2只证明上述共享指标切片，其他业务路径、长期worker和真实平台缺口保持。模型 aihubmix/deepseek-v4.1-flash，音频 NOT_OBSERVED、费用 UNKNOWN。

## C3 worker 多执行器与实际数据库专项

以 `44b01c5` 为起点，构建退出0，本轮唯一套件 `npm run test:pr1-worker-db` 最终 **16/16（15子项加父项）、退出0**。使用迁移新建的空白SQLite、实际Prisma仓库和原运营计划/Agent/智能制作服务与worker，原生定时器及多个独立进程。7个应用进程全部观察到退出：5个正常退出0，2个故障注入按预期退出73。

- **F5 / P2 已修复**：ALL智能制作worker只在启动时清理死亡进程租约，其他执行器在其启动后退出会使任务持续被锁住。现在每轮仅对当前策略允许推进的具体任务检查死亡租约；活进程及状态未知的拥有者保持不动。默认禁用策略、MANAGED授权、精确SCOPED范围和人工门禁未扩大。
- 检查双worker领取不重复、跨多个定时轮次的慢读取、人工暂停后旧响应拒写、原180秒租约自然到期后旧响应拒写、读取意图保存后实际进程退出且不重放、认证暂停不自动重试、Agent单次保存读取与未确认人工动作、ALL启动后的死亡租约与活拥有者、MANAGED/SCOPED隔离、停止后无后续扫描及实际worker进程重启。
- 运营计划按原60秒间隔完成两次观察，达到原次数上限后保持终态。慢响应跨180秒到期测试不修改TTL或数据库到期时间；另一个崩溃恢复案例显式注入到期时间，不能把它当作第二次自然到期证明。
- 观察和制作来源检查均为固定本地函数；制作在真实服务的人工审阅状态暂停。未调用模型、平台、Go/SDK/宿主、HTTP或浏览器，没有付费生成或真实建议采用。新库无模型provider、execution或生成attempt记录。
- 原定时器单元测试的一条ALL预期已对齐新增逐任务检查；该旧套件及C1/C2/H历史专项本轮均未运行。首个普通沙箱spawn EPERM单独保留，随后以正常Windows权限运行相同守卫命令；短轮16/16后只复跑同一套件补自然到期，不累计通过数。

最终原生worker观察窗口 **243107ms**；自然到期慢响应等待 **180362ms** 后被另一执行器接续，未改时钟、TTL或到期列；两次原计划指标读取相隔 **65108ms**。预期租约竞争拒绝记录保留，未发现其他worker错误，单进程运营tick最大并发1。全套含启动/收尾约245秒；这些数值不表示所有worker全程没有停止/重启，停止和重启本身也是用例。

数分钟有界运行只证明上述调度、实际数据库竞争和恢复切片，仍缺小时/天级浸泡、大量任务公平性、生产负载、网络/磁盘故障与真实执行端取消等证据；stop只阻止后续调度，不强制取消当前一步。原模型及隔离守卫保持，音频NOT_OBSERVED、费用UNKNOWN。

## C4 worker 稳定性、规模、公平性与本地 I/O 专项

以 `9e049da` 为起点，本轮唯一套件 `npm run test:pr1-worker-scale`。新空库、实际Prisma仓库和原智能制作/Agent服务与worker，双独立执行器、15分钟真实定时器。起始1,024条智能制作记录（480可推进、32活拥有者、128取消终态、384未授权）及160条Agent记录（96到期、32活拥有者、32未来唤醒），运行期间持续注入新合成任务。

最终构建退出0；**11/11（10子项加父项）、套件退出0**，4个应用进程均正常退出0。原生持续检查至少900秒，启动到最终退出记录窗口913850ms（含停止/收尾），完整套件单调计时925572.5259ms（含建数）。15批共120条新增任务最终均到达预期人工审阅状态，最终智能任务1151条、Agent160条；2条真实本地文件错误保持FAILED，其余未授权/活拥有者/未来唤醒对照未变。

两个worker各86次、共172次采样；RSS峰值分别118304768和117665792字节，heapUsed峰值39102512和39724088字节。资源预算与阶段增长断言通过，活动资源采样不等于完整OS句柄审计。预期ENOENT、LEASE_BUSY、检查点拒写和SQLite锁错误计数全部保留，没有把错误日志清空成“无错误”；11项当前源码摘要核验一致。

- **F6 / P2 已修复**：智能worker使用面向页面的最新200条列表，较新的取消或未授权记录可挡住更早的可执行任务。新增专用30条有界索引，先筛选可执行状态或待恢复租约，以及MANAGED原授权，再按稳定ID游标轮转；领域权限仍逐任务复核，普通展示列表不变。待人工审阅后进程退出的租约也保留恢复入口，只清理死亡拥有者，待审正文不变且不触发来源读取。进程重启从头扫描，不能把本地游标当业务许可。
- **F7 / P2 已修复**：Agent前30条未来唤醒或活拥有者可使后续到期任务饥饿。专用索引先排除未来唤醒，再以30条ID游标轮转；活拥有者仍由原租约保护，不抢占、改唤醒时间或自动确认。
- **F8 / P2 已修复**：单任务死亡租约检查异常原先会中断整轮列表。现在保留该错误，继续审阅当前策略允许的其他任务，失败任务在下一轮扫描重试。本轮以恢复端口中的真实本地ENOENT验证这个分支，不把它称为真实设备故障。
- 实际SQLite独占锁触发读取/写入错误，解锁后原worker恢复；指定检查点触发器在SQLite事务中拒绝写入，核对版本和检查点全部回滚，解除后恢复。缺文件与向目录写入保留真实文件错误和FAILED状态，其他任务继续。触发器是逻辑写入失败注入，不是断电或磁盘耗尽；重复的失败前本地来源读取不称外部请求恰好一次。
- MANAGED原生运行跨多页处理积压，活租约、未授权记录及未来唤醒记录逐字节保持；每分钟继续送入8条新合成任务。每轮最多30条，队列扩大后单任务轮询间隔随页数增加，不承诺固定响应延迟或严格FIFO。采样进程内存、活动资源和页大小，检查预算与阶段增长，不将有限采样称无内存泄漏或生产吞吐SLO。
- 首轮夹具错误地把无成片证据记录标COMPLETED，原领域校验正确拒绝；改为合法CANCELLED并构建后只复跑同一套件。中间15分钟11/11后，补入待审死亡租约兼容路径及实际退出案例，再构建并仅复跑同一套件。失败、各轮退出和源码摘要分别保留，不累计通过数。C1/C2/C3/H历史专项均未重跑，尤其C3自然租约/重启与C2浏览器证据不能称当前组合已全部重验。

本轮没有真实模型、平台、HTTP/浏览器、Go/SDK/宿主调用，无付费生成/外发/上传/发布/回复。ALL及MANAGED旧精确范围索引分支、备用内存端口、万级以上任务、小时/天级浸泡、生产SLO、OS文件句柄完整审计、真实设备EIO/ENOSPC/断电及跨平台仍缺独立运行证据；模型、默认禁用与人工门禁保持。

## 历史证据索引

表内 H 仅表示相关历史专项，不承诺文件全部路径被覆盖；**本轮均未重跑**。共享源码有新修改时，更不能把旧通过数当作当前组合的通过数。所有历史文档中的“本轮”“尚未提交”等均对应文档当时的时间。

| 标记 | 证据范围 |
| --- | --- |
| H1 | 原 Go 本机桥、原 Agent 门禁与界面；[历史记录](GO-EGO-BRIDGE-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H2 | 生命周期/新空库/只读正文与发布后恢复；[历史记录](GO-DURABLE-RESEARCH-ISOLATED-ACCEPTANCE-2026-10-20.md)、[补齐时点](EGO-COMPLETION-STATUS-2026-10-20.md) |
| H3 | 保存研究正文只读 HTTP/浏览器；[历史记录](RESEARCH-EVIDENCE-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H4 | Go 原会话接线；[历史记录](U1-GO-SESSION-ISOLATED-ACCEPTANCE-2026-10-20.md)，非真人登录归还 |
| H6 | U3 新空库/文件状态替身、原 HTTP/点击 16 项；[历史记录](U3-PREFLIGHT-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H7 | U2 合成媒体和固定语义响应 29 项；[历史记录](U2-MEDIA-EVIDENCE-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H8 | U4/U5 固定读取、新空库与进程故障 30 项；[历史记录](U4-SCHEDULE-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H9 | U4/U5 原工作台只读审阅及续接 23 项；[历史记录](U45-WORKBENCH-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md) |
| H10 | 父子原子续接实际 Prisma 19 项；[分轮记录](PUBLIC-CHANGE-REVIEW-2026-10-21.md#pr-1-续审修复) |
| H11 | 研究缓存/保存证据实际只读 HTTP 22 项；[分轮记录](PUBLIC-CHANGE-REVIEW-2026-10-21.md#pr-1-研究缓存与保存证据续审) |
| H12 | 固定 JSONL、文件与内存来源续接 45 项；[分轮记录](PUBLIC-CHANGE-REVIEW-2026-10-21.md#pr-1-go-回执截图目标与来源续接续审) |
| H13 | Go 原生合成进程/worker 定时器 34 项；[分轮记录](PUBLIC-CHANGE-REVIEW-2026-10-21.md#pr-1-go-本体取消超时与-worker-续审)；非真实宿主取消或长期运行 |

## 起始 113 项

| 编号 | 文件 | 复核深度 | 审查焦点与结果 | 关联运行证据 |
| --- | --- | --- | --- | --- |
| 001 | [.gitignore](../.gitignore) | 公开范围 | 私有配置/DB/媒体/证据忽略与公开文档精确白名单 | 清单核对 |
| 002 | [README.md](../README.md) | 公开说明复核 | 当前/历史证据区分及真实执行默认拒绝；本轮清单入口 | 说明 |
| 003 | [docs/EGO-COMPLETION-STATUS-2026-10-20.md](../docs/EGO-COMPLETION-STATUS-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；EGO-COMPLETION-STATUS | 说明/历史；非本轮执行 |
| 004 | [docs/GO-DURABLE-RESEARCH-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/GO-DURABLE-RESEARCH-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；GO-DURABLE-RESEARCH-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 005 | [docs/GO-EGO-BRIDGE-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/GO-EGO-BRIDGE-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；GO-EGO-BRIDGE-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 006 | [docs/PUBLIC-CHANGE-REVIEW-2026-10-21.md](../docs/PUBLIC-CHANGE-REVIEW-2026-10-21.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；PUBLIC-CHANGE-REVIEW | 说明/历史；非本轮执行 |
| 007 | [docs/RESEARCH-EVIDENCE-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/RESEARCH-EVIDENCE-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；RESEARCH-EVIDENCE-REVIEW-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 008 | [docs/U1-GO-SESSION-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/U1-GO-SESSION-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；U1-GO-SESSION-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 009 | [docs/U2-MEDIA-EVIDENCE-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/U2-MEDIA-EVIDENCE-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；U2-MEDIA-EVIDENCE-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 010 | [docs/U3-PREFLIGHT-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/U3-PREFLIGHT-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；U3-PREFLIGHT-DURABILITY-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 011 | [docs/U4-SCHEDULE-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/U4-SCHEDULE-DURABILITY-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；U4-SCHEDULE-DURABILITY-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 012 | [docs/U45-WORKBENCH-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md](../docs/U45-WORKBENCH-REVIEW-ISOLATED-ACCEPTANCE-2026-10-20.md) | 公开说明复核 | 历史时点、证据分层、失败保留、授权与未验收声明；U45-WORKBENCH-REVIEW-ISOLATED-ACCEPTANCE | 说明/历史；非本轮执行 |
| 013 | [execution/go-ego-bridge/go.mod](../execution/go-ego-bridge/go.mod) | 依赖契约 | 仅标准库，无外部模块；本地工具链与下载拒绝边界 | H13；非跨平台验证 |
| 014 | [execution/go-ego-bridge/main.go](../execution/go-ego-bridge/main.go) | 原生差异/前轮证据 | 固定模式、SHA/宿主绑定、有界输出、取消/超时收尾；复核前轮修复 | H1,H2,H4,H13 |
| 015 | [execution/go-ego-bridge/main_test.go](../execution/go-ego-bridge/main_test.go) | 结构/边界/证据声明 | 本机继承管道/取消/超时与 worker 定时器；合成进程退出证据 | H13 |
| 016 | [execution/go-ego-bridge/worker.mjs](../execution/go-ego-bridge/worker.mjs) | 固定程序静态 | 固定 SDK 程序只面向 nonce 自有页；控制权/布局诊断非授权 | H1,H2,H4 |
| 017 | [package.json](../package.json) | 脚本契约 | 仅显式定向脚本；默认 test/启动/模型/守卫策略未扩大 | C1 构建/运行入口 |
| 018 | [scripts/run-evidence-review-isolated.mjs](../scripts/run-evidence-review-isolated.mjs) | 运行器静态 | 原只读 HTTP、保存证据和浏览器分层；不触发新采集；会话/env/参数/子进程退出/最终回执 | H3 |
| 019 | [scripts/run-go-bridge-isolated.mjs](../scripts/run-go-bridge-isolated.mjs) | 运行器静态 | 原 Agent 具体确认、scope、固定本机 Go 执行与终态；会话/env/参数/子进程退出/最终回执 | H1 |
| 020 | [scripts/run-go-capture-durability.mjs](../scripts/run-go-capture-durability.mjs) | 运行器静态 | 占位竞争、文件已发布后异常及显式恢复，新空库固定采集；会话/env/参数/子进程退出/最终回执 | H2 |
| 021 | [scripts/run-go-lifecycle-durability.mjs](../scripts/run-go-lifecycle-durability.mjs) | 运行器静态 | 原 Agent 生命周期、保存进度、故障退出与死租约；会话/env/参数/子进程退出/最终回执 | H2 |
| 022 | [scripts/run-go-research-isolated.mjs](../scripts/run-go-research-isolated.mjs) | 运行器静态 | 本地动态正文到原 Research/Evidence，新库与独立宿主；会话/env/参数/子进程退出/最终回执 | H2 |
| 023 | [scripts/run-go-u1-session.mjs](../scripts/run-go-u1-session.mjs) | 运行器静态 | 明确独立宿主/原 Space 会话、隐藏与控制变化，非真人登录；会话/env/参数/子进程退出/最终回执 | H4 |
| 024 | [scripts/run-pr1-go-receipt.mjs](../scripts/run-pr1-go-receipt.mjs) | 运行器静态 | 固定 JSONL 协议、截图路径与 source-only 重定向续接；会话/env/参数/子进程退出/最终回执 | H12 |
| 025 | [scripts/run-pr1-research-cache.mjs](../scripts/run-pr1-research-cache.mjs) | 运行器静态 | 缓存完整性、损坏元数据、原只读 HTTP 与固定采集端；会话/env/参数/子进程退出/最终回执 | H11 |
| 026 | [scripts/run-pr1-resume-atomic.mjs](../scripts/run-pr1-resume-atomic.mjs) | 运行器静态 | 原父子版本/范围/租约冲突与真实事务回滚夹具；会话/env/参数/子进程退出/最终回执 | H10 |
| 027 | [scripts/run-pr1-worker-lifecycle.mjs](../scripts/run-pr1-worker-lifecycle.mjs) | 运行器静态 | 本机继承管道/取消/超时与 worker 定时器；合成进程退出证据；会话/env/参数/子进程退出/最终回执 | H13 |
| 028 | [scripts/run-u2-evidence-integrity.mjs](../scripts/run-u2-evidence-integrity.mjs) | 运行器静态 | 新合成媒体、采样时间戳、文件/下游失效；固定语义响应；会话/env/参数/子进程退出/最终回执 | H7 |
| 029 | [scripts/run-u3-preflight-durability.mjs](../scripts/run-u3-preflight-durability.mjs) | 运行器静态 | 原成片准备占位、接管归还与未知提交，文件状态替身；会话/env/参数/子进程退出/最终回执 | H6 |
| 030 | [scripts/run-u4-schedule-durability.mjs](../scripts/run-u4-schedule-durability.mjs) | 运行器静态 | 新空库/实际进程故障、租约与 U5 冻结链，固定读取响应；会话/env/参数/子进程退出/最终回执 | H8 |
| 031 | [scripts/run-u45-workbench-review.mjs](../scripts/run-u45-workbench-review.mjs) | 运行器静态 | 原工作台只读证据与具体续接；固定数据、HTTP/点击分层；会话/env/参数/子进程退出/最终回执 | H9 |
| 032 | [src/adapters/ai/hermes-product-director-generator.ts](../src/adapters/ai/hermes-product-director-generator.ts) | 差异/关键调用链 | 参考快照冻结；模型请求前后核验；注入验证器 | H7 |
| 033 | [src/adapters/db/operations-write-fence.ts](../src/adapters/db/operations-write-fence.ts) | 差异/关键调用链及实际DB | 进程内写入权限类型与事务内租约/截止时间护栏 | H8；C3暂停/自然到期后拒写 |
| 034 | [src/adapters/db/prisma-artifact-repository.ts](../src/adapters/db/prisma-artifact-repository.ts) | 差异/关键调用链 | 不可变属性拒绝，保存证据读取调用方 | H7,H11 |
| 035 | [src/adapters/db/prisma-browser-publish-checkpoints.ts](../src/adapters/db/prisma-browser-publish-checkpoints.ts) | 差异/关键调用链 | 版本 CAS、原成片双占位、事务与历史检查点完整性 | H6 |
| 036 | [src/adapters/db/prisma-douyin-collection-repository.ts](../src/adapters/db/prisma-douyin-collection-repository.ts) | 差异/关键调用链及实际DB | 按原请求查询；人工续接版本/租约约束 | H8,H10；C3固定空评论页保存，不含全部分页竞争 |
| 037 | [src/adapters/db/prisma-douyin-operations-schedule-repository.ts](../src/adapters/db/prisma-douyin-operations-schedule-repository.ts) | 差异/关键调用链及实际多进程 | 数据库行与 JSON 范围一致；父子单事务续接及租约 | H8,H9,H10；C3领取/暂停/自然到期/旧拥有者 |
| 038 | [src/adapters/db/prisma-douyin-ops-repository.ts](../src/adapters/db/prisma-douyin-ops-repository.ts) | 差异/关键调用链及实际DB | 保存事务写护栏；F3普通/部分指标统一读取核验 | H8；C2指标读取/列表/写入返回；C3部分指标拒绝过期写入 |
| 039 | [src/adapters/db/prisma-product-flow-repository.ts](../src/adapters/db/prisma-product-flow-repository.ts) | 差异/关键调用链 | 保存版本 ID/项目/版本/内容哈希核验 | H9 |
| 040 | [src/adapters/db/prisma-reference-video-repository.ts](../src/adapters/db/prisma-reference-video-repository.ts) | 差异/关键调用链 | 活动/过期分析记录与内容绑定；v3 摘要 | H7 |
| 041 | [src/adapters/publish/ego-staged-publisher-runtime.ts](../src/adapters/publish/ego-staged-publisher-runtime.ts) | 差异/关键调用链 | 候选本机网址、显式端口和原服务保护端口限制 | H6 |
| 042 | [src/adapters/research/ego-browser-research-provider.ts](../src/adapters/research/ego-browser-research-provider.ts) | 差异/关键调用链 | 原会话、完整缓存摘要、正文/截图及控制权检查 | H4,H11 |
| 043 | [src/adapters/research/go-local-research-provider.ts](../src/adapters/research/go-local-research-provider.ts) | 差异/关键调用链 | 占位、显式文件收尾、缓存与原路径；F2 已修复 | H2；C1 文件案例 |
| 044 | [src/adapters/research/go-owned-ego-research-runtime.ts](../src/adapters/research/go-owned-ego-research-runtime.ts) | 差异/关键调用链 | 模式对应事件、scope/page/session、截图目标前后核验 | H4,H12 |
| 045 | [src/adapters/store/local-artifact-store.ts](../src/adapters/store/local-artifact-store.ts) | 差异/关键调用链 | 不可覆盖发布；Go PENDING 延后；不自动清理活动正文目录 | H2 |
| 046 | [src/application/ports/agent-capability.ts](../src/application/ports/agent-capability.ts) | 差异/关键调用链 | 可选本机信号与进度端口，不扩展业务授权 | H1,H2 |
| 047 | [src/application/ports/douyin-collection-repository.ts](../src/application/ports/douyin-collection-repository.ts) | 差异/关键调用链 | 原请求查询与人工续接端口；保留版本语义 | H8,H10 |
| 048 | [src/application/ports/douyin-operations-schedule-repository.ts](../src/application/ports/douyin-operations-schedule-repository.ts) | 差异/关键调用链 | 持久租约、只读检查与原父子快照原子续接契约 | H8,H9,H10 |
| 049 | [src/application/ports/douyin-ops-repository.ts](../src/application/ports/douyin-ops-repository.ts) | 差异/关键调用链 | 保存事务的可选进程内写入护栏，不接受 HTTP 授权字段 | H8 |
| 050 | [src/application/ports/ego-research-runtime.ts](../src/application/ports/ego-research-runtime.ts) | 差异/关键调用链 | 显式自有来源可选绑定，无登录/发布接口 | H4 |
| 051 | [src/application/ports/operations-write-fence.ts](../src/application/ports/operations-write-fence.ts) | 差异/关键调用链 | 进程内写入权限类型与事务内租约/截止时间护栏 | H8 |
| 052 | [src/application/ports/product-flow-repository.ts](../src/application/ports/product-flow-repository.ts) | 差异/关键调用链 | 只读核验历史版本端口，不引入写入副作用 | H9 |
| 053 | [src/application/ports/research-provider.ts](../src/application/ports/research-provider.ts) | 差异/关键调用链 | 冻结正文/图片文件摘要与旧回执兼容边界 | H11 |
| 054 | [src/application/ports/research-repository.ts](../src/application/ports/research-repository.ts) | 差异/关键调用链 | 持久化 collectionOnly 仅减少工作，不恢复模型许可 | H4,H12 |
| 055 | [src/application/services/agent-cycle-service.ts](../src/application/services/agent-cycle-service.ts) | 差异/关键调用链及实际worker | 原确认门禁；F7到期有界游标扫描 | H1,H2,H13；C3历史；C4积压与未来唤醒/活拥有者 |
| 056 | [src/application/services/ai-generation.ts](../src/application/services/ai-generation.ts) | 差异/关键调用链 | 参考证据与采用反馈在初次/纠错/使用规则请求前后核验 | H7,H8 |
| 057 | [src/application/services/browser-publish-preparation-service.ts](../src/application/services/browser-publish-preparation-service.ts) | 差异/关键调用链 | 原账号/scopeHash/最新版本确认，接管归还分阶段 | H6 |
| 058 | [src/application/services/douyin-collection-service.ts](../src/application/services/douyin-collection-service.ts) | 差异/关键调用链 | 原账号/游标续接；读取与保存前护栏传递 | H8,H10 |
| 059 | [src/application/services/douyin-comment-service.ts](../src/application/services/douyin-comment-service.ts) | 差异/关键调用链 | 异步账号校验后再检查读护栏，事务保存传递 | H8 |
| 060 | [src/application/services/douyin-metric-service.ts](../src/application/services/douyin-metric-service.ts) | 差异/关键调用链及实际worker | 指标缺项不补零；读取/保存护栏与原 captureKey | H8；C3固定读取、暂停/到期拒写 |
| 061 | [src/application/services/douyin-operations-schedule-service.ts](../src/application/services/douyin-operations-schedule-service.ts) | 差异/关键调用链及原生worker | 未知读取意图、预算/期限、原父子续接；F1 已修复 | H8,H10；C1负例；C2实际步骤/重启/保存意图；C3双进程/自然TTL/实际重启 |
| 062 | [src/application/services/douyin-read-evidence-audit.ts](../src/application/services/douyin-read-evidence-audit.ts) | 差异/关键调用链 | 评论原文对照；保存指标原文/数值/可见性/账号核验 | H7；C1、C2仅保存指标相关路径 |
| 063 | [src/application/services/douyin-retrospective-service.ts](../src/application/services/douyin-retrospective-service.ts) | 差异/关键调用链 | 冻结原始指标/评论真实性和原账号；F1 已修复 | H8；C1拒绝；C2实际规则整理与负例，非模型 |
| 064 | [src/application/services/operations-evidence-reader.ts](../src/application/services/operations-evidence-reader.ts) | 差异/关键调用链 | 只读计划、指标、原候选输入和历史反馈；F1 已修复 | H9,H10；C1；C2指标HTTP/HTML，非候选全链 |
| 065 | [src/application/services/product-director.ts](../src/application/services/product-director.ts) | 差异/关键调用链 | 当前参考与输入/输出引用一致；使用规则核验前后检查 | H7 |
| 066 | [src/application/services/publish-bridge-service.ts](../src/application/services/publish-bridge-service.ts) | 差异/关键调用链 | 任何同成片准备检查点都阻止换包绕过占位 | H6 |
| 067 | [src/application/services/pvs-agent-capabilities.ts](../src/application/services/pvs-agent-capabilities.ts) | 差异/关键调用链及实际上下文 | 原范围 HUMAN_DECISION 续接；F4指标原账号核验及显式错误状态 | H8,H9；C2损坏指标上下文 |
| 068 | [src/application/services/reference-video-analysis.ts](../src/application/services/reference-video-analysis.ts) | 差异/关键调用链 | 源视频、帧、采样清单及活动版本；禁止历史证据自动补签 | H7 |
| 069 | [src/application/services/reference-video-evidence.ts](../src/application/services/reference-video-evidence.ts) | 差异/关键调用链 | 文件/链接/字节摘要；下游初次及纠错请求前后核验 | H7 |
| 070 | [src/application/services/research-evidence-reader.ts](../src/application/services/research-evidence-reader.ts) | 差异/关键调用链 | 原研究归属、正文回执和保存文件；截图不宣称已验证 | H2,H3,H11 |
| 071 | [src/application/services/research-service.ts](../src/application/services/research-service.ts) | 差异/关键调用链 | 明确仅采集模式、阻断摘要；续接识别冻结原始重定向来源 | H2,H4,H12 |
| 072 | [src/application/services/saved-research-artifact.ts](../src/application/services/saved-research-artifact.ts) | 差异/关键调用链 | 大小上限、原研究目录、链接/稳定性/文件摘要共用核验 | H11 |
| 073 | [src/application/services/smart-generation-worker.ts](../src/application/services/smart-generation-worker.ts) | 差异/关键调用链及原生定时器/DB | F5精确死租约；F6有界游标；F8逐任务恢复错误隔离 | H13/C3历史；C4 MANAGED多页/活拥有者/故障恢复 |
| 074 | [src/domain/agent-cycle.ts](../src/domain/agent-cycle.ts) | 差异/关键调用链 | 本机执行反馈字段，不替代业务状态与授权 | H1,H2 |
| 075 | [src/domain/douyin-feedback-validation.ts](../src/domain/douyin-feedback-validation.ts) | 差异/关键调用链 | 冻结来源、原始 ID、时间窗、覆盖计数与引用一致 | H7,H8 |
| 076 | [src/domain/douyin-operations-schedule.ts](../src/domain/douyin-operations-schedule.ts) | 差异/关键调用链 | 读取意图协议、历史次数/检查点/父评论上限 | H8,H10 |
| 077 | [src/domain/schemas.ts](../src/domain/schemas.ts) | 差异/关键调用链 | 采样清单引用仅为可选历史兼容；执行端仍要求充分证据 | H7 |
| 078 | [src/web/agent-cycle-http.ts](../src/web/agent-cycle-http.ts) | 差异/关键调用链 | 本机/令牌门禁沿用；页面仅注入只读运营概览 | H1,H9 |
| 079 | [src/web/agent-cycle-ui.ts](../src/web/agent-cycle-ui.ts) | 差异/关键调用链及原生交互 | 转义输出、仅具体动作确认、本机取消状态、只读证据入口；F4指标错误警示 | H1,H9；C2工作台200及不可核验提示 |
| 080 | [src/web/browser-publish-preflight-ui.ts](../src/web/browser-publish-preflight-ui.ts) | 差异/关键调用链 | 接管和归还都携带最新账号/范围/版本，提交仍单独确认 | H6 |
| 081 | [src/web/operations-evidence-http.ts](../src/web/operations-evidence-http.ts) | 差异/关键调用链及HTTP | 本机同源、只读方法、限长JSON、明确原计划续接 | H9；C2保存指标及一次原计划续接 |
| 082 | [src/web/operations-evidence-ui.ts](../src/web/operations-evidence-ui.ts) | 差异/关键调用链及原生交互 | 保存覆盖不升级全量；具体原范围确认 | H9；C2指标回显/确认链；截图BLOCKED |
| 083 | [src/web/research-evidence-http.ts](../src/web/research-evidence-http.ts) | 差异/关键调用链 | 只读方法、原研究 URL、正文转义与 CSP，不重新采集 | H3,H11 |
| 084 | [src/web/server.ts](../src/web/server.ts) | 差异/关键调用链 | 默认拒绝执行工厂、只读接线、参考验证器注入与发布确认字段 | H3,H6,H7,H9,H11 |
| 085 | [src/web/workbench-ui.ts](../src/web/workbench-ui.ts) | 差异/关键调用链 | 仅采集状态不暗示摘要生成；保存正文链接与不重采说明 | H2,H3 |
| 086 | [tests/go-bridge-business-fixture.ts](../tests/go-bridge-business-fixture.ts) | 结构/边界/证据声明 | 原 Agent 具体确认、scope、固定本机 Go 执行与终态 | H1 |
| 087 | [tests/go-bridge-lifecycle-fixture.ts](../tests/go-bridge-lifecycle-fixture.ts) | 结构/边界/证据声明 | 原 Agent 具体确认、scope、固定本机 Go 执行与终态 | H1 |
| 088 | [tests/go-capture-durability-fixture.ts](../tests/go-capture-durability-fixture.ts) | 结构/边界/证据声明 | 占位竞争、文件已发布后异常及显式恢复，新空库固定采集 | H2 |
| 089 | [tests/go-capture-durability-isolated.test.mjs](../tests/go-capture-durability-isolated.test.mjs) | 结构/边界/证据声明 | 占位竞争、文件已发布后异常及显式恢复，新空库固定采集 | H2 |
| 090 | [tests/go-ego-bridge-isolated.test.mjs](../tests/go-ego-bridge-isolated.test.mjs) | 结构/边界/证据声明 | 原 Agent 具体确认、scope、固定本机 Go 执行与终态 | H1 |
| 091 | [tests/go-lifecycle-durability-isolated.test.mjs](../tests/go-lifecycle-durability-isolated.test.mjs) | 结构/边界/证据声明 | 原 Agent 生命周期、保存进度、故障退出与死租约 | H2 |
| 092 | [tests/go-lifecycle-durable-fixture.ts](../tests/go-lifecycle-durable-fixture.ts) | 结构/边界/证据声明 | 原 Agent 生命周期、保存进度、故障退出与死租约 | H2 |
| 093 | [tests/go-research-chain-fixture.ts](../tests/go-research-chain-fixture.ts) | 结构/边界/证据声明 | 本地动态正文到原 Research/Evidence，新库与独立宿主 | H2 |
| 094 | [tests/go-research-isolated.test.mjs](../tests/go-research-isolated.test.mjs) | 结构/边界/证据声明 | 本地动态正文到原 Research/Evidence，新库与独立宿主 | H2 |
| 095 | [tests/go-u1-session-fixture.ts](../tests/go-u1-session-fixture.ts) | 结构/边界/证据声明 | 明确独立宿主/原 Space 会话、隐藏与控制变化，非真人登录 | H4 |
| 096 | [tests/go-u1-session-isolated.test.mjs](../tests/go-u1-session-isolated.test.mjs) | 结构/边界/证据声明 | 明确独立宿主/原 Space 会话、隐藏与控制变化，非真人登录 | H4 |
| 097 | [tests/pr1-go-receipt-fixture.ts](../tests/pr1-go-receipt-fixture.ts) | 结构/边界/证据声明 | 固定 JSONL 协议、截图路径与 source-only 重定向续接 | H12 |
| 098 | [tests/pr1-go-receipt-isolated.test.mjs](../tests/pr1-go-receipt-isolated.test.mjs) | 结构/边界/证据声明 | 固定 JSONL 协议、截图路径与 source-only 重定向续接 | H12 |
| 099 | [tests/pr1-research-cache-fixture.ts](../tests/pr1-research-cache-fixture.ts) | 结构/边界/证据声明 | 缓存完整性、损坏元数据、原只读 HTTP 与固定采集端 | H11 |
| 100 | [tests/pr1-research-cache-isolated.test.mjs](../tests/pr1-research-cache-isolated.test.mjs) | 结构/边界/证据声明 | 缓存完整性、损坏元数据、原只读 HTTP 与固定采集端 | H11 |
| 101 | [tests/pr1-resume-atomic-fixture.ts](../tests/pr1-resume-atomic-fixture.ts) | 结构/边界/证据声明 | 原父子版本/范围/租约冲突与真实事务回滚夹具 | H10 |
| 102 | [tests/pr1-resume-atomic-isolated.test.mjs](../tests/pr1-resume-atomic-isolated.test.mjs) | 结构/边界/证据声明 | 原父子版本/范围/租约冲突与真实事务回滚夹具 | H10 |
| 103 | [tests/pr1-worker-lifecycle.test.ts](../tests/pr1-worker-lifecycle.test.ts) | 结构/边界/预期对齐，未运行 | ALL预期对齐F5逐任务检查；旧定时器案例本轮未执行 | H13历史，不称当前运行通过 |
| 104 | [tests/research-evidence-review-fixture.ts](../tests/research-evidence-review-fixture.ts) | 结构/边界/证据声明 | 原只读 HTTP、保存证据和浏览器分层；不触发新采集 | H3 |
| 105 | [tests/research-evidence-review-isolated.test.mjs](../tests/research-evidence-review-isolated.test.mjs) | 结构/边界/证据声明 | 原只读 HTTP、保存证据和浏览器分层；不触发新采集 | H3 |
| 106 | [tests/u2-evidence-integrity-fixture.ts](../tests/u2-evidence-integrity-fixture.ts) | 结构/边界/证据声明 | 新合成媒体、采样时间戳、文件/下游失效；固定语义响应 | H7 |
| 107 | [tests/u2-evidence-integrity-isolated.test.mjs](../tests/u2-evidence-integrity-isolated.test.mjs) | 结构/边界/证据声明 | 新合成媒体、采样时间戳、文件/下游失效；固定语义响应 | H7 |
| 108 | [tests/u3-preflight-durability-isolated.test.mjs](../tests/u3-preflight-durability-isolated.test.mjs) | 结构/边界/证据声明 | 原成片准备占位、接管归还与未知提交，文件状态替身 | H6 |
| 109 | [tests/u3-preflight-durable-fixture.ts](../tests/u3-preflight-durable-fixture.ts) | 结构/边界/证据声明 | 原成片准备占位、接管归还与未知提交，文件状态替身 | H6 |
| 110 | [tests/u4-schedule-durability-fixture.ts](../tests/u4-schedule-durability-fixture.ts) | 结构/边界/证据声明 | 新空库/实际进程故障、租约与 U5 冻结链，固定读取响应 | H8 |
| 111 | [tests/u4-schedule-durability-isolated.test.mjs](../tests/u4-schedule-durability-isolated.test.mjs) | 结构/边界/证据声明 | 新空库/实际进程故障、租约与 U5 冻结链，固定读取响应 | H8 |
| 112 | [tests/u45-workbench-review-fixture.ts](../tests/u45-workbench-review-fixture.ts) | 结构/边界/证据声明 | 原工作台只读证据与具体续接；固定数据、HTTP/点击分层 | H9 |
| 113 | [tests/u45-workbench-review-isolated.test.mjs](../tests/u45-workbench-review-isolated.test.mjs) | 结构/边界/证据声明 | 原工作台只读证据与具体续接；固定数据、HTTP/点击分层 | H9 |

## C1 新增 3 项

| 编号 | 文件 | 复核深度 | 审查焦点与结果 | 关联运行证据 |
| --- | --- | --- | --- | --- |
| N1 | [docs/PR1-FILE-REVIEW-COVERAGE-2026-10-21.md](../docs/PR1-FILE-REVIEW-COVERAGE-2026-10-21.md) | 清单自检 | 113 项唯一登记与最终文件集合核对；明确审查深度和剩余项 | 集合核对 |
| N2 | [scripts/run-pr1-final-review.mjs](../scripts/run-pr1-final-review.mjs) | 本轮源码/执行 | 保存指标与 Go 本地文件补漏；固定服务、新文件、零采集/模型 | C1 |
| N3 | [tests/pr1-final-review.test.ts](../tests/pr1-final-review.test.ts) | 本轮源码/执行 | 保存指标与 Go 本地文件补漏；固定服务、新文件、零采集/模型 | C1 |

## C2 新增 3 项

| 编号 | 文件 | 复核深度 | 审查焦点与结果 | 关联运行证据 |
| --- | --- | --- | --- | --- |
| N4 | [scripts/run-pr1-metrics-integration.mjs](../scripts/run-pr1-metrics-integration.mjs) | 本轮运行器静态/实际退出 | 新会话、净化env、单专项、子进程与最终回执 | C2 |
| N5 | [tests/pr1-metrics-integration-fixture.ts](../tests/pr1-metrics-integration-fixture.ts) | 本轮源码/实际DB与HTTP | 原Prisma/服务/路由、固定读取、数据篡改及应用重启 | C2 |
| N6 | [tests/pr1-metrics-integration-isolated.test.mjs](../tests/pr1-metrics-integration-isolated.test.mjs) | 本轮实际执行 | 新空库、HTTP断言、浏览器交互与后端状态交叉核验 | C2；截图BLOCKED |

## C3 新增 3 项

| 编号 | 文件 | 复核深度 | 审查焦点与结果 | 关联运行证据 |
| --- | --- | --- | --- | --- |
| N7 | [scripts/run-pr1-worker-db.mjs](../scripts/run-pr1-worker-db.mjs) | 本轮运行器静态/实际退出 | 新会话、净化env、原守卫、单专项、子进程实际退出与最终回执 | C3 |
| N8 | [tests/pr1-worker-db-fixture.ts](../tests/pr1-worker-db-fixture.ts) | 本轮源码/实际Prisma与worker | 原服务/原生定时器、固定观察、暂停/到期/退出故障 | C3 |
| N9 | [tests/pr1-worker-db-isolated.test.mjs](../tests/pr1-worker-db-isolated.test.mjs) | 本轮实际执行 | 共享新空库、多进程竞争、自然TTL、确认门禁和退出核验 | C3 |

## C4 新增到 PR 差异的 8 项

| 编号 | 文件 | 复核深度 | 审查焦点与结果 | 关联运行证据 |
| --- | --- | --- | --- | --- |
| N10 | [src/adapters/db/prisma-agent-cycle-repository.ts](../src/adapters/db/prisma-agent-cycle-repository.ts) | 本轮索引差异/实际Prisma | F7先筛到期再按ID有界轮转；其余既有仓库路径非本轮全验 | C4 |
| N11 | [src/adapters/db/prisma-smart-run-repository.ts](../src/adapters/db/prisma-smart-run-repository.ts) | 本轮索引差异/实际Prisma | F6状态/原授权在limit前过滤；事务写入回滚 | C4 MANAGED；ALL分支未独立验收 |
| N12 | [src/application/ports/agent-cycle-repository.ts](../src/application/ports/agent-cycle-repository.ts) | 端口与兼容复核 | 可选只读worker页与稳定游标，不扩大业务权限 | C4实际Prisma实现 |
| N13 | [src/application/ports/smart-run-repository.ts](../src/application/ports/smart-run-repository.ts) | 端口与兼容复核 | 可选有界worker索引，区分ALL/MANAGED原范围 | C4实际Prisma实现 |
| N14 | [src/application/services/smart-generation-service.ts](../src/application/services/smart-generation-service.ts) | 新索引差异/关键调用链 | 委托Prisma索引与内存端口兼容；原人工暂停及失败落库 | C4新索引/来源暂停；非全制作链 |
| N15 | [scripts/run-pr1-worker-scale.mjs](../scripts/run-pr1-worker-scale.mjs) | 本轮运行器/实际退出 | 新会话、净化env、原守卫、单专项与最终回执 | C4 |
| N16 | [tests/pr1-worker-scale-fixture.ts](../tests/pr1-worker-scale-fixture.ts) | 本轮源码/实际DB与文件 | 合成积压、固定来源、活拥有者及真实本地文件错误 | C4 |
| N17 | [tests/pr1-worker-scale-isolated.test.mjs](../tests/pr1-worker-scale-isolated.test.mjs) | 本轮实际执行 | 15分钟/规模/脉冲新任务/资源采样/SQLite锁与事务错误 | C4 |

## 明确剩余未验收项

| 编号 | 尚缺证据 | 当前边界与下一步 |
| --- | --- | --- |
| R1 | 实际配置入口、Node/Ego CLI/SDK/宿主的取消/超时与异常断连 | H13 只回收直接工作进程，后代/宿主动作可能仍存在；remoteActionsRolledBack=false，不自动终止其他 Space 或恢复旧许可 |
| R2 | 小时/天级浸泡、更大规模/真实负载/性能SLO与真实设备故障 | C4补15分钟、千条积压、MANAGED/Agent公平扫描及本地SQLite/文件错误；ALL索引独立运行、万级任务、设备EIO/ENOSPC/断电等仍缺。C3自然TTL/重启为历史，stop不强制取消当前一步 |
| R3 | 共享指标之外的当前组合回归及截图视觉 | C2已完成指标切片的实际Prisma/HTTP/原生交互23项；截图执行截止仍BLOCKED，其他H8/H9/H10等路径未重跑，不扩称全部U1–U5或全路径通过 |
| R4 | U1 真人登录/验证码后归还原会话 | 固定自有页成功不证明真人归还；账号与实际验证由用户处理，旧句柄/权限不自动恢复 |
| R5 | U2 实际模型推理、媒体外发、音频与费用 | 模型保持 aihubmix/deepseek-v4.1-flash；音频 NOT_OBSERVED、费用 UNKNOWN，不自动发素材/调用模型/计费或切模型 |
| R6 | U3 真实编辑态、真实上传/提交与可信作品回执 | 真实编辑态仍 BLOCKED；本机文件状态替身不能证明上传，原成片占位不自动释放，预检/归还不等于发布授权 |
| R7 | U4 当前新片真实账号下的指标/评论有界采集 | 固定读取/新库不代表当前真实观察；保留真实父评论第二页历史，不拼接成新片闭环，无回复权限扩张 |
| R8 | U5 真实待审建议的明确采用及后续作品效果 | 未实际采用；相关性不能当因果或商业效果，采用也不授予付费生成/发布/回复许可 |
| R9 | 跨平台/新环境安装、完整当前源码 CI | 本地 Windows 验证不代表非 Windows；没有本轮全新网络安装或完整组合测试证据 |
| R10 | GitHub 独立审核批准与 CI 结果 | 起始 reviews/comments/statuses/PR workflow 均未有通过证据；可合并状态只是 Git 冲突判断，不等于审核批准。本 PR 不合并或部署 |

原配置、DB、媒体、浏览器账号、日志、原始证据及私有历史不随清单提交。原守卫与默认真实执行拒绝保持；原服务不停止或重启。清单完成表示已登记上述复核范围和缺口，不表示 R1–R10 已完成。
