import test from "node:test";
import assert from "node:assert/strict";
import type {
  DouyinBrowserAccountStatus,
  DouyinBrowserPublisherRuntime
} from "../src/application/ports/douyin-browser-publisher-runtime.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsIdentity,
  type DouyinOpsProbe,
  type DouyinOpsRuntime
} from "../src/application/ports/douyin-ops-runtime.js";
import {
  DouyinAccountBindingService,
  matchDouyinAccounts
} from "../src/application/services/douyin-account-binding-service.js";

const publishReady: DouyinBrowserAccountStatus = {
  ok: true,
  account: "50805615998",
  status: "VALID",
  valid: true,
  displayName: "WC",
  platformUserId: "50805615998",
  currentUrl: "https://creator.douyin.com/creator-micro/home"
};

const opsReady: DouyinOpsIdentity = {
  nickname: "WC",
  uid: "7900000000000000008",
  secUid: "sec-user",
  uniqueId: "50805615998",
  shortId: "0"
};

function publisherRuntime(
  status: DouyinBrowserAccountStatus = publishReady,
  overrides: Partial<DouyinBrowserPublisherRuntime> = {}
): DouyinBrowserPublisherRuntime {
  return {
    async resolveAccountName() {
      return status.account;
    },
    async probe() {
      return { ok: true, status: "READY" };
    },
    async check() {
      return status;
    },
    async login() {
      throw new Error("login is not part of account inspection");
    },
    async publish() {
      throw new Error("publish is not part of account inspection");
    },
    ...overrides
  };
}

function opsRuntime(
  identity: DouyinOpsIdentity = opsReady,
  probe: DouyinOpsProbe = {
    ok: true,
    ready: true,
    status: "READY"
  },
  overrides: Partial<DouyinOpsRuntime> = {}
): DouyinOpsRuntime {
  return {
    async probe() {
      return probe;
    },
    async identity() {
      return identity;
    },
    async listMyWorks() {
      return [];
    },
    async searchWorks() {
      return [];
    },
    async getWork() {
      throw new Error("not used");
    },
    async getComments() {
      return { comments: [], cursor: "0", hasMore: false };
    },
    async getReplies() {
      return { comments: [], cursor: "0", hasMore: false };
    },
    async getDownloadMetadata() {
      throw new Error("not used");
    },
    ...overrides
  };
}

test("strong Douyin ID equality is MATCHED even if nicknames differ", () => {
  const result = matchDouyinAccounts({
    publish: {
      ...publishReady,
      displayName: "发布昵称"
    },
    ops: {
      ...opsReady,
      nickname: "运营昵称"
    },
    checkedAt: "2026-10-07T05:10:00.000Z"
  });

  assert.equal(result.status, "MATCHED");
  assert.equal(result.reason, "STRONG_ID_MATCH");
  assert.equal(result.canAutoBindPublishedWork, true);
  assert.equal(result.nicknameMatched, false);
  assert.equal(result.publish.platformUserId, "50805615998");
  assert.equal(result.ops.uniqueId, "50805615998");
});

test("conflicting strong Douyin IDs are MISMATCHED even when nickname is identical", () => {
  const result = matchDouyinAccounts({
    publish: publishReady,
    ops: {
      ...opsReady,
      uniqueId: "99999999999"
    }
  });

  assert.equal(result.status, "MISMATCHED");
  assert.equal(result.reason, "STRONG_ID_MISMATCH");
  assert.equal(result.nicknameMatched, true);
  assert.equal(result.canAutoBindPublishedWork, false);
});

test("nickname-only equality never becomes MATCHED", () => {
  const result = matchDouyinAccounts({
    publish: publishReady,
    ops: {
      ...opsReady,
      uniqueId: ""
    }
  });

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "OPS_ID_MISSING");
  assert.equal(result.nicknameMatched, true);
  assert.equal(result.canAutoBindPublishedWork, false);
  assert.match(result.message, /不能仅凭昵称/);
});

test("missing publishing platform ID is UNKNOWN even with matching nickname", () => {
  const result = matchDouyinAccounts({
    publish: {
      ...publishReady,
      platformUserId: ""
    },
    ops: opsReady
  });

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "PUBLISH_ID_MISSING");
  assert.equal(result.canAutoBindPublishedWork, false);
});

