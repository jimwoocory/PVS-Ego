import {z} from "zod";
import {productionQuoteSchema,quoteRequestSchema} from "./generation-quote.js";
const hash=z.string().regex(/^[a-f0-9]{64}$/i);
export const canvasNodeBindingSchema=z.object({
  key:z.string().min(1),nodeId:z.string().startsWith("node_"),updateId:z.string().uuid(),submitId:z.string().uuid(),
  kind:z.enum(["IMAGE","VIDEO","PRODUCT"]),sourceRequestHash:hash,
  canonicalModel:z.string().optional(),generationHash:hash.optional(),saved:z.boolean().default(false),
  resourceId:z.string().uuid().optional()
  ,delivery:z.object({attemptId:z.string(),resourceId:z.string().uuid(),state:z.enum(["DOWNLOADING","NEEDS_REVIEW","QC_FAILED"]),artifactId:z.string().optional(),sha256:hash.optional(),
    findings:z.array(z.string()),durationMs:z.number().int().positive().optional(),width:z.number().int().positive().optional(),height:z.number().int().positive().optional(),hasAudio:z.boolean().optional()}).strict().optional()
  ,execution:z.object({scopeHash:hash,authorizedCeiling:z.number().int().nonnegative(),
    state:z.enum(["PREPARED","DISPATCHING","ACCEPTED","REJECTED","UNKNOWN"]),
    resources:z.array(z.string().uuid()),updatedAt:z.string().datetime()}).strict().optional()
}).strict();
export const canvasProductionBindingSchema=z.object({
  runtime:z.literal("DREAMINA_CANVAS"),projectId:z.string().uuid(),runId:z.string().min(1),scopeHash:hash,
  profile:z.string().min(1),accountFingerprint:hash,modelApprovalSource:z.literal("USER_CONFIRMED_5_0_LITE"),
  executableSha256:hash,created:z.boolean(),webUrl:z.string().url().optional(),
  nodes:z.array(canvasNodeBindingSchema).min(1),draftVersion:z.number().int().nonnegative().optional(),
  checkedAt:z.string().datetime(),errorCode:z.string().optional()
  ,originalQuoteRequest:quoteRequestSchema.optional(),sourceScriptHash:hash.optional(),sourcePlanHash:hash.optional(),
  planBindingHistory:z.array(z.object({fromPlanHash:hash,toPlanHash:hash,fromScopeHash:hash,toScopeHash:hash,checkedAt:z.string().datetime()}).strict()).max(20).optional(),
  imageQuote:productionQuoteSchema.optional(),
  imageBudgetGrant:z.object({source:z.literal("EXPLICIT_USER_ZERO_CREDIT_IMAGES"),creditCeiling:z.literal(0),
    projectId:z.string(),runId:z.string(),scopeHash:hash,quoteScopeHash:hash,keys:z.array(z.string()).length(3),
    approvedAt:z.string().datetime(),grantHash:hash}).strict().optional()
  ,quoteObservation:z.object({requestId:z.string(),draftVersion:z.number().int(),confirmable:z.boolean(),
    totalMaxCredits:z.number().int().nonnegative(),items:z.array(z.object({nodeId:z.string(),maxCredits:z.number().int().nonnegative().optional(),reason:z.string().optional()}).strict())}).strict().optional()
}).strict();
export type CanvasProductionBinding=z.infer<typeof canvasProductionBindingSchema>;
export type CanvasNodeBinding=z.infer<typeof canvasNodeBindingSchema>;
