import type {
  ResearchEvidenceSourceType
} from "./research-repository.js";

export type WebResearchSource = {
  url: string;
  sourceType: ResearchEvidenceSourceType;
  discoveryQuery?: string;
  discoveryEngine?: "bing" | "duck" | "external";
  discoveryRank?: number;
  resultTitle?: string;
  resultSnippet?: string;
  /** Opaque local session handle, never a browser credential or a control grant. */
  browserResumeHandle?: string;
};

export type ResearchSourceCapture = {provider:string; documentArtifactId:string; screenshotArtifactId?:string;
  sourceUrl:string; finalUrl:string; fetchedAt:string; contentHash:string; truncated:boolean};

export type WebResearchMedia = {
  type: "IMAGE" | "VIDEO";
  url: string;
  mimeType?: string;
  label?: string;
};

export type WebResearchDocument = {
  sourceUrl: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  sourceType: ResearchEvidenceSourceType;
  text: string;
  excerpt: string;
  contentHash: string;
  media?: WebResearchMedia[];
  sourceCapture?: ResearchSourceCapture;
};

export interface WebResearchProvider {
  fetchSource(source: WebResearchSource, context?:{projectId:string;runId:string}): Promise<WebResearchDocument>;
}

export type BrowserResearchBlockerCode =
  | "BROWSER_PROVIDER_NOT_CONFIGURED"
  | "LOGIN_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "RISK_CONTROL"
  | "BROWSER_SESSION_EXPIRED"
  | "BROWSER_PROVIDER_ERROR";

export type BrowserResearchReady = {
  status: "READY";
  sources: WebResearchSource[];
  browserState?: {
    provider: string;
    resumeToken?: string;
  };
};

export type BrowserResearchBlocked = {
  status: "BLOCKED";
  blockerCode: BrowserResearchBlockerCode;
  message: string;
  requiredUserAction: string;
  browserState?: {
    provider: string;
    resumeToken?: string;
  };
};

export type BrowserResearchResult =
  | BrowserResearchReady
  | BrowserResearchBlocked;

export interface BrowserResearchProvider {
  readonly id: string;
  discover(input: {
    projectId: string;
    runId?: string;
    goal: string;
    queries: string[];
    resumeToken?: string;
  }): Promise<BrowserResearchResult>;
}

export class BrowserResearchBlockedError extends Error {
  constructor(readonly result:BrowserResearchBlocked){super(result.message);this.name="BrowserResearchBlockedError";}
}

export type ResearchMediaAnalysis = {
  sourceUrl: string;
  title: string;
  text: string;
  contentHash: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  mediaContext: {
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
};

export interface ResearchMediaAnalyzer {
  analyze(input: {
    projectId: string;
    runId: string;
    parentSourceUrl: string;
    pageTitle: string;
    sourceType: ResearchEvidenceSourceType;
    productIdentity?: {
      productName?: string;
      brand?: string;
      category?: string;
    };
    media: WebResearchMedia[];
  }): Promise<{
    analyses: ResearchMediaAnalysis[];
    failures: string[];
  }>;
}
