import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BrowserResearchProvider,
  BrowserResearchResult,
  WebResearchDocument,
  WebResearchProvider,
  WebResearchSource
} from "../src/application/ports/research-provider.js";
import type {
  MarketVideoMediaFetcher,
  MarketVideoSearchProvider,
  MarketVideoSearchResult
} from "../src/application/ports/market-video-provider.js";
import type {
  ArtifactRepository,
  PendingArtifactInput
} from "../src/application/ports/artifact-repository.js";
import type {
  ResearchBrief,
  ResearchCandidateClaim,
  ResearchEvidence,
  ResearchRepository,
  ResearchRun,
  ResearchUsageRule
} from "../src/application/ports/research-repository.js";
import type {
  StructuredAiRequest,
  StructuredAiRuntime
} from "../src/application/ports/structured-ai-runtime.js";
import type { ProductFlowService } from "../src/application/services/product-flow.js";
import { ResearchService } from "../src/application/services/research-service.js";
import { HttpWebResearchProvider } from "../src/adapters/research/http-web-research-provider.js";
import {
  douyinEnvelopeRequiresVerification,
  marketVideoCandidateWithinTimeRange
} from "../src/adapters/research/douyin-cli-market-video-provider.js";
import { confirmProductTruthDraft } from "../src/application/services/review-actions.js";
import { makeProductTruth } from "./fixtures.js";
import type {
  ArtifactRecord,
  ProductTruth,
  Project,
  ReferenceVideoProfile
} from "../src/domain/schemas.js";
import { hashValue } from "../src/domain/hashing.js";

class MemoryResearchRepository implements ResearchRepository {
  readonly runs = new Map<string, ResearchRun>();
  readonly evidence = new Map<string, ResearchEvidence>();
  readonly briefs = new Map<string, ResearchBrief>();

  async createRun(run: ResearchRun): Promise<ResearchRun> {
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async updateRun(
    id: string,
    update: Partial<
      Pick<
        ResearchRun,
        | "status"
        | "browserState"
        | "blockerCode"
        | "blockerMessage"
        | "requiredUserAction"
      >
    >
  ): Promise<ResearchRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error("missing run");
    const next = {
      ...current,
      ...structuredClone(update),
      updatedAt: new Date().toISOString()
    } as ResearchRun;
    this.runs.set(id, next);
    return structuredClone(next);
  }

  async findRun(id: string): Promise<ResearchRun | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async listRuns(projectId: string): Promise<ResearchRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => structuredClone(run));
  }

  async createEvidence(
    evidence: ResearchEvidence
  ): Promise<ResearchEvidence> {
    this.evidence.set(evidence.id, structuredClone(evidence));
    return structuredClone(evidence);
  }

  async updateEvidenceRelatedClaims(
    id: string,
    relatedClaims: string[]
  ): Promise<ResearchEvidence> {
    const current = this.evidence.get(id);
    if (!current) throw new Error("missing evidence");
    const next = {
      ...current,
      relatedClaims: structuredClone(relatedClaims)
    };
    this.evidence.set(id, next);
    return structuredClone(next);
  }

  async listEvidence(runId: string): Promise<ResearchEvidence[]> {
    return [...this.evidence.values()]
      .filter((item) => item.runId === runId)
      .map((item) => structuredClone(item));
  }

  async createBrief(brief: ResearchBrief): Promise<ResearchBrief> {
    for (const current of this.briefs.values()) {
      if (
        current.projectId === brief.projectId &&
        current.status === "READY"
      ) {
        current.status = "STALE";
      }
    }
    this.briefs.set(brief.id, structuredClone(brief));
    return structuredClone(brief);
  }

  async updateBriefClaims(
    id: string,
    claims: ResearchCandidateClaim[]
  ): Promise<ResearchBrief> {
    const current = this.briefs.get(id);
    if (!current) throw new Error("missing brief");
    const next = {
      ...current,
      candidateClaims: structuredClone(claims)
    };
    this.briefs.set(id, next);
    return structuredClone(next);
  }

  async updateBriefUsageRules(
    id: string,
    usageRules: ResearchUsageRule[]
  ): Promise<ResearchBrief> {
    const current = this.briefs.get(id);
    if (!current) throw new Error("missing brief");
    const next = {
      ...current,
      usageRules: structuredClone(usageRules)
    };
    this.briefs.set(id, next);
    return structuredClone(next);
  }

  async findBrief(id: string): Promise<ResearchBrief | null> {
    const brief = this.briefs.get(id);
    return brief ? structuredClone(brief) : null;
  }

  async latestBrief(
    projectId: string
  ): Promise<ResearchBrief | null> {
    return (
      [...this.briefs.values()]
        .filter(
          (item) =>
            item.projectId === projectId && item.status === "READY"
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      null
    );
  }

  async findBriefByRun(
    runId: string
  ): Promise<ResearchBrief | null> {
    return (
      [...this.briefs.values()]
        .filter((item) => item.runId === runId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
      null
    );
  }

  async listBriefs(projectId: string): Promise<ResearchBrief[]> {
    return [...this.briefs.values()]
      .filter((item) => item.projectId === projectId)
      .map((item) => structuredClone(item));
  }
}

class MemoryArtifactRepository implements ArtifactRepository {
  readonly rows = new Map<string, ArtifactRecord>();

  async createPending(input: PendingArtifactInput): Promise<ArtifactRecord> {
    const row: ArtifactRecord = {
      ...input,
      integrityStatus: "PENDING",
      immutable: true,
      createdAt: new Date().toISOString()
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async markReady(
    id: string,
    fields: { sha256: string; sizeBytes: number; mimeType?: string }
  ): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...row,
      ...fields,
      integrityStatus: "READY"
    };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async markMissing(id: string): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...row,
      integrityStatus: "MISSING"
    };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async markCorrupt(id: string): Promise<ArtifactRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error("missing artifact");
    const next: ArtifactRecord = {
      ...row,
      integrityStatus: "CORRUPT"
    };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async listByProject(
    projectId: string,
    kind?: ArtifactRecord["kind"]
  ): Promise<ArtifactRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.projectId === projectId && (!kind || row.kind === kind)
      )
      .map((row) => structuredClone(row));
  }

  async listPending(): Promise<ArtifactRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.integrityStatus === "PENDING")
      .map((row) => structuredClone(row));
  }
}

