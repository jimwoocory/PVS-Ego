import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type {
  DouyinOpsGlobalView,
  DouyinOpsProjectView,
  DouyinOpsDashboardService
} from "../src/application/services/douyin-ops-dashboard-service.js";
import {
  renderDouyinOpsGlobalPage,
  renderDouyinOpsProjectPage
} from "../src/web/douyin-ops-ui.js";
import { handleDouyinOpsHttp } from "../src/web/douyin-ops-http.js";
import { WindowsDouyinOpsLauncher } from "../src/adapters/douyin/windows-douyin-ops-launcher.js";
import { renderPvsGlobalHeader } from "../src/web/pvs-global-shell.js";

const work = {
  awemeId: "7900000000000000010",
  description: "可以的#拳击 #AIGC",
  publishedAt: "2026-09-15T09:35:34.000Z",
  author: {
    nickname: "WC",
    uid: "uid",
    secUid: "sec",
    uniqueId: "50805615998"
  },
  metrics: {
    plays: 310,
    likes: 9,
    comments: 2,
    shares: 0
  },
  durationMs: 30047,
  coverUrl: "",
  externalUrl:
    "https://www.douyin.com/video/7900000000000000010"
};

const account = {
  status: "MATCHED" as const,
  reason: "STRONG_ID_MATCH" as const,
  publish: {
    valid: true,
    displayName: "WC",
    platformUserId: "50805615998",
    runtimeStatus: "VALID"
  },
  ops: {
    available: true,
    nickname: "WC",
    uid: "uid",
    secUid: "sec",
    uniqueId: "50805615998",
    shortId: "0",
    runtimeStatus: "READY"
  },
  nicknameMatched: true,
  canAutoBindPublishedWork: true,
  checkedAt: "2026-10-07T05:30:00.000Z",
  message: "发布账号与运营账号的抖音号一致。"
};

const binding = {
  id: "binding-1",
  projectId: "project-1",
  packageId: "package-1",
  publishReceiptId: "receipt-1",
  awemeId: work.awemeId,
  source: "PUBLISH_RECEIPT" as const,
  confidence: "TRUSTED" as const,
  status: "BOUND" as const,
  boundAt: "2026-10-07T05:10:00.000Z",
  externalUrl: work.externalUrl,
  createdAt: "2026-10-07T05:10:00.000Z",
  updatedAt: "2026-10-07T05:10:00.000Z"
};

const globalView: DouyinOpsGlobalView = {
  runtime: {
    ok: true,
    ready: true,
    status: "READY",
    contractVersion: 1,
    connection: {
      id: "conn",
      url: "https://www.douyin.com/"
    }
  },
  account,
  works: [work],
  worksStatus: "READY",
  linkedProjects: [
    {
      projectId: "project-1",
      projectName: "耳机宣传",
      binding
    }
  ]
};

