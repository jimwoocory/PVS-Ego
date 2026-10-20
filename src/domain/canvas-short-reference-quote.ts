import {z} from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const shortReferenceQuoteSchema=z.object({
  revisionId:z.string(),revisionHash:hash,requestHash:hash,projectId:z.string(),accountFingerprint:hash,profile:z.string(),executableSha256:hash,
  productNodeId:z.string(),productSha256:hash,imagePrompt:z.string().min(1).max(2000),
  nodes:z.array(z.object({key:z.enum(["SETTING","VIDEO","PRODUCT_ONLY_COMPARISON"]),nodeId:z.string(),updateId:z.string(),
    generationHash:hash,saved:z.boolean()}).strict()).length(3),
  checkedAt:z.string().datetime(),draftVersion:z.number().int().optional(),sourceRequestId:z.string().optional(),
  items:z.array(z.object({key:z.string(),nodeId:z.string(),credits:z.number().int().nonnegative().nullable(),error:z.string().optional()}).strict()).optional(),
  totalCredits:z.number().int().nonnegative().nullable(),status:z.enum(["PREPARING","INCOMPLETE","QUOTED","OVER_BUDGET"]),
  validity:z.literal("REVALIDATE_DRAFT_AND_REFERENCES"),error:z.string().optional(),
  generationAuthorized:z.literal(false),publishAuthorized:z.literal(false)
}).strict();
export type ShortReferenceQuote=z.infer<typeof shortReferenceQuoteSchema>;
