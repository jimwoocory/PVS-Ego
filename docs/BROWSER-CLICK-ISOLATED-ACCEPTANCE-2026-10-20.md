# 浏览器点击与确认框取消：隔离验收

2026-10-20，本轮基于 PVS-Ego 当前本地代码，使用全新空白会话库、本地新生成的色块/纯音视频及固定进程内函数。原仓库、正式配置、真实素材和账号资料未复制到测试库。

## 结论

本轮覆盖的原业务页面点击、三组原生确认框取消/确认及状态持久化通过。唯一定向套件 `tests/browser-click-isolated.test.mjs` 为 **8 PASS / 0 FAIL**（7 个子用例及父用例），应用子进程与测试进程均观察退出 0。

点击来自 Tabbit CLI 的 native Playwright 控件，业务变更经原应用 HTTP 路由落库，不用接口直接调用代替被验收按钮。取消同时对照服务端请求记录与数据库状态，不能仅凭按钮文字或命令成功推断。

截图来自内置浏览器只读打开同一隔离项目，单独标记为截图通道，不冒充 Tabbit 原生截图；共 9 张 JPEG，四页移动端内容宽 375px，横向溢出均为 0。原生页面 pageerror 与截图页 error 日志均为 0。

## 超时诊断与处理

1. 受限 runner 连接 Tabbit 会等待后返回 `BROWSER_RUNTIME_UNAVAILABLE`；同范围的正常 runner 能立即连接。没有重启或改动浏览器的运行时服务。
2. 纯本地诊断页实际证明：原生 confirm 打开时，点击 Promise 在 250ms 后仍未完成；处理对话框后正常结束。因此必须先安装 dialog waiter，并发处理点击及 accept/dismiss，不能先等 click 结束再去找确认框。遇到意外对话框先 dismiss，再报错，避免留下阻塞。
3. 曾预先准备的 Agent 动作在指标/反馈变化后被后端正确拒绝（400：旧动作授权失效）。盲目等待页面跳转导致额外 15s 超时。这是授权保护生效；没有放宽 contextHash/revision/inputHash 校验。保留这次失败证据，按当前合成状态重新准备新待确认动作，先核对响应，再等待预期 UI 状态。
4. Tabbit `page.screenshot` 仍分别在 30s、5s 超时。页面可响应、字体已 loaded、无动画、visibility 为 visible；降低截图尺度/关闭动画未解除。底层截图原因尚未确认，继续单列阻断。已关闭本任务自己的 Tabbit 标签页，未操作其他账号页。

浏览器侧附加的 Google 字体请求被本地 URL allowlist 阻断，原记录保留。应用只使用本地测试数据，应用守卫继续拒绝出站网络及真实执行；没有以空日志声称 OS 级或全浏览器网络隔离。

## 实际覆盖

| 业务入口 | 取消/未确认结果 | 明确确认与执行结果 |
| --- | --- | --- |
| U5 采用复盘建议 | 原生 dismiss 后无 promote POST，feedback 仍 0；刷新后仍待采用 | accept 后只新增 1 次 promote，1 条合成反馈进入后续候选实际输入 |
| Agent 有界观察计划 | dismiss 后无 confirm POST，revision 和 WAITING_CONFIRMATION 保留，未创建计划 | accept 仅授权该动作，再显式点击继续才创建 1 条 maxCaptures=2 的计划；最后经原按钮暂停，未启动后台采集 |
| U5 停用反馈 | dismiss 后无 deactivate POST，反馈仍有效 | accept 只新增 1 次停用，下一轮实际候选输入不再携带反馈 |
| U3 分阶段预检 | 未勾选准备/接管/归还/提交均不执行对应操作；归还后提交框仍未勾选 | 合成 CAPTCHA→人工控制→原页面续接；模拟提交只有 1 次；结果未知后刷新显示 SUBMISSION_UNKNOWN，提交按钮移除，无自动重提 |
| U4 指标/分页/回复展开 | 未提供、不可见继续保持未知，终页不等于完整覆盖 | 原按钮刷新、顶层两页、楼中楼两页、已保存回复展开及原始关系/计数来源展示均完成 |
| U2 停用参考 | 无文件选择或外部分析 | 原按钮停用后无 ACTIVE profile，版本历史保留；音频依然 NOT_OBSERVED |

