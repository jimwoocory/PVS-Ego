# 研究证据只读审阅隔离验收

2026-10-20。基线仍为本地 `67fcac5` 与全部既有未提交改动。用户要求继续按优先级推进，保持隔离和授权边界。本轮优先补齐已有证据的可审阅性，没有扩大采集范围或模型许可。

## 改动

旧研究页对所有BLOCKED任务都显示“深度研究需要你处理”和“继续深度研究”。前轮BASIC仅采集任务点击该按钮会被原 `resumeRun` 拒绝。现在按模式与阻断码展示状态：`BRIEF_GENERATION_NOT_AUTHORIZED` 显示“来源证据已保存，摘要尚未生成”，只有适用的DEEP任务保留续接按钮。

带已保存正文回执的Go本机或Ego来源新增“查看已保存正文”链接。只读路由为：

```text
GET /projects/:projectId/research/runs/:runId/evidence/:evidenceId
GET /api/projects/:projectId/research/runs/:runId/evidence/:evidenceId
```

`ResearchEvidenceReader` 只读取原ResearchRepository、ArtifactRepository及项目文件，不调用provider、模型或修复操作。核对项目/run/evidence归属、Artifact归属与READY状态、不可变JSON类型、当前run目录、真实路径及文件类型/大小，再验证文件SHA256、字节数、正文内容哈希、来源/最终URL、标题、采集时间和摘录与原证据的一致性。

核验通过才展示保存正文。缺失、损坏、目录越界或回执不一致返回409且不返回正文；跨项目或错run返回404。路由仅GET，并校验本机Host/Origin与跨站请求；响应禁止缓存。正文按文本转义，查看页没有执行脚本，CSP禁止脚本和外部资源。页面明确说明这只核验文件与回执一致性，不证明来源事实正确，不采用产品事实或授予模型/平台许可。截断回执和未核验截图明确展示。

现有隔离Web依赖加入的是只读reader。Go执行工厂和默认拒绝的研究/模型/发布端口未启用；没有部署到3090或连接正式库。

## 本轮实测

唯一专项 `tests/research-evidence-review-isolated.test.mjs`：**7 PASS / 0 FAIL，套件退出0**（6个子项+父项）；受守卫保护的测试进程实际退出0。修改TS后build退出0，没有运行全量或其他定向套件。

| 范围 | 证据 |
| --- | --- |
| 实际Prisma与HTTP | 从迁移SQL新建空白SQLite；真实 `createAppServer`、ResearchService、Prisma仓库与不可变Artifact |
| 来源采集 | 6份初始化的固定合成capture；不是本轮真实Go或网站采集 |
| 正常/截断 | 文件与内容哈希吻合，截断标记保留；源文本中的script按文字返回 |
| 拒绝路径 | 文件缺失、字节被改、跨目录、证据元数据不一致均阻断且无正文泄露；跨项目、错run、编码越界ID拒绝 |
| 只读限制 | POST返回405，外部Origin和跨站请求返回403 |
| 原生浏览器 | Tabbit实际点击研究页正文链接、刷新、返回、再次打开；不存在错误深度续接按钮，源script未执行，页面错误0 |
| 无新增执行 | 所有查看前后数据库摘要相同；capture计数维持初始化6，模型0、搜索0；没有重新采集、生成摘要、修复或采用事实 |

Tabbit截图本轮再次实际等待30000ms超时，失败原始回执保留，不能改成PASS。之后用独立IAB对同一自有页面做只读视觉补充：本轮对话中保留并检查了上部信息和下部正文/哈希两张截图，布局可读、正文按文本呈现。该截图没有导出成本地PNG，不能把它写成Tabbit截图成功；原Tabbit阻断仍在。两种浏览器自建标签均已关闭，Tabbit任务正常finish，无强制清理。

前轮持久化10/10、真实Go研究6/6与工作台点击9/9仍为各自历史记录，本轮未重跑这些套件。本轮不证明真实平台E2E、真实用户采用、真实来源事实或原Ego截图链已恢复。

## 保护与复核

全部运行仅新建自有空白库、合成项目和原文文件，未复制真实配置、数据库、账号资料或素材。原15秒成片、72积分历史和既有未提交代码保留。无业务模型、素材外发、真实上传、付费生成、发布、评论回复、部署、原3090或辅助服务停止/重启、Git提交/推送及无关AgentDock操作。

U3真实编辑态阻断、U1多Space/登录归还缺口、U4已有父评论真实第二页、U5真实建议尚未采用、实际模型费用UNKNOWN及音频NOT_OBSERVED均保持原事实。

复核使用已有依赖；每轮只运行此定向套件：

```text
npm run build
npm run test:evidence-review
```

该套件等待交互式浏览器验收，输出 `PVS_EVIDENCE_REVIEW_BROWSER_READY`。控制器只访问该轮自有地址，从研究页原生打开正文、刷新并返回，确认脚本未执行、无续接误导和页面错误，再将真实控制结果保存到该session的 `evidence/browser-result.json`。不得伪造回执替代点击。父进程随后核对数据库/计数不变及实际进程退出，才写最终回执。

本机指针为 `.runtime/evidence-review-active.json`、`.runtime/evidence-review-attempt.json` 和 `.runtime/evidence-review-location.json`。原始回执、空白库、合成原文、截图失败日志及备份仅留本地。结果先追加 `.runtime/p3-report.md`，再写 `.runtime/evidence-review-checkpoint-20261020.json`。