class MemoryWebResearchProvider implements WebResearchProvider {
  readonly seen: WebResearchSource[] = [];
  constructor(
    private readonly documents: Record<string, string> = {}
  ) {}

  async fetchSource(
    source: WebResearchSource
  ): Promise<WebResearchDocument> {
    this.seen.push(structuredClone(source));
    const text =
      this.documents[source.url] ??
      "Official product page states the device supports 4K input and USB-C connectivity.";
    return {
      sourceUrl: source.url,
      finalUrl: source.url,
      title: "Source " + source.url,
      fetchedAt: "2026-09-29T01:00:00.000Z",
      sourceType: source.sourceType,
      text,
      excerpt: text,
      contentHash: hashValue(text)
    };
  }
}

class EvidenceBoundRuntime implements StructuredAiRuntime {
  readonly id = "research-runtime";
  readonly version = "1";
  readonly requests: StructuredAiRequest[] = [];

  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    this.requests.push(request);
    return this.result(request);
  }

  async generateJsonWithMetadata(request: StructuredAiRequest) {
    this.requests.push(request);
    return {
      data: this.result(request),
      metadata: {
        executionId: "research-execution",
        providerId: "research-provider",
        modelId: "research-model",
        configVersion: 4
      }
    };
  }

  private result(request: StructuredAiRequest) {
    const evidence = (
      request.input as {
        evidence: Array<{ id: string }>;
      }
    ).evidence;
    const first = evidence[0]!.id;
    return {
      summary: "公开来源支持一个可审核的研究摘要。",
      findings: [
        {
          statement: "公开页面提到支持 4K input。",
          evidenceIds: [first],
          confidence: "HIGH"
        }
      ],
      candidateClaims: [
        {
          statement: "产品支持 4K input。",
          evidenceIds: [first],
          confidence: "HIGH"
        }
      ],
      contentOpportunities: ["用 4K input 作为演示主题"],
      uncertainties: ["仍需用户确认该公开页面对应当前具体 SKU"]
    };
  }
}

class RerankAwareRuntime implements StructuredAiRuntime {
  readonly id = "rerank-runtime";
  readonly version = "1";

  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    if (request.task.startsWith("Rank public-search candidates")) {
      const candidates = (
        request.input as {
          candidates: Array<{ candidateId: string; url: string }>;
        }
      ).candidates;
      return {
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          relevanceScore: 100,
          reason: "fixture semantic relevance"
        }))
      };
    }
    const evidence = (
      request.input as { evidence: Array<{ id: string }> }
    ).evidence;
    return {
      summary: "语义重排后的来源可用于研究。",
      findings: evidence.length
        ? [
            {
              statement: "相关来源已通过质量门禁。",
              evidenceIds: [evidence[0]!.id],
              confidence: "MEDIUM"
            }
          ]
        : [],
      candidateClaims: [],
      usageRules: [],
      contentOpportunities: [],
      uncertainties: []
    };
  }
}

class UnsourcedRuntime implements StructuredAiRuntime {
  readonly id = "unsourced";
  readonly version = "1";
  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    const evidence = (
      request.input as { evidence: Array<{ id: string }> }
    ).evidence;
    return {
      summary: "bad",
      findings: [
        {
          statement: "bad finding",
          evidenceIds: [evidence[0]!.id],
          confidence: "LOW"
        }
      ],
      candidateClaims: [
        {
          statement: "unsupported candidate",
          evidenceIds: ["evidence-does-not-exist"],
          confidence: "HIGH"
        }
      ],
      contentOpportunities: [],
      uncertainties: []
    };
  }
}

class StaticBrowserProvider implements BrowserResearchProvider {
  readonly id = "browser-test";
  calls = 0;
  readonly inputs: Array<{
    projectId: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }> = [];
  constructor(
    private readonly first: BrowserResearchResult,
    private readonly second?: BrowserResearchResult
  ) {}
  async discover(input: {
    projectId: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }): Promise<BrowserResearchResult> {
    this.calls += 1;
    this.inputs.push(structuredClone(input));
    return structuredClone(
      this.calls === 1 || !this.second ? this.first : this.second
    );
  }
}

class StaticMarketVideoSearchProvider implements MarketVideoSearchProvider {
  readonly id = "market-video-test";
  readonly inputs: Array<Parameters<MarketVideoSearchProvider["search"]>[0]> = [];
  constructor(private readonly result: MarketVideoSearchResult) {}
  async search(
    input: Parameters<MarketVideoSearchProvider["search"]>[0]
  ): Promise<MarketVideoSearchResult> {
    this.inputs.push(structuredClone(input));
    return structuredClone(this.result);
  }
}

