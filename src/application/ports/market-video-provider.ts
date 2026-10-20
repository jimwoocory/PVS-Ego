export type MarketVideoSort = "RELEVANCE" | "MOST_LIKED" | "LATEST";
export type MarketVideoTimeRange = "ANY" | "DAY" | "WEEK" | "HALF_YEAR";

export type MarketVideoCandidate = {
  id: string;
  platform: "DOUYIN";
  videoId: string;
  url: string;
  title: string;
  authorName?: string;
  authorId?: string;
  publishedAt?: string;
  query: string;
  rank: number;
  metrics: {
    likes?: number;
    comments?: number;
    shares?: number;
    plays?: number;
  };
  metricsAvailability: "PLATFORM_PUBLIC" | "UNAVAILABLE";
  sourceProvider: string;
  status: "DISCOVERED" | "ANALYZED" | "FAILED";
  analysisError?: string;
  referenceVideoProfileId?: string;
  referenceVideoProfileVersion?: number;
  fetchedArtifactId?: string;
};

export type MarketVideoSearchBlockedCode =
  | "LOGIN_REQUIRED"
  | "PROVIDER_NOT_AVAILABLE"
  | "RISK_CONTROL"
  | "PROVIDER_ERROR";

export type MarketVideoSearchResult =
  | {
      status: "READY";
      provider: string;
      candidates: MarketVideoCandidate[];
      searchedQueries: string[];
      checkedAt: string;
      note?: string;
    }
  | {
      status: "BLOCKED";
      provider: string;
      code: MarketVideoSearchBlockedCode;
      message: string;
      requiredUserAction: string;
      searchedQueries: string[];
      checkedAt: string;
    };

export interface MarketVideoSearchProvider {
  readonly id: string;
  search(input: {
    projectId: string;
    queries: string[];
    sort: MarketVideoSort;
    timeRange: MarketVideoTimeRange;
    count: number;
  }): Promise<MarketVideoSearchResult>;
}

export type FetchedMarketVideo = {
  sourceUrl: string;
  originalFilename: string;
  mimeType: "video/mp4" | "video/quicktime";
  bytes: Uint8Array;
};

export interface MarketVideoMediaFetcher {
  readonly id: string;
  fetch(input: {
    projectId: string;
    candidate: MarketVideoCandidate;
  }): Promise<FetchedMarketVideo>;
}