测试准备接口只设置合成前置条件（准备待确认 proposal、模拟本地验证完成），不会完成被验收的业务动作。采用、停用、计划确认/执行/暂停、候选继续和预检/接管/续接/提交均由原 UI 控件触发。

未知提交保留 1 条不可信、无平台作品 ID 的 `SUBMISSION_UNKNOWN` 回执，不能记为发布成功。合成运行时的 uploads=1/submits=1 是内存测试计数，真实上传和真实发布为 0。

## 代码与复核方式

- `tests/browser-click-fixture.ts`：有守卫的实际业务服务和合成运行时，保存请求、状态快照及最终保护断言。
- `tests/browser-click-isolated.test.mjs`：唯一测试入口，对原生操作后的服务端快照、取消零请求、输入和最终状态作断言。
- `tests/browser-confirm.program.js`：从本轮实际执行程序逐字提取的确认框 helper，用于 Tabbit stdin。使用前需准备任务内 `page`、`assert`、`pvs.dialogs`；对话框消息必须精确匹配。
- `scripts/prepare-browser-click-fixture.mjs`：只接受明确绝对路径的本地 FFmpeg/FFprobe，生成全新测试色块/纯音媒体并记录二进制哈希、帧时间和文件哈希。不会读用户素材。
- `scripts/isolation-tools.mjs browser-test` / `npm run test:browser`：启动这一套件，等待外部真实浏览器操作与证据；不自动将缺失浏览器步骤标为通过。

先运行 `npm run setup` 和 `npm run build`。用以下命令显式准备合成媒体后再启动套件：

```text
node scripts/prepare-browser-click-fixture.mjs --ffmpeg <本地ffmpeg绝对路径> --ffprobe <本地ffprobe绝对路径>
npm run test:browser
```

本套件需要操作者通过浏览器完成已列出的隔离步骤，并保留原生回执和截图；不是无人值守的全平台 E2E。动作 proposal 应在相关指标/反馈准备好后创建，任何状态变化使旧授权失效时，先只读核对原因，不能复用或绕过旧授权。

本地 `.runtime/browser-click-active.json` 指向本轮会话证据目录，含 `native-click-evidence.json`、`browser-done.json`、`browser-click-acceptance.json`、`mark-*.json`、原始 HTTP 日志、失败回执和截图。`.runtime` 及原始证据不入公开仓库。

## 持续限制

U3 真实上传编辑态阻断保留。本轮没有真实平台、模型、素材外发、真实上传、付费生成、发布、评论回复或部署/重启 3090；实际产品事实、已采用内容及真实待审复盘没有被测试采用或改写。音频语义仍不可观察。

本轮只运行上述一个定向套件；没有重跑独立化 27 用例套件或全量测试。原生点击结论限于本报告列出的控件链，不扩展为所有页面、所有平台或 Tabbit 截图底层问题已修复。

截图通道实际返回 JPEG；初存的 `.png` 扩展名与内容不符，已按真实格式另存 `.jpg`，图像字节及原文件全部保留。格式更正清单为会话目录的 `screenshot-format-correction.json`，不改写原始测试回执。

## 公开交付审查

上传前已保留本地 Git 历史包、本轮改动补丁和文件压缩包，并校验哈希。对拟交付树的 606 个文件作敏感格式、个人路径、URL 凭据、敏感赋值和长数字标识扫描及命中复核；未发现真实密钥、账号资料或业务原始证据。命中项为合成测试常量、示例无效地址/路径及第三方许可证署名，保留其测试和许可用途。

原始 HTTP/浏览器回执、失败记录、截图、素材、数据库、本机配置和详细扫描清单仅保留本地，不进入 Git。此次交付引用已验收的 8/8 结果，没有为上传重复运行套件，也不将代码上传视作部署或平台发布。
