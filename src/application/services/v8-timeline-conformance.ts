import type { ProductionPlan, Timeline } from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";
import { captionChunks } from "./auto-edit-planner.js";

/** Final deterministic guard before rendering/adopting V8, including manual edits. */
export function assertV8TimelineConformance(plan: ProductionPlan, timeline: Timeline): void {
  if (!plan.v8Source) return;
  if (timeline.productionPlanHash !== plan.contentHash) throw new DomainValidationError("V8 时间线不属于当前已确认分镜，请重新采用");
  const expected=plan.scenes.flatMap(s=>s.clips);
  const actual=timeline.clips.filter(c=>!c.deleted).sort((a,b)=>a.order-b.order);
  if (expected.length !== actual.length || actual.some((c,i)=>c.sourceClipId !== expected[i]?.id ||
      c.outMs-c.inMs !== expected[i]?.durationMs || c.transition.type !== "CUT")) {
    throw new DomainValidationError("V8 时间线删减、重排或缩短了已确认剧情镜头，请恢复完整顺序与时长；不能静默丢失动作和揭晓");
  }
  const textItems=timeline.textItems.filter(t=>!t.deleted);
  const usedText=new Set<string>();
  let cursor=0;
  for(const [i,clip] of expected.entries()) {
    const edited=actual[i]!;
    const hasSound=clip.segments.some(s=>s.v8?.spoken || s.ambientSound.kind !== "NONE");
    if (hasSound && (edited.audio.muted || edited.audio.volume <= 0 || edited.audio.keyframes.some(k=>k.volume <= 0))) {
      throw new DomainValidationError("V8 时间线静音了已确认的原生对白或环境声，请恢复源音轨；不能静默替换说话人声线");
    }
    for(const cue of clip.segments.flatMap(s=>s.postProductionText)) {
      const chunks=captionChunks(cue.text);
      for(const [index,text] of chunks.entries()) {
        const start=cursor+cue.startMs+Math.round((cue.endMs-cue.startMs)*index/chunks.length);
        const end=cursor+cue.startMs+Math.round((cue.endMs-cue.startMs)*(index+1)/chunks.length);
        const item=textItems.find(t=>!usedText.has(t.id)&&t.text===text&&t.startMs===start&&t.endMs===end);
        if (!item) throw new DomainValidationError("V8 后期文字缺失、被改写或时间窗漂移："+cue.text+"；请在时间线恢复完整文案并重新确认");
        usedText.add(item.id);
      }
    }
    cursor+=clip.durationMs;
  }
}
