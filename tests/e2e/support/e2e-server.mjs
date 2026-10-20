import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const dbName = process.env.PVS_E2E_DB_NAME ?? "e2e.db";
if (!/^[A-Za-z0-9_-]+\.db$/.test(dbName)) throw new Error("Invalid isolated E2E database filename");
const dbPath = path.join(root, "prisma", dbName);
const projectsDir = process.env.PVS_E2E_PROJECT_DIR ?? "e2e-projects";
if (!/^[A-Za-z0-9_-]+$/.test(projectsDir)) throw new Error("Invalid isolated E2E projects folder");
const projectsRoot = path.join(root, ".tmp", projectsDir);
const port = Number(process.env.PVS_E2E_PORT ?? "3190");

await fs.rm(dbPath, { force: true });
// Prisma 6 on this Windows host needs the new SQLite file to exist before migrate deploy.
await fs.writeFile(dbPath, Buffer.alloc(0), { flag: "wx" });
await fs.rm(projectsRoot, { recursive: true, force: true });
await fs.mkdir(projectsRoot, { recursive: true });

const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: "file:./" + dbName,
  PROJECTS_ROOT: projectsRoot,
  PORT: String(port),
  PVS_SMART_WORKER_DISABLED: "1",
  PVS_LOCAL_TTS_DISABLED: "1"
};

const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const migration = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "deploy"],
  {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false
  }
);
if (migration.error) {
  console.error("E2E Prisma migration failed to start:", migration.error);
}
if (migration.status !== 0) {
  process.exit(migration.status ?? 1);
}

Object.assign(process.env, env);

const [{ prisma }, { createAppServer, createDefaultDependencies }] =
  await Promise.all([
    import("../../../dist/src/adapters/db/prisma-client.js"),
    import("../../../dist/src/web/server.js")
  ]);

const now = new Date("2026-10-04T00:00:00.000Z");
await prisma.project.createMany({
  data: [
    {
      id: "e2e-draft",
      name: "E2E Draft Project",
      status: "DRAFT",
      targetPlatform: "douyin",
      targetDurationMs: 30000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "e2e-ready",
      name: "E2E Ready Project",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 30000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "e2e-research",
      name: "E2E Research Project",
      status: "READY_TO_GENERATE",
      targetPlatform: "douyin",
      targetDurationMs: 30000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "e2e-final",
      name: "E2E Final QC Project",
      status: "FINAL_REVIEW",
      targetPlatform: "douyin",
      targetDurationMs: 10000,
      aspectRatio: "9:16",
      createdAt: now,
      updatedAt: now
    }
  ]
});

await prisma.researchRunRecord.create({
  data: {
    id: "e2e-research-run",
    projectId: "e2e-research",
    mode: "DEEP",
    status: "COMPLETED",
    goal: "核实 Test Product 公开资料",
    sourceUrlsJson: "[]",
    queriesJson: JSON.stringify(["Test Product 评测"]),
    browserStateJson: JSON.stringify({
      provider: "public-search",
      lastCheckedAt: "2026-10-04T00:00:00.000Z",
      discoveryRounds: [
        {
          round: 1,
          queries: ["Test Product 评测"],
          candidateCount: 2,
          acceptedCount: 0,
          heldCount: 1,
          rejectedCount: 1,
          fetchedCount: 1,
          candidates: [
            {
              url: "https://www.bilibili.com/",
              title: "哔哩哔哩首页",
              sourceType: "PLATFORM",
              query: "Test Product 评测",
              engine: "bing",
              rank: 1,
              deterministicScore: 0,
              finalScore: 0,
              decision: "REJECT",
              selectedForFetch: false,
              reasons: [
                "首页/聚合入口降权",
                "平台首页且未命中产品身份，直接淘汰"
              ]
            },
            {
              url: "https://example.com/category",
              title: "泛行业文章",
              sourceType: "INDUSTRY",
              deterministicScore: 30,
              finalScore: 30,
              decision: "HOLD",
              selectedForFetch: true,
              reasons: ["产品身份信息较弱"],
              fetchOutcome: "FAILED"
            }
          ]
        },
        {
          round: 2,
          queries: ["Test Product 官方 说明书 PDF"],
          candidateCount: 1,
          acceptedCount: 1,
          heldCount: 0,
          rejectedCount: 0,
          fetchedCount: 1,
          candidates: [
            {
              url: "https://support.example.com/test-product/manual",
              title: "Test Product Official Manual",
              sourceType: "OFFICIAL",
              deterministicScore: 90,
              semanticScore: 96,
              finalScore: 92,
              decision: "ACCEPT",
              selectedForFetch: true,
              reasons: ["搜索标题完整命中产品名", "官方来源加权"],
              fetchedIdentityScore: 75,
              fetchedIdentityMatched: true,
              fetchOutcome: "EVIDENCE"
            }
          ]
        }
      ]
    }),
    createdAt: now,
    updatedAt: now
  }
});

