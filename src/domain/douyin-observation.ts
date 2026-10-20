import {z} from "zod";
export const metricKeys=["plays","likes","comments","shares","collects"] as const;
export const metricAvailabilitySchema=z.object({
 plays:z.enum(["OBSERVED","NOT_PROVIDED","NOT_VISIBLE","LEGACY_UNVERIFIED"]).optional(),
 likes:z.enum(["OBSERVED","NOT_PROVIDED","NOT_VISIBLE","LEGACY_UNVERIFIED"]).optional(),
 comments:z.enum(["OBSERVED","NOT_PROVIDED","NOT_VISIBLE","LEGACY_UNVERIFIED"]).optional(),
 shares:z.enum(["OBSERVED","NOT_PROVIDED","NOT_VISIBLE","LEGACY_UNVERIFIED"]).optional(),
 collects:z.enum(["OBSERVED","NOT_PROVIDED","NOT_VISIBLE","LEGACY_UNVERIFIED"]).optional()
});
export type MetricAvailability=z.infer<typeof metricAvailabilitySchema>;
export const commentPageCoverageSchema=z.object({status:z.enum(["VISIBLE","PARTIAL","NOT_VISIBLE","UNKNOWN"]),truncated:z.boolean().default(false),reason:z.string().max(500).optional()});
export type CommentPageCoverage=z.infer<typeof commentPageCoverageSchema>;
