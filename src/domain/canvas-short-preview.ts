import {z} from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const canvasShortPreviewInput=z.object({
  sourceScriptHash:hash,title:z.string().min(1).max(120),
  prompt12s:z.string().min(1).max(3500),prompt15s:z.string().min(1).max(3500),
  tailCardText:z.array(z.string().min(1).max(100)).min(1).max(4)
}).strict();
export const canvasShortPreviewSchema=z.object({
  id:z.string().uuid(),sourceRunId:z.string(),sourceScriptHash:hash,sourcePlanHash:hash,inputHash:hash,
  title:z.string(),outputDurationMs:z.literal(15000),tailCardText:z.array(z.string()),
  accountFingerprint:hash,canvasProjectId:z.string().uuid(),referenceNodeIds:z.array(z.string()).min(1),
  candidates:z.array(z.object({key:z.string(),nodeId:z.string(),updateId:z.string().uuid(),model:z.string(),
    generatedDurationMs:z.union([z.literal(12000),z.literal(15000)]),localTailMs:z.union([z.literal(0),z.literal(3000)]),
    prompt:z.string(),generationHash:hash.optional(),saved:z.boolean(),
    quote:z.object({maxCredits:z.number().int().nonnegative(),requestId:z.string(),draftVersion:z.number().int(),
      observedAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict().optional(),errorCode:z.string().optional()
  }).strict()).length(6),
  status:z.enum(["DRAFTING","QUOTED","PARTIAL"]),recommendedKey:z.string().optional(),
  paidGenerationAuthorized:z.literal(false),publishAuthorized:z.literal(false),
  checkedAt:z.string().datetime()
}).strict();
export type CanvasShortPreview=z.infer<typeof canvasShortPreviewSchema>;
export type CanvasShortPreviewInput=z.infer<typeof canvasShortPreviewInput>;