class NeverMarketVideoMediaFetcher implements MarketVideoMediaFetcher {
  readonly id = "market-video-fetch-never";
  async fetch(
    _input: Parameters<MarketVideoMediaFetcher["fetch"]>[0]
  ): ReturnType<MarketVideoMediaFetcher["fetch"]> {
    throw new Error("market video fetch should not run in this test");
  }
}

class StaticMarketVideoMediaFetcher implements MarketVideoMediaFetcher {
  readonly id = "market-video-fetch-test";
  readonly inputs: Array<Parameters<MarketVideoMediaFetcher["fetch"]>[0]> = [];
  async fetch(
    input: Parameters<MarketVideoMediaFetcher["fetch"]>[0]
  ): ReturnType<MarketVideoMediaFetcher["fetch"]> {
    this.inputs.push(structuredClone(input));
    return {
      sourceUrl: input.candidate.url,
      originalFilename: "douyin-" + input.candidate.videoId + ".mp4",
      mimeType: "video/mp4",
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
    };
  }
}

class UsageRuleRuntime implements StructuredAiRuntime {
  readonly id = "usage-rule-runtime";
  readonly version = "1";
  async generateJson(request: StructuredAiRequest): Promise<unknown> {
    const evidence = (
      request.input as { evidence: Array<{ id: string }> }
    ).evidence;
    const first = evidence[0]!.id;
    return {
      summary: "官方资料给出了明确的佩戴与使用限制。",
      findings: [],
      candidateClaims: [],
      usageRules: [
        {
          category: "WEARING_POSITION",
          polarity: "MUST",
          statement: "耳夹应佩戴在耳廓指定夹持位置，不应塞入耳道。",
          evidenceIds: [first],
          confidence: "HIGH"
        }
      ],
      contentOpportunities: [],
      uncertainties: []
    };
  }
}

function makeProductFlow(
  projectId: string,
  options: {
    projectName?: string;
    truthPatch?: Partial<ProductTruth>;
  } = {}
) {
  const project: Project = {
    id: projectId,
    name: options.projectName ?? "Research Project",
    status: "PRODUCT_TRUTH_REVIEW",
    targetPlatform: "douyin",
    targetDurationMs: 30000,
    aspectRatio: "9:16",
    createdAt: "2026-09-29T01:00:00.000Z",
    updatedAt: "2026-09-29T01:00:00.000Z"
  };
  const initial = makeProductTruth();
  const truth: ProductTruth = {
    ...initial,
    ...options.truthPatch,
    projectId,
    uncertainClaims: options.truthPatch?.uncertainClaims ?? []
  };
  let currentTruth = structuredClone(truth);
  let savedDraft: ProductTruth | undefined;
  return {
    flow: {
      async getProject(id: string) {
        return id === projectId ? structuredClone(project) : null;
      },
      async getWorkspace(id: string) {
        if (id !== projectId) return null;
        return {
          project: structuredClone(project),
          productTruth: structuredClone(currentTruth)
        };
      },
      async nextVersion() {
        return currentTruth.version + 1;
      },
      async saveProductTruthDraft(draft: ProductTruth) {
        savedDraft = structuredClone(draft);
        currentTruth = structuredClone(draft);
        return structuredClone(project);
      }
    } as unknown as ProductFlowService,
    getSavedDraft: () =>
      savedDraft ? structuredClone(savedDraft) : undefined
  };
}

