import {z} from "zod";
import {metricAvailabilitySchema,metricKeys} from "./douyin-observation.js";
import type {DouyinMetricSnapshot} from "./douyin-ops.js";

const seconds=z.number().int().min(60).max(86400);
export const adaptiveCadenceSchema=z.object({
  version:z.literal("stage-data-v1"),
  minIntervalSeconds:seconds,
  maxIntervalSeconds:seconds,
  maxDurationSeconds:z.number().int().min(60).max(604800),
  growthThresholdPercent:z.number().min(1).max(1000).default(20),
  minAbsoluteGrowth:z.number().int().min(1).max(1000000).default(10)
}).strict().refine(value=>value.minIntervalSeconds<=value.maxIntervalSeconds,{message:"最短间隔不能大于最长间隔"});
export type AdaptiveCadence=z.infer<typeof adaptiveCadenceSchema>;

export const metricObservationSchema=z.object({
  snapshotId:z.string().min(1),contentHash:z.string().regex(/^[a-f0-9]{64}$/),capturedAt:z.string().datetime(),
  values:z.record(z.string(),z.number().int().nonnegative()),availability:metricAvailabilitySchema
});
export type MetricObservation=z.infer<typeof metricObservationSchema>;
export const cadenceStateSchema=z.object({
  version:z.literal("stage-data-v1"),deadlineAt:z.string().datetime(),
  publicationTime:z.object({source:z.literal("WORK_BINDING_AT_CREATE"),status:z.enum(["KNOWN","UNKNOWN"]),publishedAt:z.string().datetime().optional()}),
  previous:metricObservationSchema.optional(),lastIntervalSeconds:seconds.optional()
});
export type CadenceState=z.infer<typeof cadenceStateSchema>;
export const cadenceDecisionSchema=z.object({
  version:z.literal("stage-data-v1"),stage:z.enum(["EARLY","ACTIVE","MATURE","UNKNOWN"]),
  signal:z.enum(["BASELINE","GROWING","STABLE","DECREASED","UNOBSERVABLE","INCOMPARABLE"]),
  current:metricObservationSchema.optional(),previous:metricObservationSchema.optional(),
  comparableMetrics:z.array(z.enum(metricKeys)),
  deltas:z.record(z.string(),z.number().int()),
  intervalSeconds:seconds,decidedAt:z.string().datetime(),nextAt:z.string().datetime(),deadlineAt:z.string().datetime(),
  reason:z.string().min(1)
});
export type CadenceDecision=z.infer<typeof cadenceDecisionSchema>;

export function metricObservation(snapshot:DouyinMetricSnapshot):MetricObservation {
  const values:Record<string,number>={},availability:MetricObservation["availability"]={};
  for(const key of metricKeys){
    const value=snapshot[key],state=snapshot.metricAvailability?.[key]??(value===undefined?"NOT_PROVIDED":"LEGACY_UNVERIFIED");
    availability[key]=state;
    if(state==="OBSERVED"&&value!==undefined&&Number.isSafeInteger(value)&&value>=0)values[key]=value;
  }
  return metricObservationSchema.parse({snapshotId:snapshot.id,contentHash:snapshot.contentHash,capturedAt:snapshot.capturedAt,values,availability});
}

/** Pure, versioned policy. It changes timing only inside the explicitly confirmed bounds. */
export function decideCadence(input:{policy:AdaptiveCadence;state:CadenceState;baseIntervalSeconds:number;now:string;current?:MetricObservation}):CadenceDecision {
  const {policy,state,current}=input,previous=state.previous;
  const published=state.publicationTime.publishedAt,age=published?(Date.parse(input.now)-Date.parse(published))/3600000:NaN;
  const stage:CadenceDecision["stage"]=state.publicationTime.status!=="KNOWN"||!Number.isFinite(age)||age<0?"UNKNOWN":age<24?"EARLY":age<168?"ACTIVE":"MATURE";
  const core=["plays","likes","comments","shares"] as const;
  const observable=(sample:MetricObservation|undefined)=>Boolean(sample&&core.every(key=>sample.availability[key]==="OBSERVED"&&Number.isSafeInteger(sample.values[key])));
  const comparableMetrics:CadenceDecision["comparableMetrics"]=[];
  const deltas:Record<string,number>={};
  let signal:CadenceDecision["signal"]="UNOBSERVABLE";
  if(observable(current)){
    if(!previous)signal="BASELINE";
    else if(!observable(previous))signal="UNOBSERVABLE";
    else if(current!.snapshotId===previous.snapshotId||Date.parse(current!.capturedAt)<=Date.parse(previous.capturedAt))signal="INCOMPARABLE";
    else{
      for(const key of metricKeys){
        if(current!.availability[key]==="OBSERVED"&&previous.availability[key]==="OBSERVED"&&Number.isSafeInteger(current!.values[key])&&Number.isSafeInteger(previous.values[key])){
          comparableMetrics.push(key);deltas[key]=current!.values[key]!-previous.values[key]!;
        }
      }
      const growing=comparableMetrics.some(key=>deltas[key]!>=policy.minAbsoluteGrowth&&(previous.values[key]===0||deltas[key]!/previous.values[key]!*100>=policy.growthThresholdPercent));
      signal=comparableMetrics.some(key=>deltas[key]!<0)?"DECREASED":growing?"GROWING":"STABLE";
    }
  }
  const phaseBase=input.baseIntervalSeconds*(stage==="ACTIVE"?2:stage==="MATURE"?4:1);
  let interval=phaseBase;
  if(signal==="GROWING")interval=stage==="EARLY"?policy.minIntervalSeconds:stage==="ACTIVE"?Math.ceil(input.baseIntervalSeconds/2):input.baseIntervalSeconds;
  if(["UNOBSERVABLE","INCOMPARABLE","DECREASED"].includes(signal))interval=Math.max(phaseBase,state.lastIntervalSeconds??input.baseIntervalSeconds);
  interval=Math.max(policy.minIntervalSeconds,Math.min(policy.maxIntervalSeconds,interval));
  const nextAt=new Date(Math.min(Date.parse(input.now)+interval*1000,Date.parse(state.deadlineAt))).toISOString();
  const reason=signal==="UNOBSERVABLE"?"核心指标存在缺失、不可见或未核实状态，不补零、不加快观察。":signal==="INCOMPARABLE"?"采集时间或快照不具备顺序可比性，不加快观察。":signal==="DECREASED"?"计数回落可能来自平台修订，不推断效果，不加快观察。":signal==="GROWING"?"已观察指标达到明确增长阈值，仅调整授权范围内的下一次观察时间，不代表因果或商业效果。":signal==="STABLE"?"已观察的可比指标未达到增长阈值；按作品阶段安排节奏，不推断总体稳定或商业效果。":"按已固定的作品发布时间阶段和可观察基线安排下一次观察，不代表完整覆盖。";
  return cadenceDecisionSchema.parse({version:policy.version,stage,signal,current,previous,comparableMetrics,deltas,intervalSeconds:interval,decidedAt:input.now,nextAt,deadlineAt:state.deadlineAt,reason});
}
