export type DouyinOpsStatus =
  | "READY"
  | "ENGINE_UNAVAILABLE"
  | "BRIDGE_OFFLINE"
  | "BRIDGE_AUTH_FAILED"
  | "SITE_OFFLINE"
  | "CLIENT_SCRIPT_OUTDATED"
  | "AUTH_REQUIRED"
  | "RISK_CONTROL"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_COMMAND"
  | "WRITE_OPERATION_DISABLED"
  | "PROTOCOL_ERROR"
  | "PROVIDER_ERROR"
  | string;

export type DouyinOpsProbe = {
  ok: boolean;
  ready: boolean;
  status: DouyinOpsStatus;
  contractVersion?: number;
  bridgeVersion?: string;
  runtimeRoot?: string;
  uptimeSeconds?: number;
  connection?: {
    id: string;
    url: string;
    connectedAt?: string;
    lastActivity?: string;
  };
  capabilities?: Record<string, boolean>;
  missingCapabilities?: string[];
  message?: string;
};

export type DouyinOpsIdentity = {
  nickname: string;
  uid: string;
  secUid: string;
  uniqueId: string;
  shortId: string;
};

export type DouyinOpsMetrics = {
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  collects?: number;
};

export type DouyinOpsAuthor = {
  nickname: string;
  uid: string;
  secUid: string;
  uniqueId: string;
};

export type DouyinOpsWork = {
  awemeId: string;
  description: string;
  publishedAt: string | null;
  author: DouyinOpsAuthor;
  metrics: DouyinOpsMetrics;
  metricAvailability?:import("../../domain/douyin-observation.js").MetricAvailability;
  durationMs: number;
  coverUrl: string;
  externalUrl: string;
};

export type DouyinOpsComment = {
  cid: string;
  awemeId: string;
  uid: string;
  secUid: string;
  nickname: string;
  text: string;
  diggCount: number;
  replyCount: number;
  createdAt: string | null;
  parentCid: string;
  avatarUrl: string;
};

export type DouyinOpsCommentPage = {
  comments: DouyinOpsComment[];
  cursor: string;
  hasMore: boolean;
  coverage?:import("../../domain/douyin-observation.js").CommentPageCoverage;
  readEvidence?:{version:"douyin-read-page-v1";kind:"COMMENTS"|"REPLIES";awemeId:string;parentCid:string|null;requestCursor:string;count:number;observedAt:string;raw:unknown};
};

export type DouyinOpsDownloadMetadata = {
  work: DouyinOpsWork;
  media: {
    videoUrl: string;
    audioUrl: string;
  };
};

export class DouyinOpsRuntimeError extends Error {
  readonly code: DouyinOpsStatus;

  constructor(code: DouyinOpsStatus, message: string) {
    super(message);
    this.name = "DouyinOpsRuntimeError";
    this.code = code;
  }
}

export interface DouyinOpsRuntime {
  probe(): Promise<DouyinOpsProbe>;
  identity(): Promise<DouyinOpsIdentity>;
  listMyWorks(count?: number): Promise<DouyinOpsWork[]>;
  searchWorks(input: {
    query: string;
    count?: number;
    offset?: number;
  }): Promise<DouyinOpsWork[]>;
  getWork(awemeId: string): Promise<DouyinOpsWork>;
  getComments(input: {
    awemeId: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage>;
  getReplies(input: {
    awemeId: string;
    cid: string;
    cursor?: string;
    count?: number;
  }): Promise<DouyinOpsCommentPage>;
  getDownloadMetadata(
    awemeId: string
  ): Promise<DouyinOpsDownloadMetadata>;
}