test("HttpWebResearchProvider extracts text/title/hash from an explicitly allowed local HTML source", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<html><head><title>Official Product</title><style>bad</style></head><body><h1>Feature</h1><p>Supports USB-C and 4K input for public product documentation.</p><script>bad()</script></body></html>"
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const url = `http://127.0.0.1:${address.port}/product`;
    const provider = new HttpWebResearchProvider({
      allowPrivateNetwork: true,
      timeoutMs: 5000
    });
    const doc = await provider.fetchSource({
      url,
      sourceType: "OFFICIAL"
    });
    assert.equal(doc.title, "Official Product");
    assert.match(doc.text, /Supports USB-C and 4K input/);
    assert.doesNotMatch(doc.text, /bad\(\)/);
    assert.equal(doc.contentHash.length, 64);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("HttpWebResearchProvider blocks loopback/private addresses by default", async () => {
  const provider = new HttpWebResearchProvider();
  await assert.rejects(
    provider.fetchSource({
      url: "http://127.0.0.1:9876/private",
      sourceType: "USER_URL"
    }),
    /私有网络/
  );
});

test("Douyin market-video time filter is enforced locally even when upstream returns old videos", () => {
  const now = Date.parse("2026-10-05T00:00:00.000Z");
  const base = {
    id: "7900000000000000007",
    platform: "DOUYIN" as const,
    videoId: "7900000000000000007",
    url: "https://www.douyin.com/video/7900000000000000007",
    title: "fixture",
    query: "护颈枕",
    rank: 1,
    metrics: { likes: 100 },
    metricsAvailability: "PLATFORM_PUBLIC" as const,
    sourceProvider: "fixture",
    status: "DISCOVERED" as const
  };
  assert.equal(
    marketVideoCandidateWithinTimeRange(
      { ...base, publishedAt: "2026-07-16T00:00:00.000Z" },
      "HALF_YEAR",
      now
    ),
    true
  );
  assert.equal(
    marketVideoCandidateWithinTimeRange(
      { ...base, publishedAt: "2025-10-26T00:00:00.000Z" },
      "HALF_YEAR",
      now
    ),
    false
  );
  assert.equal(
    marketVideoCandidateWithinTimeRange(
      { ...base, publishedAt: "2023-07-30T00:00:00.000Z" },
      "ANY",
      now
    ),
    true
  );
  assert.equal(
    marketVideoCandidateWithinTimeRange(base, "WEEK", now),
    false
  );
});

test("Douyin successful JSON with verify_check is treated as verification/risk control", () => {
  assert.equal(
    douyinEnvelopeRequiresVerification({
      ok: true,
      data: {
        status_code: 0,
        data: [],
        search_nil_info: {
          search_nil_type: "verify_check",
          search_nil_item: "verify_check",
          text_type: 9
        }
      }
    }),
    true
  );
  assert.equal(
    douyinEnvelopeRequiresVerification(
      { ok: true, data: { status_code: 0, data: [] } },
      "verify_check detected (count=1)"
    ),
    true
  );
  assert.equal(
    douyinEnvelopeRequiresVerification({
      ok: true,
      data: { status_code: 0, data: [] }
    }),
    false
  );
});

test("basic Research persists Evidence, produces a sourced ResearchBrief, and records actual AI model metadata", async () => {
  const projectId = "research-basic";
  const repo = new MemoryResearchRepository();
  const web = new MemoryWebResearchProvider();
  const runtime = new EvidenceBoundRuntime();
  const { flow } = makeProductFlow(projectId);
  const browser = new StaticBrowserProvider({
    status: "BLOCKED",
    blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
    message: "not configured",
    requiredUserAction: "connect browser"
  });
  const service = new ResearchService(
    repo,
    web,
    browser,
    runtime,
    flow
  );
  const result = await service.startRun({
    projectId,
    mode: "BASIC",
    goal: "核实产品公开信息",
    sourceUrls: [
      {
        url: "https://example.com/product",
        sourceType: "OFFICIAL"
      }
    ],
    queries: []
  });

  assert.equal(result.run.status, "COMPLETED");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.sourceType, "OFFICIAL");
  assert.equal(result.evidence[0]?.confidence, "HIGH");
  assert.equal(result.evidence[0]?.contentHash.length, 64);
  assert.equal(result.brief?.candidateClaims.length, 1);
  assert.equal(
    result.brief?.candidateClaims[0]?.evidenceIds[0],
    result.evidence[0]?.id
  );
  assert.deepEqual(result.brief?.aiExecution, {
    executionId: "research-execution",
    providerId: "research-provider",
    modelId: "research-model",
    configVersion: 4
  });
  assert.equal(browser.calls, 0);
  assert.equal(
    repo.evidence.get(result.evidence[0]!.id)?.relatedClaims.length,
    2
  );
});

test("ResearchBrief generation fails closed when AI cites a nonexistent Evidence id", async () => {
  const projectId = "research-unsourced";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    new StaticBrowserProvider({
      status: "BLOCKED",
      blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
      message: "not configured",
      requiredUserAction: "connect browser"
    }),
    new UnsourcedRuntime(),
    flow
  );

  await assert.rejects(
    service.startRun({
      projectId,
      mode: "BASIC",
      goal: "research",
      sourceUrls: [
        {
          url: "https://example.com/product",
          sourceType: "OFFICIAL"
        }
      ],
      queries: []
    }),
    /不存在的 Evidence/
  );
  assert.equal(repo.briefs.size, 0);
});

test("deep Research preserves Douyin market-video candidates when current-product evidence is zero", async () => {
  const projectId = "research-market-video";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId, {
    truthPatch: {
      productName: "康瑶堂护颈枕",
      brand: "康瑶堂",
      category: "瑶药护颈枕"
    }
  });
  const browser = new StaticBrowserProvider({
    status: "READY",
    sources: [],
    browserState: { provider: "browser-test" }
  });
  const market = new StaticMarketVideoSearchProvider({
    status: "READY",
    provider: "market-video-test",
    searchedQueries: ["瑶药护颈枕"],
    checkedAt: "2026-10-05T08:00:00.000Z",
    candidates: [
      {
        id: "7900000000000000006",
        platform: "DOUYIN",
        videoId: "7900000000000000006",
        url: "https://www.douyin.com/video/7900000000000000006",
        title: "护颈枕使用场景演示",
        authorName: "测试作者",
        publishedAt: "2026-10-01T00:00:00.000Z",
        query: "瑶药护颈枕",
        rank: 1,
        metrics: {
          likes: 120000,
          comments: 3200,
          shares: 800
        },
        metricsAvailability: "PLATFORM_PUBLIC",
        sourceProvider: "market-video-test",
        status: "DISCOVERED"
      }
    ]
  });
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    browser,
    new RerankAwareRuntime(),
    flow,
    undefined,
    {
      searchProvider: market,
      mediaFetcher: new NeverMarketVideoMediaFetcher(),
      artifacts: {} as never,
      referenceVideo: {} as never,
      projectsRoot: "."
    }
  );

  const result = await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实产品事实，并研究同类爆款视频结构",
    sourceUrls: [],
    queries: ["护颈枕", "枕头"],
    marketVideo: {
      enabled: true,
      sort: "MOST_LIKED",
      timeRange: "ANY",
      count: 12
    }
  });

  assert.equal(result.evidence.length, 0);
  assert.equal(result.run.status, "FAILED");
  assert.equal(
    result.run.browserState?.marketVideoResearch?.status,
    "READY"
  );
  assert.equal(
    result.run.browserState?.marketVideoResearch?.candidates[0]?.videoId,
    "7900000000000000006"
  );
  assert.equal(market.inputs.length, 1);
  assert.deepEqual(market.inputs[0]?.queries.slice(0,2),["护颈枕","枕头"]);
  const oldCandidate=result.run.browserState!.marketVideoResearch!.candidates[0]!;
  await repo.updateRun(result.run.id,{browserState:{...result.run.browserState!,marketVideoResearch:{...result.run.browserState!.marketVideoResearch!,candidates:[{...oldCandidate,status:"ANALYZED",referenceVideoProfileId:"existing-profile"}]}}});
  await assert.rejects(service.searchMoreMarketVideos({projectId:"another-project",runId:result.run.id,queries:["护颈枕"]}),/不属于/);
  const added=await service.searchMoreMarketVideos({projectId,runId:result.run.id,queries:["护颈枕","枕头"]});
  assert.equal(added.run.id,result.run.id);
  assert.equal(added.run.browserState?.marketVideoResearch?.candidates[0]?.referenceVideoProfileId,"existing-profile");
  assert.equal(market.inputs[0]?.sort, "MOST_LIKED");
  assert.equal(market.inputs[0]?.timeRange, "ANY");
  assert.equal(
    market.inputs[0]?.queries.some((query) => query.includes("护颈枕")),
    true
  );
});

