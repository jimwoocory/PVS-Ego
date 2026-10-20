import test from "node:test";
import assert from "node:assert/strict";
import type {
  PublishPackage,
  PublishReceipt
} from "../src/domain/publish.js";
import { publishPlatformIdentitySchema } from "../src/domain/publish.js";
import type {
  DouyinAccountMatchResult
} from "../src/application/services/douyin-account-binding-service.js";
import {
  DouyinWorkBindingService,
  extractAwemeIdFromTrustedReference
} from "../src/application/services/douyin-work-binding-service.js";

const pkg: PublishPackage = {
  id: "package-1",
  projectId: "project-1",
  finalAssemblyId: "assembly-1",
  finalArtifactId: "artifact-1",
  finalArtifactHash:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  providerType: "DOUYIN_BROWSER_AUTOMATION",
  titleDraft: "测试作品",
  descriptionDraft: "正文",
  expiresAt: "2026-10-07T06:00:00.000Z",
  singleUseTokenHash:
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  status: "PUBLISHED_CONFIRMED",
  createdAt: "2026-10-07T05:00:00.000Z",
  publishedConfirmedAt: "2026-10-07T05:05:00.000Z"
};

const trustedReceipt: PublishReceipt = {
  id: "receipt-1",
  projectId: "project-1",
  packageId: "package-1",
  providerType: "DOUYIN_BROWSER_AUTOMATION",
  kind: "PUBLISHED_CONFIRMED",
  trusted: true,
  externalReference:
    "https://www.douyin.com/video/7900000000000000010",
  createdAt: "2026-10-07T05:05:00.000Z"
};

function accountMatch(
  status: DouyinAccountMatchResult["status"]
): DouyinAccountMatchResult {
  const matched = status === "MATCHED";
  return {
    status,
    reason:
      status === "MATCHED"
        ? "STRONG_ID_MATCH"
        : status === "MISMATCHED"
          ? "STRONG_ID_MISMATCH"
          : "OPS_AUTH_REQUIRED",
    publish: {
      valid: true,
      displayName: "WC",
      platformUserId: "50805615998",
      runtimeStatus: "VALID"
    },
    ops: {
      available: status !== "UNKNOWN",
      nickname: "WC",
      uid: "uid",
      secUid: "sec",
      uniqueId:
        status === "MISMATCHED"
          ? "99999999999"
          : matched
            ? "50805615998"
            : "",
      shortId: "0",
      runtimeStatus:
        status === "UNKNOWN" ? "AUTH_REQUIRED" : "READY"
    },
    nicknameMatched: true,
    canAutoBindPublishedWork: matched,
    checkedAt: "2026-10-07T05:05:00.000Z",
    message: status
  };
}

test("trusted-reference parser accepts only explicit Douyin video paths", () => {
  assert.equal(
    extractAwemeIdFromTrustedReference(
      "https://www.douyin.com/video/7900000000000000010"
    ),
    "7900000000000000010"
  );
  assert.equal(
    extractAwemeIdFromTrustedReference(
      "https://creator.douyin.com/video/7900000000000000010?from=publish"
    ),
    "7900000000000000010"
  );
  assert.equal(
    extractAwemeIdFromTrustedReference(
      "https://example.test/video/7900000000000000010"
    ),
    null
  );
  assert.equal(
    extractAwemeIdFromTrustedReference(
      "https://creator.douyin.com/creator-micro/content/manage?video=7900000000000000010"
    ),
    null
  );
  assert.equal(
    extractAwemeIdFromTrustedReference(
      "not-a-url/video/7900000000000000010"
    ),
    null
  );
});

test("legacy trusted publish URL remains readable when account discovery is unavailable", () => {
  const service = new DouyinWorkBindingService();
  const result = service.fromPublishReceipt({
    pkg,
    receipt: trustedReceipt,
    accountMatch: accountMatch("UNKNOWN")
  });

  assert.equal(result.status, "BOUND");
  assert.equal(result.source, "PUBLISH_RECEIPT");
  assert.equal(result.awemeId, "7900000000000000010");
  assert.equal(result.confidence, "TRUSTED");
  assert.equal(result.canAutoDiscover, false);
  assert.equal(result.requiresUserSelection, false);
});

