import { z } from "zod";
import {
  entityIdSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  sha256Schema
} from "./schemas.js";

export const publishProviderTypeSchema = z.enum([
  "DOUYIN_BROWSER_AUTOMATION",
  "DOUYIN_SDK_HANDOFF",
  "DOUYIN_H5_HANDOFF",
  "DOUYIN_OPENAPI_DIRECT",
  "MANUAL_EXPORT"
]);

export const publishProviderModeSchema = z.enum([
  "HANDOFF",
  "DIRECT",
  "MANUAL"
]);

export const publishProviderProbeCodeSchema = z.enum([
  "READY",
  "DISABLED",
  "NOT_CONFIGURED",
  "AUTH_REQUIRED",
  "UNAVAILABLE"
]);

export const publishPackageStatusSchema = z.enum([
  "PACKAGE_READY",
  "HANDOFF_STARTED",
  "AWAITING_USER_ACTION",
  "DIRECT_PUBLISHING",
  "SUBMISSION_UNKNOWN",
  "HANDOFF_COMPLETED",
  "PUBLISHED_CONFIRMED",
  "FAILED",
  "EXPIRED"
]);

export const publishReceiptKindSchema = z.enum([
  "PACKAGE_CLAIMED",
  "HANDOFF_STARTED",
  "HANDOFF_COMPLETED",
  "SUBMISSION_UNKNOWN",
  "PUBLISHED_CONFIRMED",
  "FAILED"
]);

/** Opaque OpenAPI IDs must never be inferred to be public Douyin work IDs. */
export function douyinAwemeIdFromUrl(reference: string | undefined): string | null {
  if (!reference?.trim()) return null;
  try {
    const url = new URL(reference);
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) ||
        !(host === "douyin.com" || host.endsWith(".douyin.com"))) return null;
    return /(?:^|\/)video\/(\d{8,30})(?:\/|$)/.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export const publishPlatformIdentitySchema = z.object({
  providerAccountId: nonEmptyStringSchema.optional(),
  providerAccountIdType: z.enum(["DOUYIN_UNIQUE_ID", "OPEN_ID", "UNKNOWN"]).optional(),
  videoId: nonEmptyStringSchema.optional(),
  itemId: nonEmptyStringSchema.optional(),
  verifiedAwemeId: z.string().regex(/^\d{8,30}$/).optional(),
  externalUrl: z.string().url().optional()
}).strict().superRefine((identity, ctx) => {
  if (identity.verifiedAwemeId && douyinAwemeIdFromUrl(identity.externalUrl) !== identity.verifiedAwemeId) {
    ctx.addIssue({ code: "custom", path: ["verifiedAwemeId"],
      message: "Verified awemeId requires a matching explicit Douyin video URL" });
  }
  if (identity.providerAccountIdType && !identity.providerAccountId) {
    ctx.addIssue({ code: "custom", path: ["providerAccountId"], message: "Account ID type requires its original ID" });
  }
});

export const publishPreferenceSchema = z.object({
  projectId: entityIdSchema,
  providerType: publishProviderTypeSchema,
  updatedAt: isoDateTimeSchema
});

export const publishPackageSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  finalAssemblyId: entityIdSchema,
  finalArtifactId: entityIdSchema,
  finalArtifactHash: sha256Schema,
  providerType: publishProviderTypeSchema,
  titleDraft: nonEmptyStringSchema,
  descriptionDraft: z.string().trim().optional(),
  coverArtifactId: entityIdSchema.optional(),
  expiresAt: isoDateTimeSchema,
  singleUseTokenHash: sha256Schema,
  tokenConsumedAt: isoDateTimeSchema.optional(),
  sessionTokenHash: sha256Schema.optional(),
  sessionExpiresAt: isoDateTimeSchema.optional(),
  mediaTokenHash: sha256Schema.optional(),
  mediaExpiresAt: isoDateTimeSchema.optional(),
  status: publishPackageStatusSchema,
  handoffReference: nonEmptyStringSchema.optional(),
  errorCode: nonEmptyStringSchema.optional(),
  errorMessage: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema,
  claimedAt: isoDateTimeSchema.optional(),
  handoffStartedAt: isoDateTimeSchema.optional(),
  completedAt: isoDateTimeSchema.optional(),
  publishedConfirmedAt: isoDateTimeSchema.optional()
}).superRefine((value, ctx) => {
  if (value.tokenConsumedAt && !value.claimedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claimedAt"],
      message: "Consumed publish token requires claimedAt"
    });
  }
  if (value.sessionTokenHash && !value.sessionExpiresAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionExpiresAt"],
      message: "Publish session hash requires sessionExpiresAt"
    });
  }
  if (value.mediaTokenHash && !value.mediaExpiresAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mediaExpiresAt"],
      message: "Publish media token hash requires mediaExpiresAt"
    });
  }
  if (value.status === "PUBLISHED_CONFIRMED" && !value.publishedConfirmedAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["publishedConfirmedAt"],
      message: "PUBLISHED_CONFIRMED requires publishedConfirmedAt"
    });
  }
});

export const publishReceiptSchema = z.object({
  id: entityIdSchema,
  projectId: entityIdSchema,
  packageId: entityIdSchema,
  providerType: publishProviderTypeSchema,
  kind: publishReceiptKindSchema,
  trusted: z.boolean(),
  externalReference: nonEmptyStringSchema.optional(),
  platformIdentity: publishPlatformIdentitySchema.optional(),
  evidenceHash: sha256Schema.optional(),
  note: z.string().trim().optional(),
  createdAt: isoDateTimeSchema
}).superRefine((value, ctx) => {
  if (value.kind === "PUBLISHED_CONFIRMED" && !value.trusted) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["trusted"],
      message: "PUBLISHED_CONFIRMED receipt must be trusted"
    });
  }
});

export type PublishProviderType = z.infer<typeof publishProviderTypeSchema>;
export type PublishProviderMode = z.infer<typeof publishProviderModeSchema>;
export type PublishProviderProbeCode = z.infer<
  typeof publishProviderProbeCodeSchema
>;
export type PublishPackageStatus = z.infer<typeof publishPackageStatusSchema>;
export type PublishReceiptKind = z.infer<typeof publishReceiptKindSchema>;
export type PublishPreference = z.infer<typeof publishPreferenceSchema>;
export type PublishPackage = z.infer<typeof publishPackageSchema>;
export type PublishReceipt = z.infer<typeof publishReceiptSchema>;
export type PublishPlatformIdentity = z.infer<typeof publishPlatformIdentitySchema>;
