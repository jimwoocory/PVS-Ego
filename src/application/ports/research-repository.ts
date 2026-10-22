import type { StructuredAiExecutionMetadata } from "./structured-ai-runtime.js";
import type { MarketVideoCandidate, MarketVideoSort, MarketVideoTimeRange } from "./market-video-provider.js";
import type {ResearchSourceCapture} from "./research-provider.js";

export type ResearchMode = "OFF" | "BASIC" | "DEEP";
export type ResearchRunStatus =
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "FAILED"
  | "COMPLETED";

export type ResearchEvidenceSourceType =
  | "OFFICIAL"
  | "USER_URL"
  | "PUBLIC_PRODUCT"
  | "COMPETITOR"
  | "INDUSTRY"
  | "TREND"
  | "PLATFORM";

export type ResearchConfidence = "LOW" | "MEDIUM" | "HIGH";

export type ResearchEvidence = {
  id: string;
  projectId: string;
  runId: string;
  sourceUrl: string;
  title: string;
  fetchedAt: string;
  sourceType: ResearchEvidenceSourceType;
  excerpt: string;
  summary: string;
  contentHash: string;
  confidence: ResearchConfidence;
  sourceCapture?:ResearchSourceCapture;
  mediaContext?: {
    type: "IMAGE" | "VIDEO_FRAMES" | "AUDIO";
    parentSourceUrl: string;
    mediaUrl: string;
    analysisMethod:
      | "VISION"
      | "VIDEO_FRAME_SAMPLING"
      | "AUDIO_MULTIMODAL";
    productIdentityMatch?: "CONFIRMED" | "UNCERTAIN" | "NOT_PRODUCT";
    identityReason?: string;
    timestampsMs?: number[];
  };
  relatedClaims: string[];
  status: "ACTIVE" | "STALE";
  createdAt: string;
};

export type ResearchFinding = {
  id: string;
  statement: string;
  evidenceIds: string[];
  confidence: ResearchConfidence;
};

export type ResearchClaimStatus =
  | "PROPOSED"
  | "SENT_TO_TRUTH"
  | "REJECTED";

export type ResearchCandidateClaim = {
  id: string;
  statement: string;
  evidenceIds: string[];
  confidence: ResearchConfidence;
  status: ResearchClaimStatus;
};

export type ResearchUsageRuleCategory =
  | "USAGE_METHOD"
  | "WEARING_POSITION"
  | "PRECAUTION"
  | "FUNCTION_EFFECT"
  | "USAGE_SCENARIO"
  | "PRODUCT_STATE"
  | "LIMITATION";

export type ResearchUsageRule = {
  id: string;
  category: ResearchUsageRuleCategory;
  polarity: "MUST" | "MUST_NOT" | "CONTEXT";
  statement: string;
  evidenceIds: string[];
  confidence: ResearchConfidence;
  status: ResearchClaimStatus;
};

export type ResearchBrief = {
  id: string;
  projectId: string;
  runId: string;
  status: "READY" | "STALE";
  summary: string;
  findings: ResearchFinding[];
  candidateClaims: ResearchCandidateClaim[];
  usageRules: ResearchUsageRule[];
  contentOpportunities: string[];
  uncertainties: string[];
  aiExecution?: StructuredAiExecutionMetadata;
  contentHash: string;
  createdAt: string;
};

export type ResearchBrowserState = {
  /** Explicitly persisted reduced-work mode; never inferred from an old run. */
  collectionOnly?: boolean;
  provider: string;
  resumeToken?: string;
  lastCheckedAt: string;
  discoveryRounds?: Array<{
    round: number;
    queries: string[];
    candidateCount: number;
    acceptedCount: number;
    heldCount: number;
    rejectedCount: number;
    marketReferenceCount?: number;
    fetchedCount: number;
    candidates: Array<{
      url: string;
      title?: string;
      sourceType: ResearchEvidenceSourceType;
      query?: string;
      engine?: "bing" | "duck" | "external";
      rank?: number;
      deterministicScore: number;
      semanticScore?: number;
      finalScore: number;
      decision: "ACCEPT" | "HOLD" | "REJECT";
      pool?: "PRODUCT_FACT" | "MARKET_REFERENCE" | "REJECTED";
      selectedForFetch: boolean;
      reasons: string[];
      fetchedIdentityScore?: number;
      fetchedIdentityMatched?: boolean;
      fetchOutcome?: "EVIDENCE" | "REJECTED" | "FAILED";
    }>;
  }>;
  marketVideoResearch?: {
    status: "READY" | "BLOCKED";
    provider: string;
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    searchedQueries: string[];
    checkedAt: string;
    candidates: MarketVideoCandidate[];
    blockerCode?: "LOGIN_REQUIRED" | "PROVIDER_NOT_AVAILABLE" | "RISK_CONTROL" | "PROVIDER_ERROR";
    message?: string;
    requiredUserAction?: string;
    note?: string;
  };
};

export type ResearchRun = {
  id: string;
  projectId: string;
  mode: ResearchMode;
  status: ResearchRunStatus;
  goal: string;
  sourceUrls: Array<{
    url: string;
    sourceType: ResearchEvidenceSourceType;
  }>;
  queries: string[];
  browserState?: ResearchBrowserState;
  blockerCode?: string;
  blockerMessage?: string;
  requiredUserAction?: string;
  createdAt: string;
  updatedAt: string;
};

export interface ResearchRepository {
  createRun(run: ResearchRun): Promise<ResearchRun>;
  updateRun(
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
  ): Promise<ResearchRun>;
  findRun(id: string): Promise<ResearchRun | null>;
  listRuns(projectId: string): Promise<ResearchRun[]>;

  createEvidence(evidence: ResearchEvidence): Promise<ResearchEvidence>;
  updateEvidenceRelatedClaims(
    id: string,
    relatedClaims: string[]
  ): Promise<ResearchEvidence>;
  listEvidence(runId: string): Promise<ResearchEvidence[]>;

  createBrief(brief: ResearchBrief): Promise<ResearchBrief>;
  updateBriefClaims(
    id: string,
    claims: ResearchCandidateClaim[]
  ): Promise<ResearchBrief>;
  updateBriefUsageRules(
    id: string,
    usageRules: ResearchUsageRule[]
  ): Promise<ResearchBrief>;
  findBrief(id: string): Promise<ResearchBrief | null>;
  latestBrief(projectId: string): Promise<ResearchBrief | null>;
  findBriefByRun(runId: string): Promise<ResearchBrief | null>;
  listBriefs(projectId: string): Promise<ResearchBrief[]>;
}
