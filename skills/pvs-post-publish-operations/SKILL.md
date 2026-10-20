---
name: pvs-post-publish-operations
description: 采集绑定作品的表现指标、顶层评论和楼中楼，分析反馈并准备或受确认发送单条回复。
---

先确认运营账号、binding和作品ID，不能用最新未发布包替换正在运营的作品。
先用 operations.account 读取真实运营 UID；不能把发布渠道的 OPEN_ID 或账号昵称当运营 UID。
调用 operations.metrics、operations.comments、operations.replies 并记录采集批次、实际时点、游标、hasMore/truncated。有 collectionId 时，用 operations.collection-inspect 查看本地检查点、operations.collection-advance 继续原任务。采样必须说明范围；平台不能提供的历史数据不能补造为零。还有后续页时续原批次，不重复首屏冒充全量。
用户要求定时观察时，用 operations.schedule-create 提议具体作品、运营 UID、开始时间、间隔和次数，等待用户对该计划确认。最少间隔60秒、最多30次；用 operations.schedule-list 查看进度，operations.schedule-pause 暂停原计划。计划完成次数不代表评论已全采完；保留PARTIAL覆盖和原游标，不把计划创建当成业务结果。
分类和回复草稿引用真实评论，楼中楼保留parentCid。发布回复前展示具体评论、草稿文本、账号和版本，受服务端确认保护；未知结果不重发。这里是作品评论互动，不能扩张成私信或批量自动互动。