test("selected market video is fetched only on explicit analysis and reuses ReferenceVideoProfile flow", async () => {
  const projectId = "research-market-video-analysis";
  const runId = "research-market-video-run";
  const candidateId = "7900000000000000005";
  const repo = new MemoryResearchRepository();
  await repo.createRun({
    id: runId,
    projectId,
    mode: "DEEP",
    status: "FAILED",
    goal: "研究同类爆款视频",
    sourceUrls: [],
    queries: ["护颈枕"],
    browserState: {
      provider: "browser-test",
      lastCheckedAt: "2026-10-05T08:00:00.000Z",
      marketVideoResearch: {
        status: "READY",
        provider: "market-video-test",
        sort: "MOST_LIKED",
        timeRange: "ANY",
        searchedQueries: ["护颈枕"],
        checkedAt: "2026-10-05T08:00:00.000Z",
        candidates: [
          {
            id: candidateId,
            platform: "DOUYIN",
            videoId: candidateId,
            url: "https://www.douyin.com/video/" + candidateId,
            title: "待拆解高赞视频",
            query: "护颈枕",
            rank: 1,
            metrics: { likes: 88000 },
            metricsAvailability: "PLATFORM_PUBLIC",
            sourceProvider: "market-video-test",
            status: "DISCOVERED"
          }
        ]
      }
    },
    createdAt: "2026-10-05T08:00:00.000Z",
    updatedAt: "2026-10-05T08:00:00.000Z"
  });
  const artifactRepo = new MemoryArtifactRepository();
  const mediaFetcher = new StaticMarketVideoMediaFetcher();
  const referenceCalls: Array<{
    projectId: string;
    artifactId: string;
    originalFilename?: string;
    sourceUrl?: string;
  }> = [];
  const referenceVideo = {
    async analyzeUpload(input: {
      projectId: string;
      artifactId: string;
      originalFilename?: string;
      sourceUrl?: string;
    }): Promise<ReferenceVideoProfile> {
      referenceCalls.push(structuredClone(input));
      if(referenceCalls.length===1)throw new Error("Synthetic AI validation failure after download");
      return {
        id: "market-reference-profile",
        projectId,
        version: 7
      } as ReferenceVideoProfile;
    }
  };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-market-video-"));
  try {
    const { flow } = makeProductFlow(projectId);
    const service = new ResearchService(
      repo,
      new MemoryWebResearchProvider(),
      new StaticBrowserProvider({
        status: "READY",
        sources: [],
        browserState: { provider: "browser-test" }
      }),
      new RerankAwareRuntime(),
      flow,
      undefined,
      {
        searchProvider: new StaticMarketVideoSearchProvider({
          status: "READY",
          provider: "market-video-test",
          searchedQueries: [],
          checkedAt: "2026-10-05T08:00:00.000Z",
          candidates: []
        }),
        mediaFetcher,
        artifacts: artifactRepo,
        referenceVideo: referenceVideo as never,
        projectsRoot: temp
      }
    );

    assert.equal(mediaFetcher.inputs.length, 0);
    await assert.rejects(service.analyzeMarketVideo({projectId,runId,candidateId}),/Synthetic AI validation failure/);
    assert.ok((await repo.findRun(runId))?.browserState?.marketVideoResearch?.candidates[0]?.fetchedArtifactId);
    const result = await service.analyzeMarketVideo({
      projectId,
      runId,
      candidateId
    });

    assert.equal(mediaFetcher.inputs.length, 1);
    assert.equal(referenceCalls.length, 2);
    assert.equal(
      referenceCalls[0]?.sourceUrl,
      "https://www.douyin.com/video/" + candidateId
    );
    assert.equal(result.profile.id, "market-reference-profile");
    const updated = await repo.findRun(runId);
    const candidate =
      updated?.browserState?.marketVideoResearch?.candidates[0];
    assert.equal(candidate?.status, "ANALYZED");
    assert.equal(
      candidate?.referenceVideoProfileId,
      "market-reference-profile"
    );
    assert.equal(candidate?.referenceVideoProfileVersion, 7);
    assert.equal(
      artifactRepo.rows.get(candidate?.fetchedArtifactId ?? "")?.integrityStatus,
      "READY"
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("deep Research persists Human Takeover blocker instead of pretending to keep processing, then resumes", async () => {
  const projectId = "research-deep";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const browser = new StaticBrowserProvider(
    {
      status: "BLOCKED",
      blockerCode: "LOGIN_REQUIRED",
      message: "需要登录目标平台",
      requiredUserAction: "在浏览器完成登录后继续",
      browserState: {
        provider: "browser-test",
        resumeToken: "resume-1"
      }
    },
    {
      status: "READY",
      sources: [
        {
          url: "https://example.com/test-product-review",
          sourceType: "INDUSTRY",
          resultTitle: "Test Product 使用评测",
          resultSnippet: "Test Product 日常使用体验"
        }
      ],
      browserState: {
        provider: "browser-test",
        resumeToken: "resume-2"
      }
    }
  );
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider({
      "https://example.com/test-product-review":
        "Test Product 日常使用体验与公开说明。"
    }),
    browser,
    new EvidenceBoundRuntime(),
    flow
  );
  const first = await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "研究竞品",
    sourceUrls: [
      {
        url: "https://example.com/official",
        sourceType: "OFFICIAL"
      }
    ],
    queries: ["competitor video"]
  });
  assert.equal(first.run.status, "BLOCKED");
  assert.equal(first.run.blockerCode, "LOGIN_REQUIRED");
  assert.match(
    first.run.requiredUserAction ?? "",
    /完成登录/
  );
  assert.equal(first.evidence.length, 1);
  assert.ok(first.brief);

  const resumed = await service.resumeRun(projectId, first.run.id);
  assert.equal(resumed.run.status, "COMPLETED");
  assert.equal(resumed.run.blockerCode, undefined);
  assert.equal(resumed.evidence.length, 2);
  assert.equal(browser.calls, 2);
});

test("Research candidate enters Product Truth only as UNVERIFIED, and becomes ProductFact only after explicit user PROMOTE", async () => {
  const projectId = "research-truth";
  const repo = new MemoryResearchRepository();
  const product = makeProductFlow(projectId);
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    new StaticBrowserProvider({
      status: "BLOCKED",
      blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
      message: "not configured",
      requiredUserAction: "connect browser"
    }),
    new EvidenceBoundRuntime(),
    product.flow
  );
  const run = await service.startRun({
    projectId,
    mode: "BASIC",
    goal: "核实产品公开卖点",
    sourceUrls: [
      {
        url: "https://example.com/product",
        sourceType: "OFFICIAL"
      }
    ],
    queries: []
  });
  const brief = run.brief!;
  const candidate = brief.candidateClaims[0]!;
  await service.sendClaimsToProductTruth({
    projectId,
    briefId: brief.id,
    claimIds: [candidate.id]
  });

  const draft = product.getSavedDraft();
  assert.ok(draft);
  assert.equal(draft!.status, "DRAFT");
  const researchClaim = draft!.uncertainClaims.find(
    (claim) => claim.sourceType === "research"
  );
  assert.ok(researchClaim);
  assert.equal(researchClaim!.status, "UNVERIFIED");
  assert.equal(researchClaim!.dispositionConfirmedByUser, false);
  assert.equal(
    draft!.confirmedFeatures.some(
      (fact) => fact.statement === candidate.statement
    ),
    false
  );

  const confirmed = confirmProductTruthDraft(
    draft!,
    Object.fromEntries(
      draft!.uncertainClaims.map((claim) => [
        claim.id,
        claim.id === researchClaim!.id
          ? "PROMOTE"
          : "KEEP_UNVERIFIED"
      ])
    )
  );
  const promoted = confirmed.confirmedFeatures.find(
    (fact) => fact.statement === candidate.statement
  );
  assert.ok(promoted);
  assert.equal(promoted!.sourceType, "external");
  assert.match(promoted!.evidenceRef ?? "", /^research-evidence:/);
});