test("invalid publishing login fails closed before touching ops runtime", async () => {
  let opsCalls = 0;
  const service = new DouyinAccountBindingService(
    publisherRuntime({
      ...publishReady,
      ok: false,
      valid: false,
      status: "AUTH_REQUIRED",
      message: "请重新登录"
    }),
    opsRuntime(opsReady, undefined, {
      async probe() {
        opsCalls += 1;
        return { ok: true, ready: true, status: "READY" };
      }
    })
  );

  const result = await service.inspect();
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "PUBLISH_AUTH_REQUIRED");
  assert.equal(result.canAutoBindPublishedWork, false);
  assert.equal(opsCalls, 0);
  assert.match(result.message, /重新登录/);
});

test("ops runtime offline is UNKNOWN and never attempts identity", async () => {
  let identityCalls = 0;
  const service = new DouyinAccountBindingService(
    publisherRuntime(),
    opsRuntime(
      opsReady,
      {
        ok: false,
        ready: false,
        status: "SITE_OFFLINE",
        message: "抖音主页面未连接"
      },
      {
        async identity() {
          identityCalls += 1;
          return opsReady;
        }
      }
    )
  );

  const result = await service.inspect();
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "OPS_RUNTIME_UNAVAILABLE");
  assert.equal(result.ops.runtimeStatus, "SITE_OFFLINE");
  assert.equal(result.canAutoBindPublishedWork, false);
  assert.equal(identityCalls, 0);
});

test("ops AUTH_REQUIRED from identity is UNKNOWN, not an empty identity match", async () => {
  const service = new DouyinAccountBindingService(
    publisherRuntime(),
    opsRuntime(opsReady, undefined, {
      async identity() {
        throw new DouyinOpsRuntimeError(
          "AUTH_REQUIRED",
          "未取得当前抖音登录账号身份"
        );
      }
    })
  );

  const result = await service.inspect();
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "OPS_AUTH_REQUIRED");
  assert.equal(result.ops.available, true);
  assert.equal(result.ops.runtimeStatus, "AUTH_REQUIRED");
  assert.equal(result.canAutoBindPublishedWork, false);
});

test("publisher runtime exception fails closed as UNKNOWN", async () => {
  const service = new DouyinAccountBindingService(
    publisherRuntime(publishReady, {
      async resolveAccountName() {
        throw new Error("publisher unavailable");
      }
    }),
    opsRuntime()
  );

  const result = await service.inspect();
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "PUBLISH_RUNTIME_ERROR");
  assert.equal(result.canAutoBindPublishedWork, false);
  assert.match(result.message, /publisher unavailable/);
});

test("ops probe exception fails closed as UNKNOWN", async () => {
  const service = new DouyinAccountBindingService(
    publisherRuntime(),
    opsRuntime(opsReady, undefined, {
      async probe() {
        throw new Error("bridge process failed");
      }
    })
  );

  const result = await service.inspect();
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.reason, "OPS_RUNTIME_ERROR");
  assert.equal(result.canAutoBindPublishedWork, false);
  assert.match(result.message, /bridge process failed/);
});

test("reuses supplied ops probe without an extra Bridge probe", async () => {
  let probeCalls = 0;
  const service = new DouyinAccountBindingService(
    publisherRuntime(),
    opsRuntime(opsReady, undefined, {
      async probe() {
        probeCalls += 1;
        return { ok: true, ready: true, status: "READY" };
      }
    })
  );

  const result = await service.inspect({
    ok: true,
    ready: true,
    status: "READY"
  });
  assert.equal(result.status, "MATCHED");
  assert.equal(probeCalls, 0);
});

test("service returns MATCHED only after both runtimes provide matching strong IDs", async () => {
  const service = new DouyinAccountBindingService(
    publisherRuntime(),
    opsRuntime()
  );

  const result = await service.inspect();
  assert.equal(result.status, "MATCHED");
  assert.equal(result.reason, "STRONG_ID_MATCH");
  assert.equal(result.publish.displayName, "WC");
  assert.equal(result.ops.nickname, "WC");
  assert.equal(result.canAutoBindPublishedWork, true);
});
