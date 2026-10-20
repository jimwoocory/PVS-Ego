# Product Video Studio — P0 第三方依赖与授权策略

版本：0.2  
状态：Frozen specification baseline  
冻结日期：2026-09-27

## 1. P0治理目标

项目可能闭源、商业化或SaaS化，因此P0从第一项业务依赖开始执行default-deny License Gate。

任何代码、包、复制内容、vendor文件、二进制或external-runtime在使用前必须回答：
- 来源和发布者是谁
- SPDX许可证是什么
- 是否存在额外商业/服务条款
- 是否包含NOTICE或文件级不同许可
- 是复制源码、链接依赖、开发工具还是外部进程调用
- 是否会随产品分发
- 直接与传递依赖分别是什么许可

## 2. P0强制治理文件

仓库必须维护：
- dependency-allowlist.json
- THIRD_PARTY_NOTICES.md
- third_party/licenses/
- 本策略文件

缺少任一治理文件，IMPLEMENTATION_PASS失败。

依赖必须先登记、审核和保存许可，再安装或提交。不得先引入后补许可。

## 3. Default-deny规则

未列入dependency-allowlist.json的依赖默认拒绝。

以下情况P0 License Gate必须失败：
- GPL-2.0 / GPL-3.0及其变体
- AGPL-3.0及其变体
- SSPL
- UNKNOWN
- 自定义限制许可未经专项书面批准
- 无LICENSE
- 仅在README声称“开源”但无可验证许可
- 许可证与实际文件、包元数据不一致
- 传递依赖命中以上任一情况
- 复制来源和许可证无法追溯

不得通过改名、复制少量代码、去掉版权头或改写文件路径绕过Gate。

## 4. 默认允许但仍需登记

P0默认可申请允许：
- MIT
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC

“允许”不等于免记录。必须：
- 写入dependency-allowlist.json
- 在THIRD_PARTY_NOTICES.md记录名称、版本、来源、用途和版权
- 将许可证文本或可靠副本放入third_party/licenses/
- 检查NOTICE和文件级例外

## 5. dependency-allowlist.json要求

每项至少包含：
- name
- version或精确范围
- ecosystem
- usage
- license
- sourceUrl
- bundled
- runtimeType
- approvedForP0
- licenseFile
- noticeEntry
- reviewedAt

必须记录直接与必要传递依赖。版本升级视为新审核，禁止无界版本范围。

## 6. License Gate执行点

必须在以下阶段执行：
- 安装或更新依赖前
- lockfile变化后
- CI/本地验收时
- 构建发布物前
- IMPLEMENTATION_PASS判定前

Gate检查：
- manifest与lockfile
- 直接/传递依赖
- vendor和复制源码目录
- 第三方二进制
- 许可证文件存在性
- allowlist版本匹配
- NOTICE完整性
- 禁止许可证集合

## 7. 研究参考与源码使用边界

可以阅读外部项目理解通用思想，但：
- 不得复制受禁止或未知许可证保护的实质源码、模板、Prompt文本或数据文件
- 独立实现必须基于本仓库规格和自有结构
- 任何实际复用都必须可追溯到允许许可证、具体版本和文件

## 8. 当前允许评估的导演参考

### s1dashu/director
- 许可证：MIT
- 仅在完成版本固定、allowlist、NOTICE和许可副本后，才允许使用明确受MIT覆盖的内容
- P0仍优先独立实现Product Director

### 62656456/ai-film-skills
- 许可证：Apache-2.0
- 必须同时检查其THIRD_PARTY_NOTICES和文件级声明
- 只可复用明确受允许许可证覆盖的内容

这些项目不是自动批准依赖；在dependency-allowlist.json登记前仍为拒绝状态。

## 9. 禁止进入P0 runtime或核心的项目类别

包括但不限于：
- StoryMind：AGPL-3.0
- Relo-video/SynthCut：GPL-3.0-or-later
- Algovate/jimeng-cli：GPL-3.0
- juspay/director：无LICENSE时禁止复制
- AtlasCloudAI/atlas-marketing-studio：许可不明确时禁止复制
- deluxebear/jimeng-cli：无LICENSE时禁止复制
- 其他第三方Jimeng/Dreamina逆向CLI