test("deep Research automatically expands product usage, wearing and precaution queries", async () => {
  const projectId = "research-auto-queries";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId, {
    truthPatch: { category: "耳夹式蓝牙耳机" }
  });
  const browser = new StaticBrowserProvider({
    status: "BLOCKED",
    blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
    message: "not configured",
    requiredUserAction: "connect browser"
  });
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    browser,
    new EvidenceBoundRuntime(),
    flow
  );

  await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实产品的正确使用方式",
    sourceUrls: [],
    queries: []
  });

  const queries = browser.inputs[0]?.queries.join("\n") ?? "";
  assert.match(queries, /说明书 使用说明/);
  assert.match(queries, /使用方法 操作方法/);
  assert.match(queries, /佩戴位置 佩戴方法 安装位置/);
  assert.match(queries, /注意事项 使用限制 防水 充电/);
  assert.match(queries, /功能 作用 使用场景/);
});

test("deep Research rejects unrelated platform homepage before fetch and persists discovery audit", async () => {
  const projectId = "research-quality-gate";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const web = new MemoryWebResearchProvider({
    "https://www.bilibili.com/":
      "动画 游戏 音乐 热门视频，与 Test Product 无关。",
    "https://support.example.com/test-product/manual":
      "Test Product official manual. Feature one is documented for the current product."
  });
  const browser = new StaticBrowserProvider({
    status: "READY",
    sources: [
      {
        url: "https://www.bilibili.com/",
        sourceType: "PLATFORM",
        discoveryQuery: "Test Product 评测",
        discoveryEngine: "bing",
        discoveryRank: 1,
        resultTitle: "哔哩哔哩首页",
        resultSnippet: "动画 游戏 音乐 热门视频"
      },
      {
        url: "https://support.example.com/test-product/manual",
        sourceType: "OFFICIAL",
        discoveryQuery: "Test Product 官网 说明书",
        discoveryEngine: "bing",
        discoveryRank: 1,
        resultTitle: "Test Product Official Manual",
        resultSnippet: "Official support and usage guide for Test Product"
      }
    ],
    browserState: { provider: "browser-test" }
  });
  const service = new ResearchService(
    repo,
    web,
    browser,
    new EvidenceBoundRuntime(),
    flow
  );

  const result = await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实 Test Product 的公开资料",
    sourceUrls: [],
    queries: ["Test Product 评测"]
  });

  assert.equal(
    web.seen.some((item) => item.url === "https://www.bilibili.com/"),
    false
  );
  assert.equal(
    web.seen.some(
      (item) =>
        item.url === "https://support.example.com/test-product/manual"
    ),
    true
  );
  assert.equal(
    result.evidence.some((item) => item.sourceUrl === "https://www.bilibili.com/"),
    false
  );
  const round = result.run.browserState?.discoveryRounds?.[0];
  assert.ok(round);
  assert.equal(round!.candidateCount, 2);
  assert.equal(round!.rejectedCount, 1);
  const rejected = round!.candidates.find(
    (item) => item.url === "https://www.bilibili.com/"
  );
  assert.equal(rejected?.decision, "REJECT");
  assert.equal(rejected?.selectedForFetch, false);
  assert.ok(rejected?.reasons.some((item) => item.includes("平台首页")));
});