await prisma.researchRunRecord.create({
  data: {
    id: "e2e-research-blocked",
    projectId: "e2e-ready",
    mode: "DEEP",
    status: "BLOCKED",
    goal: "登录后继续深度研究",
    sourceUrlsJson: "[]",
    queriesJson: JSON.stringify(["E2E Product 抖音 高点赞"]),
    browserStateJson: JSON.stringify({
      provider: "external-browser",
      resumeToken: "e2e-resume",
      lastCheckedAt: "2026-10-04T00:05:00.000Z",
      marketVideoResearch: {
        status: "BLOCKED",
        provider: "douyin-cli-search",
        sort: "MOST_LIKED",
        timeRange: "ANY",
        searchedQueries: ["草本护颈枕"],
        checkedAt: "2026-10-04T00:05:00.000Z",
        candidates: [],
        blockerCode: "RISK_CONTROL",
        message: "抖音搜索触发验证码或平台风控，本轮已停止。",
        requiredUserAction:
          "在正常浏览器会话中完成人工验证后再重试；系统不会绕过验证码或风控。"
      }
    }),
    blockerCode: "LOGIN_REQUIRED",
    blockerMessage: "需要登录平台后继续研究",
    requiredUserAction: "完成登录后点击继续深度研究",
    createdAt: new Date("2026-10-04T00:05:00.000Z"),
    updatedAt: new Date("2026-10-04T00:05:00.000Z")
  }
});


const e2eFinalRoot = path.join(projectsRoot, "e2e-final");
const e2eFinalRelative = "final/final.mp4";
const e2eFinalFile = path.join(e2eFinalRoot, e2eFinalRelative);
await fs.mkdir(path.dirname(e2eFinalFile), { recursive: true });
const e2eFfmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const e2eVideo = spawnSync(
  e2eFfmpeg,
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=720x1280:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-y",
    e2eFinalFile
  ],
  {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000
  }
);
if (e2eVideo.status !== 0) {
  console.error("E2E final-video fixture failed:", e2eVideo.stderr);
  process.exit(e2eVideo.status ?? 1);
}
const e2eFinalBytes = await fs.readFile(e2eFinalFile);
const e2eFinalHash = createHash("sha256").update(e2eFinalBytes).digest("hex");
const e2ePlanHash = "a".repeat(64);
const e2eTimelineHash = "c".repeat(64);
const e2eSourceHash = "b".repeat(64);
const e2eTimeline = {
  id: "e2e-final-timeline",
  projectId: "e2e-final",
  version: 1,
  status: "CONFIRMED",
  productionPlanHash: e2ePlanHash,
  tracks: [
    {
      id: "e2e-final-video-track",
      kind: "VIDEO",
      order: 0,
      label: "主视频",
      locked: false,
      muted: false
    }
  ],
  clips: [
    {
      id: "e2e-final-edit",
      sourceClipId: "e2e-final-source-clip",
      sourceArtifactId: "e2e-final-source-artifact",
      sourceArtifactHash: e2eSourceHash,
      sourceDurationMs: 3000,
      inMs: 0,
      outMs: 3000,
      trackId: "e2e-final-video-track",
      order: 0,
      deleted: false,
      transition: { type: "CUT", durationMs: 0 },
      audio: { muted: false, volume: 1, keyframes: [] },
      captions: []
    }
  ],
  audioItems: [],
  textItems: [],
  repairMasks: [],
  renderConfig: {
    width: 720,
    height: 1280,
    fps: 30,
    videoCodec: "libx264",
    audioCodec: "aac",
    format: "mp4"
  },
  contentHash: e2eTimelineHash,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  confirmedAt: now.toISOString()
};