它们最多作为不复制源码的研究材料，不得作为P0依赖、runtime、fallback或供应商适配器。

## 10. MIT wrapper裁决

任何Jimeng/Dreamina MIT wrapper，包括文档曾提及的xiaozhichao2025/JimengCli_api：
- 不得作为P0 runtime依赖
- 不得用来证明底层CLI/API官方身份
- 不得作为官方dreamina缺失时的替代方案
- 不得复制其适配实现进入核心

MIT只描述wrapper代码许可，不证明所调用服务、API或CLI为官方渠道。P0必须独立实现最小Process Adapter。

## 11. 国内即梦官方 dreamina external-runtime

官方dreamina CLI作为external-runtime处理：
- 不提交、vendor或重新分发官方二进制
- 不反编译、不修改、不绕过登录/账号/VIP/额度
- 凭据、Cookie、Token不得进入项目文件或仓库
- 安装、登录、授权由用户显式操作
- 只实现DomesticJimengCliProvider Process Adapter

### 11.1 官方身份验证

仅命令名dreamina不足以认定官方。ProviderIdentity至少验证：
- 安装/下载来源是字节跳动、即梦或Dreamina控制的官方渠道
- 官方材料明确说明CLI及Seedance 2.0用途
- 发布者、包名、版本、可执行路径
- 二进制sha256或签名
- 原始--version和--help
- capabilityFingerprint
- 登录跳转到官方域名/官方客户端

无法建立上述证据时：
- ProviderIdentity=UNVERIFIED
- Preflight=BLOCKED
- 创建WorkflowBlocker(PROVIDER_IDENTITY_UNVERIFIED)
- 禁止登录和submit

### 11.2 external-runtime登记

即使不随仓库分发，也必须在dependency-allowlist.json以runtimeType=external-runtime登记：
- 名称和用途
- bundled=false
- 身份验证要求
- 服务条款检查状态
- 禁止将官方二进制放入third_party/licenses或仓库

外部runtime登记不等于代码许可证批准，也不能绕过服务条款。

## 12. 日志与第三方凭据

第三方命令stdout/stderr在持久化前必须执行敏感信息检测和脱敏。不得因“原始日志审计”要求而保存：
- Cookie
- Authorization header
- access/refresh token
- session key
- 账号密码
- 扫码载荷中的敏感凭据

必须保留退出码、时间、命令操作类型、脱敏规则版本和可审计解析结果。

## 13. P1依赖

以下不是P0依赖：
- SAM2
- GroundingDINO
- PaddleOCR
- OpenTimelineIO
- MoviePy / editly
- FFmpeg发布级渲染
- Remotion

进入P1/P2时必须按当时版本和条款重新审核，不得沿用P0阶段的历史判断。

## 14. License Gate与验收

IMPLEMENTATION_PASS必须满足：
- allowlist与实际依赖完全匹配
- 无未登记直接/传递依赖
- 许可副本和NOTICE完整
- GPL/AGPL/SSPL/UNKNOWN/无LICENSE扫描结果为0
- 第三方Jimeng CLI和MIT wrapper不在runtime依赖中
- official dreamina只作为已登记external-runtime，不在仓库分发

任一项失败，IMPLEMENTATION_PASS、EXTERNAL_BLOCKED和E2E_PASS均不得成立。

## 15. 2026-09-28 P0 external-runtime 修订

本节覆盖第13/14节与以下两项冲突的旧说明。

- FFmpeg：允许作为已登记、非捆绑的系统 external-runtime，仅用于把已 ACCEPT 的视频片段按既定顺序拼接为 FINAL_VIDEO。仓库不得分发 FFmpeg 二进制、源码或 GPL 库；License Gate 的 GPL 例外仅限 name=ffmpeg 且 bundled=false。
- Douyin OpenAPI：允许作为官方外部服务，用于 OAuth 和用户显式确认后的 video.create 发布。ClientSecret/access token/refresh token 不进入仓库、SQLite 业务 Artifact、project.json 或命令日志。

完整 Timeline/剪辑依赖（OpenTimelineIO、MoviePy/editly、Remotion 等）仍属于 P1。