const projectView: DouyinOpsProjectView = {
  project: {
    id: "project-1",
    name: "耳机宣传"
  },
  runtime: {
    ok: false,
    ready: false,
    status: "SITE_OFFLINE",
    message: "抖音主页面未连接"
  },
  account,
  publishPackage: null,
  publishReceipt: null,
  binding,
  snapshots: [
    {
      id: "snapshot-1",
      projectId: "project-1",
      bindingId: "binding-1",
      awemeId: work.awemeId,
      captureKey: "one",
      capturedAt: "2026-10-07T05:20:00.000Z",
      plays: 300,
      likes: 8,
      comments: 1,
      shares: 0,
      rawJson: "{}",
      contentHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      createdAt: "2026-10-07T05:20:00.000Z"
    },
    {
      id: "snapshot-2",
      projectId: "project-1",
      bindingId: "binding-1",
      awemeId: work.awemeId,
      captureKey: "two",
      capturedAt: "2026-10-07T05:30:00.000Z",
      plays: 310,
      likes: 9,
      comments: 2,
      shares: 0,
      rawJson: "{}",
      contentHash:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      createdAt: "2026-10-07T05:30:00.000Z"
    }
  ],
  comments: [
    {
      id: "comment-1",
      projectId: "project-1",
      bindingId: "binding-1",
      awemeId: work.awemeId,
      cid: "1001",
      nickname: "MJ",
      text: "帅呀",
      diggCount: 1,
      replyCount: 2,
      platformCreatedAt: "2026-10-07T05:21:00.000Z",
      sentiment: "POSITIVE",
      category: "PRAISE",
      priority: "LOW",
      syncedAt: "2026-10-07T05:30:00.000Z",
      rawJson: "{}",
      contentHash:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      createdAt: "2026-10-07T05:30:00.000Z",
      updatedAt: "2026-10-07T05:30:00.000Z"
    }
  ],
  replyDrafts: [
    {
      id: "reply-draft-1",
      projectId: "project-1",
      commentId: "comment-1",
      awemeId: work.awemeId,
      cid: "1001",
      sourceContentHash:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      classificationId: "classification-1",
      productTruthHash:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      usedFactIds: ["fact-1"],
      generatedText: "感谢关注，这是一条只保存在 PVS 的 AI 回复草稿。",
      currentText: "感谢关注，这是一条只保存在 PVS 的 AI 回复草稿。",
      strategy: "THANK_AND_ENGAGE",
      status: "DRAFT",
      revision: 1,
      runtimeId: "TEST_REPLY",
      runtimeVersion: "1",
      providerId: "aihubmix",
      modelId: "deepseek-v4.1-flash",
      createdAt: "2026-10-07T05:31:00.000Z",
      updatedAt: "2026-10-07T05:31:00.000Z"
    }
  ],
  creativeFeedback: [],
  latestInsight: {
    id: "insight-1",
    projectId: "project-1",
    bindingId: "binding-1",
    awemeId: work.awemeId,
    productTruthHash:
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    metricSnapshotIds: ["snapshot-1", "snapshot-2"],
    commentIds: ["comment-1"],
    evidenceHash:
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    summary: "播放增长，用户评论主要是正向互动。",
    strengths: [
      {
        text: "播放从 300 增长到 310。",
        evidenceRefs: ["metric:snapshot-1", "metric:snapshot-2"]
      }
    ],
    weaknesses: [
      {
        text: "评论样本仍然很少，不能下强因果结论。",
        evidenceRefs: ["metric:snapshot-2"]
      }
    ],
    audienceQuestions: [
      {
        text: "当前样本主要是正向互动。",
        evidenceRefs: ["comment:comment-1"]
      }
    ],
    nextCreativeActions: [
      {
        text: "下一条继续强化用户已经产生互动的视觉方向。",
        evidenceRefs: ["comment:comment-1", "metric:snapshot-2"]
      }
    ],
    runtimeId: "TEST_RETRO",
    runtimeVersion: "1",
    providerId: "aihubmix",
    modelId: "deepseek-v4.1-flash",
    createdAt: "2026-10-07T05:34:00.000Z"
  },
  candidates: [],
  candidatesStatus: "OFFLINE",
  candidatesMessage: "当前无法读取账号作品。"
};