const e2eContinuityState = {
  description: "E2E continuity",
  productState: "product stable",
  environmentState: "studio stable",
  stateHash: "d".repeat(64)
};
const e2eProductionPlan = {
  id: "e2e-final-plan",
  projectId: "e2e-final",
  version: 1,
  status: "CONFIRMED",
  productTruthRef: {
    entityType: "ProductTruth",
    entityId: "e2e-final-truth-ref",
    version: 1,
    hash: "f".repeat(64)
  },
  scriptRef: {
    entityType: "ScriptDraft",
    entityId: "e2e-final-script-ref",
    version: 1,
    hash: "1".repeat(64)
  },
  selectedCreativeId: "e2e-final-creative",
  visualDirection: "E2E clean product showcase",
  soundDirection: "E2E clean audio",
  productShowcaseRules: ["Keep the product stable"],
  continuityLock: {
    product: {
      stableAttributes: ["product shape"],
      forbiddenChanges: []
    },
    characters: [],
    environments: [
      {
        sceneId: "e2e-final-scene",
        stableElements: ["studio background"]
      }
    ]
  },
  scenes: [
    {
      id: "e2e-final-scene",
      order: 0,
      purpose: "E2E final QC",
      location: "studio",
      visualState: "clean",
      sourceBeatIds: [],
      requiredFactIds: [],
      clips: [
        {
          id: "e2e-final-plan-clip",
          sceneId: "e2e-final-scene",
          order: 0,
          durationMs: 4000,
          purpose: "product showcase",
          openingState: e2eContinuityState,
          closingState: e2eContinuityState,
          referenceAssets: [],
          productVisibility: "HERO",
          strictProductIdentity: false,
          strictProductIdentityScope: [],
          riskAssessment: {
            level: "LOW",
            reasonCodes: ["E2E_FIXTURE"],
            mitigations: ["E2E_FIXTURE"],
            source: "PRODUCT_DIRECTOR"
          },
          sourceBeatIds: [],
          requiredFactIds: [],
          segments: [
            {
              id: "e2e-final-segment",
              order: 0,
              startMs: 0,
              endMs: 4000,
              shotSize: "medium",
              cameraPosition: "front",
              cameraAngle: "eye-level",
              cameraMovement: "static",
              composition: "centered",
              subjectAction: "product showcase",
              productState: "stable",
              dialogueOrNarration: { kind: "NONE" },
              ambientSound: { kind: "NONE" },
              postProductionText: [],
              lighting: "even",
              continuityIn: e2eContinuityState,
              continuityOut: e2eContinuityState,
              sourceBeatIds: [],
              requiredFactIds: []
            }
          ],
          aggregateStatus: "ACCEPTED",
          contentHash: "e".repeat(64)
        }
      ]
    }
  ],
  contentHash: e2ePlanHash,
  confirmedAt: now.toISOString()
};

await prisma.versionedEntity.create({
  data: {
    id: e2eProductionPlan.id,
    projectId: "e2e-final",
    entityType: "ProductionPlan",
    entityKey: "current",
    version: 1,
    status: "CONFIRMED",
    contentHash: e2ePlanHash,
    dataJson: JSON.stringify(e2eProductionPlan),
    createdAt: now,
    updatedAt: now
  }
});
await prisma.project.update({
  where: { id: "e2e-final" },
  data: {
    currentProductionPlanId: e2eProductionPlan.id,
    currentProductionPlanVersion: 1,
    currentProductionPlanHash: e2ePlanHash
  }
});

await prisma.artifactRecord.create({
  data: {
    id: "e2e-final-artifact",
    projectId: "e2e-final",
    kind: "FINAL_VIDEO",
    relativePath: e2eFinalRelative,
    sha256: e2eFinalHash,
    sizeBytes: e2eFinalBytes.byteLength,
    mimeType: "video/mp4",
    integrityStatus: "READY",
    immutable: true,
    createdAt: now
  }
});

