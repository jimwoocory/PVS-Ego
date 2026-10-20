import {z} from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/),time=z.string().datetime();
export const shortReferenceImageSchema=z.object({
  scopeHash:hash,revisionHash:hash,quoteRequestHash:hash,nodeId:z.string(),generationHash:hash,accountFingerprint:hash,
  creditCeiling:z.literal(0),count:z.literal(1),model:z.literal("seedream_5.0_lite"),
  consent:z.object({source:z.literal("EXPLICIT_USER_ZERO_REFERENCE_IMAGE"),approvedAt:time}).strict(),
  submitId:z.string().uuid(),state:z.enum(["PREPARED","DISPATCHING","ACCEPTED","UNKNOWN","FAILED","NEEDS_REVIEW","ADOPTED"]),
  liveQuote:z.object({draftVersion:z.number().int(),sourceRequestId:z.string(),checkedAt:time,credits:z.literal(0)}).strict(),
  resources:z.array(z.string()),submissionRequestId:z.string().optional(),observationRequestId:z.string().optional(),updatedAt:time,
  artifact:z.object({id:z.string(),sha256:hash,relativePath:z.string(),sizeBytes:z.number().int(),mimeType:z.string(),width:z.number().int(),height:z.number().int()}).strict().optional(),
  review:z.object({source:z.literal("EXPLICIT_USER_ADOPT_REFERENCE"),revisionHash:hash,artifactId:z.string(),sha256:hash,resourceId:z.string(),reviewedAt:time}).strict().optional(),
  error:z.string().optional()
}).strict();
export type ShortReferenceImage=z.infer<typeof shortReferenceImageSchema>;
