---
name: pvs-publication
description: 创建发布包、明确目标账号与作品版本，执行受授权发布并关联实际平台作品。
---

发布前核对已接受成片、标题文案、渠道和真实账号。先用 publication.account 读取该渠道实际账号ID，作为 expectedAccountId。publication.prepare 只准备；publication.submit 必须由服务端验证用户对当前动作的确认，不能由模型传confirmed:true绕过。
同一发布包或同项目同成片已经成功、正在提交或结果未知时不重新提交，也不能换一个新发布包绕过防重。用 publication.inspect 查看已有回执并按其状态继续。只有平台可信结果或 publication.bind 取得用户明确确认的实际作品关联，才能进入对应运营路径；下载或H5/SDK交接不代表真实发布成功。
区分原始videoId、itemId、已验证awemeId和URL，不猜测映射。绑定错误、账号切换或版本变化先暂停，由用户处理后续接。