test("global Douyin ops page is visual, Chinese and exposes only explicit single-reply writes", () => {
  const html = renderDouyinOpsGlobalPage(globalView);
  assert.match(html, /抖音运营/);
  assert.match(html, /账号已匹配/);
  assert.match(html, /50805615998/);
  assert.match(html, /可以的#拳击/);
  assert.match(html, /启动 \/ 打开抖音运营连接/);
  assert.match(html, /查看发布后表现/);
  assert.match(html, /单条人工确认回复/);
  assert.match(html, /不会自动评论、批量回复、点赞或私信/);
  assert.doesNotMatch(html, /campaign run/);
});

test("offline Douyin Bridge displays unknown account status instead of logged out", () => {
  const offlineView: DouyinOpsGlobalView = {
    ...globalView,
    runtime: {
      ok: false,
      ready: false,
      status: "SITE_OFFLINE",
      message: "抖音主页面未连接"
    },
    account: {
      ...globalView.account,
      ops: {
        ...globalView.account.ops,
        available: false,
        nickname: "",
        runtimeStatus: "SITE_OFFLINE"
      }
    }
  };
  const html = renderDouyinOpsGlobalPage(offlineView);
  assert.match(html, /运营账号：<\/b>状态未知（运营连接未就绪）/);
  assert.doesNotMatch(html, /运营账号：<\/b>未登录/);
});

test("project page keeps persisted metrics/comments visible while runtime is offline", () => {
  const html = renderDouyinOpsProjectPage(projectView);
  assert.match(html, /发布后表现/);
  assert.match(html, /运营连接当前不可用；下方已保存的历史指标和评论仍可查看/);
  assert.match(html, />310</);
  assert.match(html, /MJ/);
  assert.match(html, /帅呀/);
  assert.match(html, /刷新数据/);
  assert.match(html, /同步评论/);
  assert.match(html, /AI分类评论/);
  assert.match(html, /情绪：正向/);
  assert.match(html, /类型：好评/);
  assert.match(html, /优先级：低/);
  assert.match(html, /AI 回复草稿（发布前可编辑）/);
  assert.match(html, /感谢关注，这是一条只保存在 PVS 的 AI 回复草稿/);
  assert.match(html, /重新生成AI回复草稿/);
  assert.match(html, /保存草稿/);
  assert.match(html, /拒绝草稿/);
  assert.match(html, /确认并发布这条回复/);
  assert.match(html, /发布按钮只会发送当前这一条评论回复/);
  assert.match(html, /需要运营连接正常、账号强匹配且作品已绑定/);
  assert.match(html, /revision 1/);
  assert.match(html, /发布后 AI 复盘/);
  assert.match(html, /AI复盘/);
  assert.match(html, /播放增长，用户评论主要是正向互动/);
  assert.match(html, /证据：metric:snapshot-1 \/ metric:snapshot-2/);
  assert.match(html, /下一条创意建议/);
  assert.match(html, /加入下一轮创意/);
  assert.match(html, /同步这条评论的回复/);
  assert.match(html, /本阶段仅支持你对单条草稿显式确认后发送，不会自动或批量回复/);
  assert.match(html, /即将向抖音真实发送这 1 条回复/);
  assert.match(html, /平台状态无法确认。系统不会自动重试/);
  assert.doesNotMatch(html, /发送私信|自动点赞|批量发布/);
});

test("Douyin ops inline scripts parse, including manual work-binding controls", () => {
  const candidatesView: DouyinOpsProjectView = {
    ...projectView,
    binding: null,
    candidates: [work],
    candidatesStatus: "READY"
  };
  for (const [name, html] of [
    ["global", renderDouyinOpsGlobalPage(globalView)],
    ["project", renderDouyinOpsProjectPage(candidatesView)]
  ] as const) {
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length > 0, name + " must contain browser handlers");
    scripts.forEach((match, index) => {
      assert.doesNotThrow(() => new vm.Script(match[1]!, {
        filename: name + "-inline-" + index + ".js"
      }), name + " browser JavaScript must parse");
    });
  }
  assert.match(renderDouyinOpsProjectPage(candidatesView), /确认绑定这条作品/);
});

test("work-binding click registers an event and only posts when the user confirms", async () => {
  const html = renderDouyinOpsProjectPage({
    ...projectView, binding: null, candidates: [work], candidatesStatus: "READY"
  });
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)][0]?.[1];
  assert.ok(script);
  let handler: (() => Promise<void>) | undefined;
  let consent = false;
  let reloadCount = 0;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const button = {
    dataset: { aweme: work.awemeId, url: work.externalUrl },
    disabled: false,
    addEventListener(event: string, callback: () => Promise<void>) {
      if (event === "click") handler = callback;
    }
  };
  const message = { textContent: "" };
  vm.runInNewContext(script, {
    document: {
      querySelectorAll: (selector: string) => selector === ".bind-work" ? [button] : [],
      querySelector: (selector: string) => selector === "#bind-message" ? message : null
    },
    confirm: () => consent,
    fetch: async (url: string, options: { method: string; body: string }) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ binding: { status: "BOUND" } }) };
    },
    location: { reload: () => { reloadCount += 1; } },
    encodeURIComponent,
    setTimeout
  });
  assert.ok(handler, "each candidate has a click handler");
  await handler();
  assert.equal(requests.length, 0, "do not bind unless explicitly confirmed");
  assert.equal(reloadCount, 0);
  consent = true;
  await handler();
  assert.deepEqual(requests, [{
    url: "/api/projects/project-1/douyin/binding/confirm",
    method: "POST",
    body: { awemeId: work.awemeId, externalUrl: work.externalUrl, confirmed: true }
  }]);
  assert.equal(reloadCount, 1);
});

