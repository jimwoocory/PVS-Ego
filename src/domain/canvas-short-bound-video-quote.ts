import {z} from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const shortBoundVideoQuoteSchema=z.object({
  scopeHash:hash,revisionHash:hash,canvasProjectId:z.string(),accountFingerprint:hash,profile:z.string(),executableSha256:hash,
  videoNodeId:z.string(),generationHash:hash,model:z.literal("seedance_2.0_fast_vip"),resolution:z.literal("720p"),ratio:z.literal("9:16"),durationMs:z.literal(12000),count:z.literal(1),
  references:z.array(z.object({role:z.enum(["PRODUCT","SETTING"]),nodeId:z.string(),resourceId:z.string(),artifactId:z.string(),sha256:hash}).strict()).length(2),
  draftVersion:z.number().int(),checkedAt:z.string().datetime(),sourceRequestId:z.string().optional(),
  imageCredits:z.literal(0),videoCredits:z.number().int().nonnegative().nullable(),totalCredits:z.number().int().nonnegative().nullable(),creditCeiling:z.literal(72),
  status:z.enum(["QUOTED","OVER_BUDGET","INCOMPLETE"]),error:z.string().optional(),validity:z.literal("REVALIDATE_DRAFT_AND_REFERENCES"),
  videoGenerationAuthorized:z.literal(false),noVideoGenerationSubmitted:z.literal(true),publishAuthorized:z.literal(false)
}).strict();
