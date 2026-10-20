/**
 * Deterministic Chinese-first speech segmentation for the V8 shadow planner.
 * A cut is only allowed after visible punctuation. There is no arbitrary
 * character-count slicing and no hallucination of new words or utterances.
 * A paragraph without safe breaks returns NEEDS_MANUAL_SEMANTIC_CUT.
 */
export type V8SemanticSpeechPart = {
  text: string;
  partIndex: number;
  partCount: number;
  durationMs: number;
};
export type V8SemanticSpeechResult = {
  status: "READY" | "NEEDS_MANUAL_SEMANTIC_CUT";
  parts: V8SemanticSpeechPart[];
  originalText: string;
  reason?: string;
};
// Permit a natural break after punctuation even if the next utterance contains a space.
// String.split preserves whitespace in the next part, so the source is byte-for-byte reconstructible.
const BOUNDARY = /(?<=[，。！？；、,!.?;:：])/u;
const WORDS = /[\p{L}\p{N}]/gu;
const PUNCT = /[，。！？；、,!.?;:：]/gu;

export function estimateV8SpeechMs(text: string, charactersPerSecond: number): number {
  if (!(charactersPerSecond > 0) || !Number.isFinite(charactersPerSecond)) {
    throw new Error("charactersPerSecond must be positive");
  }
  const words = (text.match(WORDS) ?? []).length;
  const pauses = (text.match(PUNCT) ?? []).length;
  return Math.max(500, Math.ceil((words / charactersPerSecond * 1000 + pauses * 110) / 100) * 100);
}

function unsafe(text: string, estimatedMs: number, reason: string): V8SemanticSpeechResult {
  return {
    status: "NEEDS_MANUAL_SEMANTIC_CUT", originalText: text, reason,
    parts: [{text, partIndex: 1, partCount: 1, durationMs: estimatedMs}]
  };
}

/**
 * Greedy punctuation-boundary segmentation with utterance preservation.
 * For durations slightly above the threshold, subshots are distributed by
 * the source speech estimate, rounded to whole 100 ms and exactly conserved.
 * A 300 ms minimum avoids unperformably short standalone fragments.
 */
export function segmentV8SemanticSpeech(input: {
  text: string;
  charactersPerSecond?: number;
  maxSpeechShotMs?: number;
}): V8SemanticSpeechResult {
  const originalText = input.text;
  const rate = input.charactersPerSecond ?? 5.2;
  const maxMs = input.maxSpeechShotMs ?? 4200;
  if (!Number.isFinite(maxMs) || maxMs < 500) throw new Error("Invalid speech shot limit");
  const total = estimateV8SpeechMs(originalText, rate);
  if (!originalText.trim()) return unsafe(originalText, total, "没有可朗读的台词原文");
  if (total <= maxMs) {
    return {status:"READY", originalText, parts:[{
      text:originalText, partIndex:1, partCount:1, durationMs:total
    }]};
  }
  // Preserve exact characters, including whitespace. English spaces are NOT
  // semantic cuts unless a punctuation boundary also exists.
  const units = originalText.split(BOUNDARY);
  if (units.length < 2 || units.join("") !== originalText) {
    return unsafe(originalText,total,"没有标点语义边界，不能自行切断长台词");
  }
  const estimate = (value:string) => estimateV8SpeechMs(value,rate);
  if (units.some(value => !value.trim() || estimate(value) > maxMs)) {
    return unsafe(originalText,total,"标点之间仍有过长的完整语义单元，不能机械截字");
  }
  const chunks:string[] = [];
  let current="";
  for (const unit of units) {
    const candidate=current+unit;
    if (current && estimate(candidate) > maxMs) {
      chunks.push(current);
      current=unit;
    } else {
      current=candidate;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length<2 || chunks.join("")!==originalText) {
    return unsafe(originalText,total,"未能证明分镜片段按原文连贯覆盖");
  }
  // Conserve estimated speech time, not summed per-chunk minimums.
  const weights=chunks.map(chunk => {
    const letters=(chunk.match(WORDS)??[]).length;
    const punctuation=(chunk.match(PUNCT)??[]).length;
    return Math.max(1,letters*1000/rate+punctuation*110);
  });
  const sumWeights=weights.reduce((acc,item)=>acc+item,0);
  const durations=weights.map(weight=>Math.floor(total*weight/sumWeights/100)*100);
  let remaining=total-durations.reduce((acc,item)=>acc+item,0);
  for (let i=durations.length-1; remaining>=100; i=(i+durations.length-1)%durations.length) {
    durations[i]!+=100;remaining-=100;
  }
  if (durations.some(duration=>duration<300 || duration>maxMs)) {
    return unsafe(originalText,total,"自然语义段的时长过短或过长，需人工确定声音跨镜");
  }
  return {
    status:"READY", originalText,
    parts:chunks.map((text,i)=>({
      text,partIndex:i+1,partCount:chunks.length,durationMs:durations[i]!
    }))
  };
}
