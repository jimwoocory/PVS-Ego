import { z } from "zod";
import {commentPageCoverageSchema} from "./douyin-observation.js";

const id = z.string().trim().min(1);
export const douyinCollectionStartSchema = z.object({
  projectId: id, requestKey: id.max(200), bindingId: id.optional(),
  awemeId: z.string().regex(/^\d{8,30}$/).optional(),
  kind: z.enum(["COMMENTS", "REPLIES"]).default("COMMENTS"),
  parentCid: z.string().regex(/^\d{1,40}$/).optional(),
  pageSize: z.number().int().min(1).max(20).default(20),
  batchPages: z.number().int().min(1).max(5).default(1)
}).strict().superRefine((input, ctx) => {
  if ((input.kind === "REPLIES") !== Boolean(input.parentCid)) {
    ctx.addIssue({ code: "custom", path: ["parentCid"], message: "楼中楼采集必须指定当前作品的顶层评论" });
  }
});

export const douyinCollectionRunSchema = z.object({
  id, projectId: id, bindingId: id, awemeId: z.string().regex(/^\d{8,30}$/),
  parentCid: z.string().regex(/^\d{1,40}$/).optional(),
  kind: z.enum(["COMMENTS", "REPLIES"]), requestKey: id, inputHash: id,
  opsAccountUid:id.optional(),coverage:commentPageCoverageSchema.optional(),observedAt:z.string().datetime().optional(),
  pageSize: z.number().int().min(1).max(20), batchPages: z.number().int().min(1).max(5),
  status: z.enum(["QUEUED", "RUNNING", "PARTIAL", "COMPLETED", "BLOCKED"]),
  cursor: z.string().max(2000), pages: z.number().int().nonnegative(),
  // Current number of distinct, persisted comments in this exact scope, not the sum of repeated page reads.
  syncedCount: z.number().int().nonnegative(), hasMore: z.boolean(),
  truncated: z.boolean(), partial: z.boolean(), revision: z.number().int().positive(),
  visitedCursors: z.array(z.string().max(2000)), retryable: z.boolean(),
  errorCode: z.string().optional(), errorMessage: z.string().optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export type DouyinCollectionRun = z.infer<typeof douyinCollectionRunSchema>;
export type DouyinCollectionStart = z.input<typeof douyinCollectionStartSchema>;