test("publisher account check has a bounded UI timeout", async () => {
  const source = await fs.readFile(
    path.resolve(
      "src/adapters/publish/social-auto-upload-runtime.ts"
    ),
    "utf8"
  );
  assert.match(
    source,
    /ACCOUNT_CHECK_TIMEOUT_MS\s*=\s*8_000/
  );
  assert.match(
    source,
    /\["check", "--account", account\],[\s\S]*ACCOUNT_CHECK_TIMEOUT_MS/
  );
});

test("Windows launcher reports success only with an actual Bridge-connected Douyin tab", {
  skip: process.platform !== "win32"
}, async () => {
  let reuseCalls = 0;
  let reloadCalls = 0;
  const launcher = new WindowsDouyinOpsLauncher(
    path.resolve("package.json"),
    async () => { reuseCalls++; return true; },
    async () => true,
    async () => { reloadCalls++; return true; }
  );
  const result = await launcher.launch();
  assert.equal(result.ok, true);
  assert.equal(result.status, "STARTED");
  assert.match(result.message, /已确认.*Bridge 实际连通/);
  assert.equal(reuseCalls, 1);
  assert.equal(reloadCalls, 0);
});

test("Existing browser without Bridge fails closed and does not launch another Chrome", {
  skip: process.platform !== "win32"
}, async () => {
  let refreshCalls = 0;
  const launcher = new WindowsDouyinOpsLauncher(
    path.resolve("package.json"),
    async () => true,
    async () => false,
    async () => { refreshCalls++; return false; },
    async () => false
  );
  const result = await launcher.launch();
  assert.equal(result.ok, false);
  assert.equal(result.status, "FAILED");
  assert.match(result.message, /没有重复启动浏览器/);
  assert.match(result.message, /CDP Bridge/);
  assert.equal(refreshCalls, 0);
});

test("Explicit recovery reloads exactly one existing Douyin tab and requires Bridge readiness", {
  skip: process.platform !== "win32"
}, async () => {
  let checks = 0;
  let reloadCalls = 0;
  let startCalls = 0;
  const launcher = new WindowsDouyinOpsLauncher(
    path.resolve("package.json"),
    async () => true,
    async () => ++checks > 1,
    async () => { reloadCalls++; return true; },
    async () => { startCalls++; return true; }
  );
  const result = await launcher.launch();
  assert.equal(result.ok, true);
  assert.equal(result.status, "STARTED");
  assert.match(result.message, /Bridge 已确认恢复/);
  assert.equal(reloadCalls, 0);
  assert.equal(startCalls, 1);
  assert.equal(checks, 2);
});

