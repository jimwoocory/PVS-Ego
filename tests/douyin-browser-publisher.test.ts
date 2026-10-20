import test from "node:test";
import assert from "node:assert/strict";
import {
  DouyinBrowserAutomationProvider
} from "../src/adapters/publish/douyin-browser-automation-provider.js";
import type {
  DouyinBrowserAccountStatus,
  DouyinBrowserEngineProbe,
  DouyinBrowserLoginResult,
  DouyinBrowserPublishRequest,
  DouyinBrowserPublishResult,
  DouyinBrowserPublisherRuntime
} from "../src/application/ports/douyin-browser-publisher-runtime.js";
import { PublishSubmissionUnknownError } from "../src/application/ports/publish-provider.js";

class FakeRuntime implements DouyinBrowserPublisherRuntime {
  publishRequest?: DouyinBrowserPublishRequest;
  resolvedAccounts = 0;
  checkedAccount?: string;
  publishedAccount?: string;
  accountId = "50805615998";
  publishResult: DouyinBrowserPublishResult = {
    ok: true,
    account: "50805615998",
    status: "PUBLISHED_CONFIRMED",
    verified: true,
    externalReference:
      "https://www.douyin.com/video/7900000000000000010",
    videoId: "7900000000000000010"
  };

  async resolveAccountName(): Promise<string> {
    this.resolvedAccounts += 1;
    return "50805615998";
  }

  async probe(): Promise<DouyinBrowserEngineProbe> {
    return {
      ok: true,
      status: "READY",
      engine: "social-auto-upload",
      bridgeVersion: 1
    };
  }

  async check(accountName?: string): Promise<DouyinBrowserAccountStatus> {
    this.checkedAccount = accountName;
    return {
      ok: true,
      account: accountName ?? "50805615998",
      displayName: "WC",
      platformUserId: this.accountId,
      status: "VALID",
      valid: true
    };
  }

  async login(accountName: string): Promise<DouyinBrowserLoginResult> {
    return {
      ok: true,
      account: accountName,
      status: "success"
    };
  }

  async publish(
    request: DouyinBrowserPublishRequest,
    accountName?: string
  ): Promise<DouyinBrowserPublishResult> {
    this.publishRequest = request;
    this.publishedAccount = accountName;
    return {
      ...this.publishResult,
      account: accountName ?? "50805615998"
    };
  }
}

test("Douyin browser provider exposes valid account and publishes only verified result", async () => {
  const runtime = new FakeRuntime();
  const provider = new DouyinBrowserAutomationProvider(runtime);

  const probe = await provider.probe("project-browser");
  assert.equal(probe.code, "READY");
  assert.equal(probe.accountDisplayName, "WC");
  assert.equal(probe.platformUserId, "50805615998");

  const result = await provider.directPublish({
    projectId: "project-browser",
    packageId: "package-browser",
    videoPath: "C:\\tmp\\final.mp4",
    title: "测试视频",
    description: "正文内容 #AI #产品视频"
  });

  assert.equal(result.trusted, true);
  assert.equal(result.videoId, "7900000000000000010");
  assert.deepEqual(result.platformIdentity, {
    providerAccountId: "50805615998", providerAccountIdType: "DOUYIN_UNIQUE_ID",
    videoId: "7900000000000000010", verifiedAwemeId: "7900000000000000010",
    externalUrl: "https://www.douyin.com/video/7900000000000000010"
  });
  assert.equal(
    result.externalReference,
    "https://www.douyin.com/video/7900000000000000010"
  );
  assert.equal(runtime.publishRequest?.description, "正文内容");
  assert.deepEqual(runtime.publishRequest?.tags, ["AI", "产品视频"]);
  assert.equal(runtime.publishRequest?.declaration, "内容由AI生成");
});

test("browser publish pins one account profile despite active-account changes", async () => {
  const runtime = new FakeRuntime();
  runtime.resolveAccountName = async () => ++runtime.resolvedAccounts === 1 ? "profile-A" : "profile-B";
  const result = await new DouyinBrowserAutomationProvider(runtime).directPublish({
    projectId: "project", packageId: "package", videoPath: "unused.mp4", title: "测试",
    expectedAccountId: "50805615998"
  });
  assert.equal(runtime.resolvedAccounts, 1);
  assert.equal(runtime.checkedAccount, "profile-A");
  assert.equal(runtime.publishedAccount, "profile-A");
  assert.equal(result.platformIdentity?.providerAccountId, "50805615998");
});

test("browser refuses changed or unavailable concrete account identity before publish", async () => {
  for (const accountId of ["different-account", ""]) {
    const runtime = new FakeRuntime();
    runtime.accountId = accountId;
    await assert.rejects(new DouyinBrowserAutomationProvider(runtime).directPublish({
      projectId: "project", packageId: "package", videoPath: "unused.mp4", title: "测试",
      expectedAccountId: "50805615998"
    }), /账号.*变更|无法确认/);
    assert.equal(runtime.publishRequest, undefined);
  }
});

test("browser runtime throws, generic errors, and success without work identity are all unknown", async () => {
  for (const mode of ["throw", "error", "no-id"] as const) {
    const runtime = new FakeRuntime();
    if (mode === "throw") runtime.publish = async () => { throw new Error("synthetic bridge timeout after click"); };
    else if (mode === "error") runtime.publishResult = {
      ok: false, account: "50805615998", status: "ERROR", verified: false, message: "generic bridge error"
    };
    else runtime.publishResult = { ok: true, account: "50805615998", status: "PUBLISHED_CONFIRMED", verified: true,
      externalReference: "https://creator.douyin.com/creator-micro/content/manage" };
    await assert.rejects(new DouyinBrowserAutomationProvider(runtime).directPublish({
      projectId: "project", packageId: "package", videoPath: "unused.mp4", title: "测试"
    }), PublishSubmissionUnknownError);
  }
});

test("Douyin browser provider treats unverified submission as unknown and blocks automatic retry", async () => {
  const runtime = new FakeRuntime();
  runtime.publishResult = {
    ok: true,
    account: "50805615998",
    status: "SUBMISSION_UNKNOWN",
    verified: false,
    externalReference:
      "https://creator.douyin.com/creator-micro/content/manage",
    verificationMessage: "管理页尚未看到本次标题"
  };
  const provider = new DouyinBrowserAutomationProvider(runtime);

  await assert.rejects(
    provider.directPublish({
      projectId: "project-browser",
      packageId: "package-browser",
      videoPath: "C:\\tmp\\final.mp4",
      title: "测试视频"
    }),
    (error: unknown) =>
      error instanceof PublishSubmissionUnknownError &&
      /管理页尚未看到本次标题/.test(error.message)
  );
});