await prisma.timelineRecord.create({
  data: {
    id: e2eTimeline.id,
    projectId: "e2e-final",
    version: 1,
    status: "CONFIRMED",
    productionPlanHash: e2ePlanHash,
    contentHash: e2eTimelineHash,
    dataJson: JSON.stringify(e2eTimeline),
    createdAt: now,
    updatedAt: now,
    confirmedAt: now
  }
});

await prisma.finalAssemblyRecord.create({
  data: {
    id: "e2e-final-assembly",
    projectId: "e2e-final",
    productionPlanHash: e2ePlanHash,
    selectedClipIdsJson: JSON.stringify(["e2e-final-source-clip"]),
    inputArtifactIdsJson: JSON.stringify(["e2e-final-source-artifact"]),
    inputArtifactHashesJson: JSON.stringify([e2eSourceHash]),
    outputArtifactId: "e2e-final-artifact",
    outputArtifactHash: e2eFinalHash,
    timelineId: e2eTimeline.id,
    timelineHash: e2eTimelineHash,
    renderConfigJson: JSON.stringify(e2eTimeline.renderConfig),
    status: "READY",
    createdAt: now
  }
});

// W2/W3 workflow browser fixtures live ONLY in isolated e2e.db / e2e-projects.
const { smartRunSchema } = await import("../../../dist/src/domain/smart-generation.js");
const e2eTruthRun = smartRunSchema.parse({
  id: "e2e-workflow-truth-run",
  projectId: "e2e-ready",
  workflowVersion: 2,
  requestKey: "e2e-workflow-truth",
  inputHash: e2eFinalHash,
  revision: 1,
  status: "WAITING_FOR_TRUTH_REVIEW",
  stage: "SOURCES",
  targetDurationMs: 30000,
  options: {
    requestText: "本地测试：产品资料审核后继续本轮任务",
    generationSettings: {
      requestedModelVersion: "seedance2.0mini",
      aspectRatio: "9:16", videoResolution: "720p",
      nativeAudioOutputRequested: false
    },
    reviewMode: "MANUAL"
  },
  expectedWorkspace: {},
  attemptIds: [],
  notes: [],
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
});
await prisma.smartGenerationRunRecord.create({
  data: {
    id: e2eTruthRun.id, projectId: e2eTruthRun.projectId,
    requestKey: e2eTruthRun.requestKey,
    activeProjectKey: e2eTruthRun.projectId,
    status: e2eTruthRun.status,
    revision: e2eTruthRun.revision,
    inputHash: e2eTruthRun.inputHash,
    dataJson: JSON.stringify(e2eTruthRun),
    createdAt: e2eTruthRun.createdAt,
    updatedAt: e2eTruthRun.updatedAt
  }
});