test("deep Research automatically retries with stronger recovery queries when round one has no accepted candidate", async () => {
  const projectId = "research-quality-recovery";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const web = new MemoryWebResearchProvider({
    "https://support.example.com/test-product/manual":
      "Test Product official manual and usage instructions."
  });
  const browser = new StaticBrowserProvider(
    {
      status: "READY",
      sources: [
        {
          url: "https://www.bilibili.com/",
          sourceType: "PLATFORM",
          discoveryQuery: "Test Product 评测",
          discoveryEngine: "bing",
          discoveryRank: 1,
          resultTitle: "哔哩哔哩首页",
          resultSnippet: "动画 游戏 音乐 热门"
        }
      ],
      browserState: { provider: "browser-test" }
    },
    {
      status: "READY",
      sources: [
        {
          url: "https://support.example.com/test-product/manual",
          sourceType: "OFFICIAL",
          discoveryQuery: "Test Product 官方 说明书 PDF",
          discoveryEngine: "bing",
          discoveryRank: 1,
          resultTitle: "Test Product Official Manual",
          resultSnippet: "Official manual for Test Product"
        }
      ],
      browserState: { provider: "browser-test" }
    }
  );
  const service = new ResearchService(
    repo,
    web,
    browser,
    new EvidenceBoundRuntime(),
    flow
  );

  const result = await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实 Test Product 使用方法",
    sourceUrls: [],
    queries: ["Test Product 评测"]
  });

  assert.equal(browser.calls, 2);
  assert.match(browser.inputs[1]?.queries.join("\n") ?? "", /官方 说明书 PDF/);
  assert.equal(result.run.browserState?.discoveryRounds?.length, 2);
  assert.equal(result.run.browserState?.discoveryRounds?.[0]?.acceptedCount, 0);
  assert.equal(result.run.browserState?.discoveryRounds?.[1]?.acceptedCount, 1);
  assert.ok(
    result.evidence.some(
      (item) =>
        item.sourceUrl === "https://support.example.com/test-product/manual"
    )
  );
});

test("semantic rerank can promote a relevant HOLD candidate but never rescues a hard-rejected platform homepage", async () => {
  const projectId = "research-semantic-rerank";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const web = new MemoryWebResearchProvider({
    "https://example.com/test-product-review":
      "Test Product review and usage notes for the current product."
  });
  const browser = new StaticBrowserProvider({
    status: "READY",
    sources: [
      {
        url: "https://www.bilibili.com/",
        sourceType: "PLATFORM",
        discoveryQuery: "Test Product 评测",
        discoveryEngine: "bing",
        discoveryRank: 1,
        resultTitle: "哔哩哔哩首页",
        resultSnippet: "动画 游戏 音乐 热门"
      },
      {
        url: "https://example.com/test-product-review",
        sourceType: "INDUSTRY",
        discoveryQuery: "Test Product 评测",
        discoveryEngine: "bing",
        discoveryRank: 2,
        resultTitle: "Test Product 使用评测",
        resultSnippet: "Test Product 日常使用体验"
      }
    ],
    browserState: { provider: "browser-test" }
  });
  const service = new ResearchService(
    repo,
    web,
    browser,
    new RerankAwareRuntime(),
    flow
  );

  const result = await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实 Test Product 使用体验",
    sourceUrls: [],
    queries: ["Test Product 评测"]
  });

  const round = result.run.browserState?.discoveryRounds?.[0];
  assert.ok(round);
  const platform = round!.candidates.find(
    (item) => item.url === "https://www.bilibili.com/"
  );
  const review = round!.candidates.find(
    (item) => item.url === "https://example.com/test-product-review"
  );
  assert.equal(platform?.semanticScore, 100);
  assert.equal(platform?.decision, "REJECT");
  assert.equal(platform?.selectedForFetch, false);
  assert.equal(review?.semanticScore, 100);
  assert.equal(review?.decision, "ACCEPT");
  assert.equal(review?.selectedForFetch, true);
  assert.ok(
    result.evidence.some(
      (item) => item.sourceUrl === "https://example.com/test-product-review"
    )
  );
});