test("a verified work URL never bypasses an explicit account mismatch", () => {
  const result = new DouyinWorkBindingService().fromPublishReceipt({
    pkg, receipt: trustedReceipt, accountMatch: accountMatch("MISMATCHED")
  });
  assert.equal(result.status, "BLOCKED_ACCOUNT_MISMATCH");
  assert.equal(result.awemeId, undefined);
});

test("structured original IDs stay opaque and only a verified URL establishes a public work identity", () => {
  const service = new DouyinWorkBindingService();
  const originalIds = { videoId: "7900000000000000010", itemId: "opaque-openapi-item" };
  const opaque = service.fromPublishReceipt({
    pkg, receipt: { ...trustedReceipt, externalReference: "7900000000000000010", platformIdentity: originalIds },
    accountMatch: accountMatch("MATCHED")
  });
  assert.equal(opaque.status, "PENDING_DISCOVERY");
  assert.equal(opaque.awemeId, undefined);
  const bound = service.fromPublishReceipt({
    pkg, receipt: { ...trustedReceipt, externalReference: "opaque-openapi-item", platformIdentity: {
      ...originalIds, verifiedAwemeId: "7900000000000000010",
      externalUrl: "https://www.douyin.com/video/7900000000000000010"
    } }, accountMatch: accountMatch("MATCHED")
  });
  assert.equal(bound.status, "BOUND");
  assert.equal(bound.awemeId, "7900000000000000010");
  assert.equal(bound.externalUrl, "https://www.douyin.com/video/7900000000000000010");
  assert.equal(publishPlatformIdentitySchema.safeParse({ verifiedAwemeId: "7900000000000000010" }).success, false);
  assert.equal(publishPlatformIdentitySchema.safeParse({ verifiedAwemeId: "7900000000000000010",
    externalUrl: "https://example.test/video/7900000000000000010" }).success, false);
});

test("structured publisher account checks compare the correct ID namespace and the recorded publishing account", () => {
  const service = new DouyinWorkBindingService();
  const receipt = { ...trustedReceipt, platformIdentity: {
    providerAccountId: "50805615998", providerAccountIdType: "DOUYIN_UNIQUE_ID" as const,
    verifiedAwemeId: "7900000000000000010", externalUrl: trustedReceipt.externalReference
  } };
  assert.equal(service.fromPublishReceipt({ pkg, receipt,
    accountMatch: accountMatch("MISMATCHED") }).status, "BLOCKED_ACCOUNT_MISMATCH");
  assert.equal(service.fromPublishReceipt({ pkg, receipt,
    accountMatch: accountMatch("UNKNOWN") }).status, "PENDING_DISCOVERY");
  assert.equal(service.fromPublishReceipt({ pkg, receipt,
    accountMatch: accountMatch("MATCHED") }).status, "BOUND");
  // The same-looking raw open_id is a different namespace, not evidence of a unique_id mismatch.
  assert.equal(service.fromPublishReceipt({ pkg, receipt: { ...trustedReceipt,
    platformIdentity: { providerAccountId: "open-id-other", providerAccountIdType: "OPEN_ID" } },
    accountMatch: accountMatch("MATCHED") }).status, "BOUND");
});

test("receipt from another package, project or provider cannot be used as binding evidence", () => {
  const service = new DouyinWorkBindingService();
  for (const mismatch of [{ packageId: "other" }, { projectId: "other" }, { providerType: "DOUYIN_H5_HANDOFF" as const }]) {
    assert.equal(service.fromPublishReceipt({ pkg, receipt: { ...trustedReceipt, ...mismatch },
      accountMatch: accountMatch("MATCHED") }).reason, "NO_TRUSTED_RECEIPT");
  }
});

test("untrusted receipt never binds even when its URL contains a video id", () => {
  const service = new DouyinWorkBindingService();
  const result = service.fromPublishReceipt({
    pkg,
    receipt: {
      ...trustedReceipt,
      trusted: false
    },
    accountMatch: accountMatch("MATCHED")
  });

  assert.equal(result.status, "PENDING_DISCOVERY");
  assert.equal(result.reason, "NO_TRUSTED_RECEIPT");
  assert.equal(result.awemeId, undefined);
  assert.equal(result.canAutoDiscover, false);
});

