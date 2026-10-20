---
name: pvs-video-production
description: 调用PVS已有制作、审片、剪辑和渲染能力获得可用视频；用于完整制作或已有任务续接。
---

先 inspect 项目、原任务和已有采用素材。按目标复用现有结果；只改字幕或顺序不应重新生成视频。
production.create/advance 复用已有制作引擎和版本约束。费用确认必须绑定当前真实scopeHash，不能将Agent的意愿写成用户授权。等待剧本、资产或成片审核时展示真实结果与恢复入口。
production.advance 和 production.resume 必须先读取原任务，将当前 revision 作为 expectedRevision 提交。下一检查点使用新 revision，不能用旧版本重新提交，也不能通过新建任务绕过原任务的未知结果。
远端提交结果未知先核对，不重提。下载成功、采用镜头、确认时间线和接受成片是不同状态。返回实际Artifact/Assembly引用和QC未满足项；MP4完成只代表制作阶段完成。

Canvas视频先用production.quote核价，再用production.canvas-preflight读取全部阻断。预检必须绑定同账号、真实参考文件、已审核资产、保存的节点提示词及模型、积分上限与原生GenerationRequest。production.canvas-video-delivery实际验证同账号本机CLI视频下载或显式配置的本地MCP；不能只凭命令摘要判断支持类型。未通过时禁止请求付费确认；不得用旧CLI或其他账号替代。production.sync-canvas-video只读核对原提交并下载，媒体检查可重试但不能重新生成，失败保留原文件。

用户明确要求15秒省积分方案时，可用production.quote-short-preview在原项目保存独立比价草稿。原60秒脚本、分镜、工作区指针和费用授权不得被覆盖。比较12秒剧情加3秒本地产品尾卡、15秒单段的实际报价；价格为服务端积分上限，不声称全平台最低。报价草稿不能直接作为已确认制作计划，采用需另立绑定明确的短片计划，再请求视频费用确认。未审核设定图不能因已下载而自动采用。

用户选定72积分方案后，production.short-draft生成独立12秒剧情＋3秒尾卡的脚本、分镜和固定72积分上限；short-inspect读取阻断，short-tail-preview仅渲染本地3秒尾卡。short-review-plan由用户审核，原三张设定图仍通过production.review逐项审核。然后short-quote实时核价、short-prepare准备单个独立原生请求；short-authorize必须用户再次明确确认，报价上涨或未知即停。short-advance仅按本计划原submit查询/下载，不自动重提。short-review-clip须用户看实际文件采用；short-assemble在本机合成、检查15秒MP4并保存质检和交付清单；short-accept-final须用户审阅真实成片后才标交付完成。发布继续独立确认。重做须用short-draft的rejectedPlanId新增独立计划和预算，旧素材及记录保留。