test("research usage rule enters Product Truth as UNVERIFIED and becomes a confirmed hard rule only after user confirmation", async () => {
  const projectId = "research-usage-rule";
  const repo = new MemoryResearchRepository();
  const product = makeProductFlow(projectId);
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider({
      "https://example.com/manual":
        "官方说明：耳夹应佩戴在耳廓指定夹持位置，不应塞入耳道。"
    }),
    new StaticBrowserProvider({
      status: "BLOCKED",
      blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
      message: "not configured",
      requiredUserAction: "connect browser"
    }),
    new UsageRuleRuntime(),
    product.flow
  );

  const run = await service.startRun({
    projectId,
    mode: "BASIC",
    goal: "核实佩戴方法",
    sourceUrls: [
      {
        url: "https://example.com/manual",
        sourceType: "OFFICIAL"
      }
    ],
    queries: []
  });
  const brief = run.brief!;
  assert.equal(brief.usageRules.length, 1);
  const proposed = brief.usageRules[0]!;

  await service.sendClaimsToProductTruth({
    projectId,
    briefId: brief.id,
    claimIds: [],
    usageRuleIds: [proposed.id]
  });

  const draft = product.getSavedDraft();
  assert.ok(draft);
  const rule = draft!.usageRules?.find(
    (item) => item.sourceType === "research"
  );
  assert.ok(rule);
  assert.equal(rule!.status, "UNVERIFIED");
  assert.equal(rule!.dispositionConfirmedByUser, false);

  const confirmed = confirmProductTruthDraft(
    draft!,
    {},
    new Date("2026-09-29T08:00:00.000Z"),
    { [rule!.id]: "CONFIRM" }
  );
  const confirmedRule = confirmed.usageRules?.find(
    (item) => item.id === rule!.id
  );
  assert.equal(confirmedRule?.status, "CONFIRMED");
  assert.equal(confirmedRule?.dispositionConfirmedByUser, true);
});


test("deep Research builds pillow-specific queries and strong identity terms for 瑶药护颈枕", async () => {
  const projectId = "research-yao-pillow-queries";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId, {
    projectName: "广西金秀康瑶堂瑶药",
    truthPatch: {
      productName: "瑶药护颈枕",
      category: "草本养生寝具 / 瑶药护颈枕",
      confirmedFeatures: [
        {
          id: "yao-model-fact",
          statement: "型号为 KYTYYZ001。",
          sourceType: "user",
          createdAt: "2026-10-04T00:00:00.000Z"
        }
      ]
    }
  });
  const browser = new StaticBrowserProvider({
    status: "BLOCKED",
    blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
    message: "not configured",
    requiredUserAction: "connect browser"
  });
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    browser,
    new EvidenceBoundRuntime(),
    flow
  );

  await service.startRun({
    projectId,
    mode: "DEEP",
    goal: "核实公开卖点",
    sourceUrls: [],
    queries: []
  });

  const queries = browser.inputs[0]?.queries.join("\n") ?? "";
  assert.match(queries, /KYTYYZ001/);
  assert.match(queries, /广西金秀康瑶堂瑶药 瑶药护颈枕/);
  assert.match(queries, /材质 填充 配方 成分/);
  assert.match(queries, /清洗 保养 注意事项/);
  assert.doesNotMatch(queries, /防水 充电/);
  assert.doesNotMatch(queries, /佩戴位置/);
});

test("Research page data never reuses an older brief for a newer failed run", async () => {
  const projectId = "research-page-run-binding";
  const repo = new MemoryResearchRepository();
  const { flow } = makeProductFlow(projectId);
  const oldRun: ResearchRun = {
    id: "run-old-success",
    projectId,
    mode: "DEEP",
    status: "COMPLETED",
    goal: "旧研究",
    sourceUrls: [],
    queries: ["old"],
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:01:00.000Z"
  };
  const latestRun: ResearchRun = {
    id: "run-new-failed",
    projectId,
    mode: "DEEP",
    status: "FAILED",
    goal: "新研究",
    sourceUrls: [],
    queries: ["new"],
    blockerCode: "NO_EVIDENCE",
    blockerMessage: "没有获取到可用证据",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:01:00.000Z"
  };
  repo.runs.set(oldRun.id, oldRun);
  repo.runs.set(latestRun.id, latestRun);
  repo.briefs.set("brief-old", {
    id: "brief-old",
    projectId,
    runId: oldRun.id,
    status: "READY",
    summary: "这是旧研究报告",
    findings: [],
    candidateClaims: [],
    usageRules: [],
    contentOpportunities: [],
    uncertainties: [],
    contentHash: "old-brief-hash",
    createdAt: "2026-10-04T00:02:00.000Z"
  });
  const service = new ResearchService(
    repo,
    new MemoryWebResearchProvider(),
    new StaticBrowserProvider({
      status: "BLOCKED",
      blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
      message: "not configured",
      requiredUserAction: "connect browser"
    }),
    new EvidenceBoundRuntime(),
    flow
  );

  const page = await service.pageData(projectId);
  assert.equal(page.latestRun?.id, latestRun.id);
  assert.equal(page.brief, undefined);
  assert.deepEqual(page.evidence, []);
});