test("Windows launcher fails closed when the fixed launcher is missing", async () => {
  const launcher = new WindowsDouyinOpsLauncher(
    path.resolve("definitely-missing-douyin-launcher.cmd")
  );
  const result = await launcher.launch();
  assert.equal(result.ok, false);
  assert.equal(result.status, "UNAVAILABLE");

  const source = await fs.readFile(
    path.resolve(
      "src/adapters/douyin/windows-douyin-ops-launcher.ts"
    ),
    "utf8"
  );
  assert.match(source, /spawn\(/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /exec\(/);
});

test("Douyin ops HTTP exposes only P0 local/read actions", async () => {
  const calls: string[] = [];
  const service = {
    async global() {
      calls.push("global");
      return globalView;
    },
    async project() {
      calls.push("project");
      return projectView;
    },
    async launch() {
      calls.push("launch");
      return {
        ok: true,
        status: "STARTED",
        message: "started"
      };
    },
    async refreshMetrics() {
      calls.push("metrics");
      return projectView.snapshots.at(-1)!;
    },
    async syncComments() {
      calls.push("comments");
      return {
        projectId: "project-1",
        awemeId: work.awemeId,
        pages: 1,
        syncedCount: 1,
        cursor: "0",
        hasMore: false,
        truncated: false
      };
    },
    async syncReplies(_projectId: string, cid: string) {
      calls.push("replies:" + cid);
      return {
        projectId: "project-1",
        awemeId: work.awemeId,
        pages: 1,
        syncedCount: 1,
        cursor: "0",
        hasMore: false,
        truncated: false
      };
    },
    async classifyComments(input: {
      projectId: string;
      cids?: string[];
      force?: boolean;
    }) {
      calls.push(
        "classify:" +
          input.projectId +
          ":" +
          (input.cids?.join(",") ?? "all")
      );
      return {
        projectId: input.projectId,
        requestedCount: 1,
        classifiedCount: 1,
        skippedCount: 0,
        commentIds: ["comment-1"]
      };
    },
    async generateReplyDraft(input: {
      projectId: string;
      cid: string;
    }) {
      calls.push(
        "reply-draft:" +
          input.projectId +
          ":" +
          input.cid
      );
      return projectView.replyDrafts[0]!;
    },
    async editReplyDraft(input: {
      projectId: string;
      draftId: string;
      expectedRevision: number;
      currentText: string;
    }) {
      calls.push(
        "save-draft:" +
          input.draftId +
          ":" +
          input.expectedRevision
      );
      return {
        ...projectView.replyDrafts[0]!,
        currentText: input.currentText,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-10-07T05:32:00.000Z"
      };
    },
    async rejectReplyDraft(input: {
      projectId: string;
      draftId: string;
      expectedRevision: number;
    }) {
      calls.push(
        "reject-draft:" +
          input.draftId +
          ":" +
          input.expectedRevision
      );
      return {
        ...projectView.replyDrafts[0]!,
        status: "REJECTED" as const,
        revision: input.expectedRevision + 1,
        updatedAt: "2026-10-07T05:33:00.000Z"
      };
    },
    async publishReplyDraft(input: {
      projectId: string;
      draftId: string;
      expectedRevision: number;
      writeIntentId: string;
      confirmed: boolean;
    }) {
      calls.push(
        "publish-draft:" +
          input.draftId +
          ":" +
          input.expectedRevision
      );
      return {
        intent: {
          id: input.writeIntentId,
          projectId: input.projectId,
          draftId: input.draftId,
          commentId: "comment-1",
          awemeId: work.awemeId,
          cid: "1001",
          textHash:
            "a".repeat(64),
          operationFingerprint:
            "b".repeat(64),
          draftRevision: input.expectedRevision,
          status: "REPLY_POSTED_CONFIRMED" as const,
          externalReplyCid: "99887766",
          accountPublishId: "50805615998",
          accountOpsId: "50805615998",
          confirmedAt: "2026-10-07T05:33:30.000Z",
          completedAt: "2026-10-07T05:33:31.000Z",
          createdAt: "2026-10-07T05:33:30.000Z",
          updatedAt: "2026-10-07T05:33:31.000Z"
        },
        externalCalled: true,
        draftMarkedPosted: true
      };
    },
    async generateRetrospective(projectId: string) {
      calls.push("retrospective:" + projectId);
      return projectView.latestInsight!;
    },
    async promoteCreativeFeedback(input: {
      projectId: string;
      insightId: string;
      actionIndex: number;
      confirmed: boolean;
    }) {
      calls.push(
        "promote-feedback:" +
          input.insightId +
          ":" +
          input.actionIndex
      );
      return {
        id: "feedback-1",
        projectId: input.projectId,
        insightId: input.insightId,
        actionIndex: input.actionIndex,
        actionHash:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        actionText:
          projectView.latestInsight!.nextCreativeActions[
            input.actionIndex
          ]!.text,
        evidenceRefs:
          projectView.latestInsight!.nextCreativeActions[
            input.actionIndex
          ]!.evidenceRefs,
        active: true,
        confirmedAt:
          "2026-10-07T05:35:00.000Z",
        createdAt:
          "2026-10-07T05:35:00.000Z",
        updatedAt:
          "2026-10-07T05:35:00.000Z"
      };
    },
    async deactivateCreativeFeedback(input: {
      projectId: string;
      feedbackId: string;
      confirmed: boolean;
    }) {
      calls.push(
        "deactivate-feedback:" +
          input.feedbackId
      );
      return {
        id: input.feedbackId,
        projectId: input.projectId,
        insightId: "insight-1",
        actionIndex: 0,
        actionHash:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        actionText:
          "下一条继续强化用户已经产生互动的视觉方向。",
        evidenceRefs: [
          "comment:comment-1",
          "metric:snapshot-2"
        ],
        active: false,
        confirmedAt:
          "2026-10-07T05:35:00.000Z",
        deactivatedAt:
          "2026-10-07T05:36:00.000Z",
        createdAt:
          "2026-10-07T05:35:00.000Z",
        updatedAt:
          "2026-10-07T05:36:00.000Z"
      };
    },
    async confirmBinding() {
      calls.push("binding");
      return binding;
    }
  } as unknown as DouyinOpsDashboardService;

  const server = http.createServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      "http://127.0.0.1"
    );
    const handled = await handleDouyinOpsHttp(
      req,
      res,
      url,
      { douyinOpsDashboard: service }
    );
    if (!handled) {
      res.writeHead(404, {
        "content-type": "application/json"
      });
      res.end(JSON.stringify({ message: "not found" }));
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base =
    "http://127.0.0.1:" + address.port;

  try {
    const globalPageResponse = await fetch(base + "/douyin-ops");
    assert.equal(globalPageResponse.status, 200);
    assert.match(
      await globalPageResponse.text(),
      /我的抖音作品/
    );

    const status = await fetch(
      base + "/api/douyin/ops/status"
    );
    assert.equal(status.status, 200);

    const launch = await fetch(
      base + "/api/douyin/ops/launch",
      { method: "POST" }
    );
    assert.equal(launch.status, 200);

    const projectPageResponse = await fetch(
      base + "/projects/project-1/douyin"
    );
    assert.equal(projectPageResponse.status, 200);

    for (const route of [
      "/api/projects/project-1/douyin/metrics/refresh",
      "/api/projects/project-1/douyin/comments/sync",
      "/api/projects/project-1/douyin/comments/1001/replies/sync"
    ]) {
      const response = await fetch(base + route, {
        method: "POST"
      });
      assert.equal(response.status, 200);
    }

    const classify = await fetch(
      base + "/api/projects/project-1/douyin/comments/classify",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          cids: ["1001"],
          force: false
        })
      }
    );
    assert.equal(classify.status, 200);
    const classifyBody = await classify.json() as {
      result: {
        classifiedCount: number;
      };
    };
    assert.equal(
      classifyBody.result.classifiedCount,
      1
    );

    const replyDraft = await fetch(
      base + "/api/projects/project-1/douyin/comments/1001/reply-draft",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: "{}"
      }
    );
    assert.equal(replyDraft.status, 200);
    const replyDraftBody = await replyDraft.json() as {
      draft: {
        status: string;
        currentText: string;
      };
    };
    assert.equal(replyDraftBody.draft.status, "DRAFT");
    assert.match(
      replyDraftBody.draft.currentText,
      /只保存在 PVS/
    );

    const saveDraft = await fetch(
      base + "/api/projects/project-1/douyin/reply-drafts/reply-draft-1/save",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expectedRevision: 1,
          currentText: "人工编辑后的本地草稿"
        })
      }
    );
    assert.equal(saveDraft.status, 200);
    const saved = await saveDraft.json() as {
      draft: { revision: number; currentText: string };
    };
    assert.equal(saved.draft.revision, 2);
    assert.equal(
      saved.draft.currentText,
      "人工编辑后的本地草稿"
    );

    const rejectDraft = await fetch(
      base + "/api/projects/project-1/douyin/reply-drafts/reply-draft-1/reject",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expectedRevision: 1
        })
      }
    );
    assert.equal(rejectDraft.status, 200);
    const rejected = await rejectDraft.json() as {
      draft: { status: string; revision: number };
    };
    assert.equal(rejected.draft.status, "REJECTED");
    assert.equal(rejected.draft.revision, 2);

    const publishDraft = await fetch(
      base + "/api/projects/project-1/douyin/reply-drafts/reply-draft-1/publish",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expectedRevision: 1,
          writeIntentId:
            "11111111-1111-4111-8111-111111111111",
          confirmed: true
        })
      }
    );
    assert.equal(publishDraft.status, 200);
    const published = await publishDraft.json() as {
      result: {
        intent: { status: string };
        externalCalled: boolean;
      };
    };
    assert.equal(
      published.result.intent.status,
      "REPLY_POSTED_CONFIRMED"
    );
    assert.equal(
      published.result.externalCalled,
      true
    );

    const retrospective = await fetch(
      base + "/api/projects/project-1/douyin/retrospective/generate",
      {
        method: "POST"
      }
    );
    assert.equal(retrospective.status, 200);
    const retrospectiveBody =
      await retrospective.json() as {
        insight: { id: string; summary: string };
      };
    assert.equal(
      retrospectiveBody.insight.id,
      "insight-1"
    );
    assert.match(
      retrospectiveBody.insight.summary,
      /播放增长/
    );

    const promote = await fetch(
      base + "/api/projects/project-1/douyin/creative-feedback/promote",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          insightId: "insight-1",
          actionIndex: 0,
          confirmed: true
        })
      }
    );
    assert.equal(promote.status, 200);

    const deactivate = await fetch(
      base + "/api/projects/project-1/douyin/creative-feedback/feedback-1/deactivate",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          confirmed: true
        })
      }
    );
    assert.equal(deactivate.status, 200);

    const bind = await fetch(
      base + "/api/projects/project-1/douyin/binding/confirm",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          awemeId: work.awemeId,
          externalUrl: work.externalUrl,
          confirmed: true
        })
      }
    );
    assert.equal(bind.status, 200);

    for (const forbidden of [
      "/api/projects/project-1/douyin/post",
      "/api/projects/project-1/douyin/like",
      "/api/projects/project-1/douyin/dm",
      "/api/projects/project-1/douyin/campaign",
      "/api/projects/project-1/douyin/comments/1001/reply"
    ]) {
      const response = await fetch(base + forbidden, {
        method: "POST"
      });
      assert.equal(response.status, 404);
    }

    assert.deepEqual(calls, [
      "global",
      "global",
      "launch",
      "project",
      "metrics",
      "comments",
      "replies:1001",
      "classify:project-1:1001",
      "reply-draft:project-1:1001",
      "save-draft:reply-draft-1:1",
      "reject-draft:reply-draft-1:1",
      "publish-draft:reply-draft-1:1",
      "retrospective:project-1",
      "promote-feedback:insight-1:0",
      "deactivate-feedback:feedback-1",
      "binding"
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error ? reject(error) : resolve()
      )
    );
  }
});

test("main PVS server and workbench navigation register Douyin ops", async () => {
  const serverSource = await fs.readFile(path.resolve("src/web/server.ts"), "utf8");
  assert.match(
    serverSource,
    /handleDouyinOpsHttp\(req, res, url, deps\)/
  );
  assert.match(
    renderPvsGlobalHeader("studio"),
    /href="\/douyin-ops"[^>]*>抖音运营/
  );
});
