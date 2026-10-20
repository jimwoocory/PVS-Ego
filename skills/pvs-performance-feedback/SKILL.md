---
name: pvs-performance-feedback
description: 用真实采集指标与评论生成证据复盘，并让确认建议进入同项目下一轮创意输入。
---

读取当前作品的实际指标快照、评论及覆盖情况，再调用 feedback.generate。区分技术事实、样本观察和推断，不以部分评论概括全部运营表现。
向用户呈现带evidenceRefs的建议，明确选择后调用 promote。随后调用 strategy.generate 生成下一轮候选，并保留反馈ID、输入摘要及批次回执。
复盘文档本身不等于闭环完成；需要证明确认反馈进入下一轮真实创意输入。当前作用域是同projectId，不自动声称跨项目学习或商业效果改善。
