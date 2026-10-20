import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DomainValidationError } from "../../domain/validation.js";
import type { BusinessStage } from "../../domain/agent-cycle.js";

export const pvsSkills: Array<{id: string; title: string; stage: BusinessStage}> = [
  {id:"pvs-market-research",title:"行业视频搜索、采集与分析",stage:"RESEARCH"},
  {id:"pvs-content-strategy",title:"研究与运营反馈驱动的内容策略",stage:"STRATEGY"},
  {id:"pvs-video-production",title:"视频生产、审片与成片交付",stage:"PRODUCTION"},
  {id:"pvs-publication",title:"发布与平台作品关联",stage:"PUBLICATION"},
  {id:"pvs-post-publish-operations",title:"指标、评论、楼中楼与互动",stage:"OPERATIONS"},
  {id:"pvs-performance-feedback",title:"证据复盘与下一轮创意",stage:"FEEDBACK"}
];
export class PvsAgentSkills {
  constructor(private readonly root = path.resolve(process.cwd(), "skills")) {}
  list() { return pvsSkills; }
  async load(id: string) {
    const metadata = pvsSkills.find(skill => skill.id === id);
    if (!metadata) throw new DomainValidationError("未注册的 PVS Skill");
    const text = await fs.readFile(path.join(this.root, id, "SKILL.md"), "utf8");
    return {...metadata, version:"1.0.0", digest:createHash("sha256").update(text).digest("hex"), text};
  }
}
