import {adaptiveCadenceSchema,cadenceStateSchema,cadenceDecisionSchema,metricObservationSchema} from "./operations-cadence.js";
import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const operationsScheduleInputSchema = z.object({
  projectId: id, requestKey: id, bindingId: id, awemeId: z.string().regex(/^\d{8,30}$/),
  opsAccountUid: z.string().trim().min(1).max(100), startAt: z.string().datetime(),
  intervalSeconds: z.number().int().min(60).max(86400).default(3600),
  maxCaptures: z.number().int().min(1).max(30).default(3),
  maxReplyParents: z.number().int().min(1).max(10).default(5),
  pageSize: z.number().int().min(1).max(20).default(20),
  cadence:adaptiveCadenceSchema.optional()
}).strict().superRefine((input,ctx)=>{if(input.cadence&&(input.intervalSeconds<input.cadence.minIntervalSeconds||input.intervalSeconds>input.cadence.maxIntervalSeconds))ctx.addIssue({code:"custom",path:["cadence"],message:"基准间隔必须在本次明确的最短和最长间隔内"});});
const captureSchema = z.object({
  index: z.number().int().min(1).max(30), startedAt: z.string().datetime(),
  metricsSnapshotId: id.optional(), metricsCapturedAt: z.string().datetime().optional(), commentsRunId: id.optional(),
  parents: z.array(z.string().regex(/^\d{1,40}$/)).max(10).optional(),
  replyRuns: z.record(z.string(), z.string()), parentLimitReached: z.boolean().default(false),metricsPartial:z.boolean().optional(),metricObservation:metricObservationSchema.optional()
  ,pendingRead:z.object({kind:z.enum(["METRICS","COMMENTS","REPLIES"]),requestKey:id,startedAt:z.string().datetime(),parentCid:z.string().regex(/^\d{1,40}$/).optional(),collectionRunId:id.optional(),pagesBefore:z.number().int().nonnegative().optional()}).optional()
});
const coverageScopeSchema=z.object({runId:id.optional(),parentCid:z.string().optional(),status:z.string(),cursor:z.string().optional(),hasMore:z.boolean().optional(),partial:z.boolean(),truncated:z.boolean(),visibility:z.enum(["VISIBLE","PARTIAL","NOT_VISIBLE","UNKNOWN"]),observedAt:z.string().datetime().optional()});
export const operationsScheduleSchema = z.object({
  id, input: operationsScheduleInputSchema, inputHash: z.string(), revision: z.number().int().positive(),
  executionProtocol:z.literal("operations-read-intent-v1").optional(),
  status: z.enum(["SCHEDULED", "RUNNING", "PAUSED", "COMPLETED", "BLOCKED"]),
  completedCaptures: z.number().int().min(0).max(30), nextAt: z.string().datetime(),
  cadenceState:cadenceStateSchema.optional(),terminalReason:z.enum(["MAX_CAPTURES","MAX_DURATION"]).optional(),
  consecutiveFailures: z.number().int().min(0).max(3), checkpoint: captureSchema.optional(),
  history: z.array(z.object({ index: z.number().int().positive(), startedAt: z.string().datetime(), completedAt: z.string().datetime(),
    metricsSnapshotId: id, commentsRunId: id, replyRunIds: z.array(id).max(10),
    cadenceDecision:cadenceDecisionSchema.optional(),
    coverage: z.enum(["PARTIAL", "COMPLETED_SCAN"]), detail: z.string(),
    observationCoverage:z.object({topLevel:coverageScopeSchema,replies:z.array(coverageScopeSchema).max(10),parentLimitReached:z.boolean(),parentSelection:z.literal("LATEST_SAVED_TOP_LEVEL"),metricsPartial:z.boolean()}).optional() })).max(30),
  errorCode: z.string().optional(), errorMessage: z.string().optional(), createdAt: z.string().datetime(), updatedAt: z.string().datetime()
}).superRefine((run,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:"custom",message});
  if(run.completedCaptures>run.input.maxCaptures||run.history.length!==run.completedCaptures||run.history.some((item,i)=>item.index!==i+1))fail("运营计划观察次数或历史不一致");
  const capture=run.checkpoint;
  if(capture&&(capture.index>run.completedCaptures+1||new Set(capture.parents??[]).size!==(capture.parents??[]).length||Object.keys(capture.replyRuns).some(cid=>!capture.parents?.includes(cid))))fail("运营计划检查点或父评论范围不一致");
});
export type DouyinOperationsScheduleInput = z.input<typeof operationsScheduleInputSchema>;
export type DouyinOperationsSchedule = z.infer<typeof operationsScheduleSchema>;
