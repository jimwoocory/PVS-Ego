import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/i);
export const quoteItemSchema = z.object({
  key: z.string().min(1), label: z.string().min(1), kind: z.enum(["IMAGE", "VIDEO"]),
  providerId: z.string().min(1), model: z.string().min(1), operation: z.string().min(1),
  resolution: z.string().min(1), aspectRatio: z.string().min(1), count: z.number().int().positive(),
  durationMs: z.number().int().positive().optional(), nativeAudio: z.boolean(),
  references: z.object({ images: z.number().int().nonnegative(), videos: z.number().int().nonnegative(), audio: z.number().int().nonnegative() }).strict(),
  sourceRequestHash: hash
}).strict();
export const quoteRequestSchema = z.object({
  contract: z.literal("pvs-generation-quote-v1"), projectId: z.string().min(1), runId: z.string().min(1),
  scopeHash: hash, items: z.array(quoteItemSchema).min(1)
}).strict();
export const providerQuoteSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("UNAVAILABLE"), code: z.string().min(1), message: z.string().min(1) }).strict(),
  z.object({ status: z.literal("QUOTED"), kind: z.enum(["BINDING_QUOTE", "CREDIT_CEILING"]),
    requestHash: hash, providerQuoteId: z.string().min(1).optional(), sourceRequestId:z.string().min(1).optional(), accountFingerprint: z.string().min(1),
    currency: z.literal("CREDITS"), credits: z.number().finite().nonnegative(),
    issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), sourceUrl: z.string().url(),
    // Canvas quotes saved creative drafts; parameter-only providers explicitly declare sufficiency.
    pricingParametersSufficient: z.boolean(),
    validityBasis:z.enum(["PROVIDER_EXPIRY","REVALIDATE_DRAFT"]).optional(),
    canvas:z.object({projectId:z.string().uuid(),nodeId:z.string().startsWith("node_"),draftVersion:z.number().int().nonnegative(),generationHash:hash,canonicalModel:z.string().min(1)}).strict().optional()
  }).strict()
]).superRefine((value,ctx)=>{
  if(value.status!=="QUOTED")return;
  if(value.validityBasis==="REVALIDATE_DRAFT"){
    if(value.kind!=="CREDIT_CEILING"||!value.canvas||!value.sourceRequestId)ctx.addIssue({code:"custom",message:"Canvas上限报价必须保留真实节点、草稿和请求引用"});
  }else if(!value.providerQuoteId||!value.pricingParametersSufficient)ctx.addIssue({code:"custom",message:"固定报价缺少提供方凭证或完整计费输入"});
});
export const productionQuoteSchema = z.object({
  contract: z.literal("pvs-generation-quote-v1"), projectId: z.string(), runId: z.string(),
  scopeHash: hash, queriedAt: z.string().datetime(), status: z.enum(["QUOTED", "UNAVAILABLE"]),
  items: z.array(z.object({ request: quoteItemSchema, requestHash: hash, result: providerQuoteSchema }).strict()).min(1),
  totals: z.array(z.object({ providerId: z.string(), currency: z.literal("CREDITS"), kind: z.enum(["BINDING_QUOTE", "CREDIT_CEILING"]), credits: z.number().finite().nonnegative() }).strict()),
  grandTotal: z.object({ currency: z.literal("CREDITS"), kind: z.enum(["BINDING_QUOTE", "CREDIT_CEILING"]), credits: z.number().finite().nonnegative() }).strict().optional(),
  expiresAt: z.string().datetime().optional(),
  missingInterfaces: z.array(z.object({ providerId: z.string(), code: z.string(), message: z.string() }).strict()),
  noGenerationSubmitted: z.literal(true)
}).strict();
export type QuoteItem = z.infer<typeof quoteItemSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type ProviderQuote = z.infer<typeof providerQuoteSchema>;
export type ProductionQuote = z.infer<typeof productionQuoteSchema>;