test("trusted receipt without video id blocks ops discovery on account mismatch", () => {
  const service = new DouyinWorkBindingService();
  const result = service.fromPublishReceipt({
    pkg,
    receipt: {
      ...trustedReceipt,
      externalReference:
        "https://creator.douyin.com/creator-micro/content/manage"
    },
    accountMatch: accountMatch("MISMATCHED")
  });

  assert.equal(result.status, "BLOCKED_ACCOUNT_MISMATCH");
  assert.equal(result.reason, "ACCOUNT_MISMATCH");
  assert.equal(result.canAutoDiscover, false);
  assert.equal(result.requiresUserSelection, true);
});

test("trusted receipt without video id waits when account identity is unknown", () => {
  const service = new DouyinWorkBindingService();
  const result = service.fromPublishReceipt({
    pkg,
    receipt: {
      ...trustedReceipt,
      externalReference:
        "https://creator.douyin.com/creator-micro/content/manage"
    },
    accountMatch: accountMatch("UNKNOWN")
  });

  assert.equal(result.status, "PENDING_DISCOVERY");
  assert.equal(result.reason, "ACCOUNT_MATCH_REQUIRED");
  assert.equal(result.canAutoDiscover, false);
  assert.equal(result.requiresUserSelection, true);
});

test("trusted receipt without video id permits bounded discovery only for MATCHED accounts", () => {
  const service = new DouyinWorkBindingService();
  const result = service.fromPublishReceipt({
    pkg,
    receipt: {
      ...trustedReceipt,
      externalReference:
        "https://creator.douyin.com/creator-micro/content/manage"
    },
    accountMatch: accountMatch("MATCHED")
  });

  assert.equal(result.status, "PENDING_DISCOVERY");
  assert.equal(
    result.reason,
    "TRUSTED_RECEIPT_WITHOUT_VIDEO_ID"
  );
  assert.equal(result.canAutoDiscover, true);
  assert.equal(result.requiresUserSelection, false);
});

test("ambiguous discovery is converted to explicit user selection", () => {
  const service = new DouyinWorkBindingService();
  const result = service.requireUserSelection({
    pkg,
    receipt: {
      ...trustedReceipt,
      externalReference:
        "https://creator.douyin.com/creator-micro/content/manage"
    },
    accountMatch: accountMatch("MATCHED")
  });

  assert.equal(result.status, "NEEDS_USER_SELECTION");
  assert.equal(result.canAutoDiscover, false);
  assert.equal(result.requiresUserSelection, true);
});

test("explicit user selection creates a USER_CONFIRMED binding", () => {
  const service = new DouyinWorkBindingService();
  const result = service.confirmUserSelection({
    pkg,
    receipt: trustedReceipt,
    awemeId: "7900000000000000010"
  });

  assert.equal(result.status, "BOUND");
  assert.equal(result.source, "USER_CONFIRMED");
  assert.equal(result.confidence, "USER_CONFIRMED");
  assert.equal(result.awemeId, "7900000000000000010");
  assert.equal(
    result.externalUrl,
    "https://www.douyin.com/video/7900000000000000010"
  );
});

test("explicit user selection rejects malformed or mismatched work identity", () => {
  const service = new DouyinWorkBindingService();

  assert.throws(
    () =>
      service.confirmUserSelection({
        pkg,
        awemeId: "../bad"
      }),
    /awemeId 格式无效/
  );

  assert.throws(
    () =>
      service.confirmUserSelection({
        pkg,
        awemeId: "7900000000000000010",
        externalUrl:
          "https://www.douyin.com/video/7900000000000000001"
      }),
    /不一致/
  );

  assert.throws(
    () =>
      service.confirmUserSelection({
        pkg,
        awemeId: "7900000000000000010",
        externalUrl:
          "https://example.test/video/7900000000000000010"
      }),
    /不一致/
  );
});