await prisma.project.create({
  data: {
    id: "e2e-published", name: "E2E Trusted Published",
    status: "PUBLISHED", targetPlatform: "douyin",
    targetDurationMs: 10000, aspectRatio: "9:16",
    createdAt: now, updatedAt: now
  }
});
const trustedPlan={...e2eProductionPlan,id:"e2e-published-plan",projectId:"e2e-published"};
await prisma.versionedEntity.create({
  data: {
    id:trustedPlan.id,projectId:"e2e-published",entityType:"ProductionPlan",
    entityKey:"current",version:1,status:"CONFIRMED",contentHash:e2ePlanHash,
    dataJson:JSON.stringify(trustedPlan),createdAt:now,updatedAt:now
  }
});
await prisma.project.update({
  where:{id:"e2e-published"},
  data:{currentProductionPlanId:trustedPlan.id,currentProductionPlanVersion:1,currentProductionPlanHash:e2ePlanHash}
});
const trustedTimeline={...e2eTimeline,id:"e2e-published-timeline",projectId:"e2e-published"};
await prisma.timelineRecord.create({
  data: {
    id:trustedTimeline.id,projectId:trustedTimeline.projectId,version:1,status:"CONFIRMED",
    productionPlanHash:e2ePlanHash,contentHash:e2eTimelineHash,
    dataJson:JSON.stringify(trustedTimeline),createdAt:now,updatedAt:now,confirmedAt:now
  }
});
const publishedRelativePath = "final/final.mp4";
const publishedRoot = path.join(projectsRoot, "e2e-published");
await fs.mkdir(path.dirname(path.join(publishedRoot, publishedRelativePath)), {recursive:true});
await fs.copyFile(e2eFinalFile, path.join(publishedRoot, publishedRelativePath));
await prisma.artifactRecord.create({
  data: {
    id:"e2e-published-artifact", projectId:"e2e-published",
    kind:"FINAL_VIDEO", relativePath:publishedRelativePath,
    sha256:e2eFinalHash, sizeBytes:e2eFinalBytes.byteLength,
    mimeType:"video/mp4", integrityStatus:"READY",immutable:true,createdAt:now
  }
});
await prisma.finalAssemblyRecord.create({
  data: {
    id:"e2e-published-assembly",projectId:"e2e-published",
    productionPlanHash:e2ePlanHash, selectedClipIdsJson:"[]",
    inputArtifactIdsJson:"[]",inputArtifactHashesJson:"[]",
    outputArtifactId:"e2e-published-artifact",outputArtifactHash:e2eFinalHash,
    status:"ACCEPTED",acceptedAt:now,createdAt:now
  }
});
await prisma.publishPackageRecord.create({
  data: {
    id:"e2e-trusted-douyin-package",projectId:"e2e-published",
    finalAssemblyId:"e2e-published-assembly",
    finalArtifactId:"e2e-published-artifact",
    finalArtifactHash:e2eFinalHash,
    providerType:"DOUYIN_BROWSER_AUTOMATION",
    titleDraft:"E2E Trusted Publish",
    expiresAt:new Date("2027-01-01T00:00:00.000Z"),
    singleUseTokenHash:"1".repeat(64),
    status:"PUBLISHED_CONFIRMED",publishedConfirmedAt:now,createdAt:now
  }
});
await prisma.publishReceiptRecord.create({
  data: {
    id:"e2e-trusted-douyin-receipt",projectId:"e2e-published",
    packageId:"e2e-trusted-douyin-package",
    providerType:"DOUYIN_BROWSER_AUTOMATION",
    kind:"PUBLISHED_CONFIRMED",trusted:true,createdAt:now
  }
});

const deps = createDefaultDependencies();
const realResearchStartRun = deps.research.startRun.bind(deps.research);
deps.research.startRun = async (input) => {
  if (input.goal === "__E2E_RESEARCH_MUTEX__") {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const stamp = new Date().toISOString();
    return {
      run: {
        id: "e2e-research-mutex-run",
        projectId: input.projectId,
        mode: input.mode,
        status: "COMPLETED",
        goal: input.goal,
        sourceUrls: input.sourceUrls,
        queries: input.queries,
        createdAt: stamp,
        updatedAt: stamp
      },
      evidence: []
    };
  }
  return realResearchStartRun(input);
};
const blockedExternalCall = async () => {
  throw new Error("E2E_EXTERNAL_CALL_BLOCKED");
};
deps.provider.probe = async () => ({
  code: "DREAMINA_NOT_FOUND",
  cliFound: false,
  providerIdentityHash: "1".repeat(64),
  capabilityFingerprint: "2".repeat(64),
  rawStdout: "",
  rawStderr: "E2E provider intentionally disabled"
});
deps.provider.accountStatus = async () => ({ status: "NOT_AUTHENTICATED" });
deps.provider.estimate = async () => ({ status: "UNKNOWN" });
deps.provider.submit = blockedExternalCall;
deps.provider.status = blockedExternalCall;
deps.provider.download = blockedExternalCall;
deps.provider.reconcileSubmission = blockedExternalCall;
deps.douyinResearchAuth = {
  launch: async () => ({
    started: true,
    alreadyRunning: false,
    executable: "e2e-dy.exe"
  }),
  syncCookies: async () => ({
    cookieCount: 73,
    hasSession: true
  })
};
deps.douyinMarketVideoSearch = {
  id: "e2e-douyin-search",
  search: async () => ({
    status: "READY",
    provider: "e2e-douyin-search",
    candidates: [],
    searchedQueries: ["fixture"],
    checkedAt: new Date().toISOString()
  })
};
const server = createAppServer(deps);
server.listen(port, "127.0.0.1", () => {
  console.log("PVS E2E listening on http://127.0.0.1:" + port);
});

async function stop() {
  await new Promise((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
