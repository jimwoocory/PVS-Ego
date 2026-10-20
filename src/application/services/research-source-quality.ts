import type { WebResearchSource } from "../ports/research-provider.js";

export type ResearchIdentity = {
  productName?: string;
  brand?: string;
  category?: string;
  modelTerms?: string[];
  organizationTerms?: string[];
  aliasTerms?: string[];
};

export type ResearchCandidateDecision = "ACCEPT" | "HOLD" | "REJECT";

export type ResearchCandidateScore = {
  deterministicScore: number;
  finalScore: number;
  decision: ResearchCandidateDecision;
  reasons: string[];
  identityMatched: boolean;
  sourceQualityClass:
    | "OFFICIAL"
    | "PRODUCT_PAGE"
    | "PLATFORM"
    | "EDITORIAL"
    | "GENERIC";
};

const genericIdentityTerms = new Set([
  "pro",
  "plus",
  "max",
  "mini",
  "new",
  "产品",
  "商品",
  "官网",
  "官方",
  "说明书",
  "使用",
  "方法",
  "评测"
]);

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function identityTokens(identity: ResearchIdentity): string[] {
  const values = [
    identity.productName,
    identity.brand,
    ...(identity.modelTerms ?? []),
    ...(identity.organizationTerms ?? []),
    ...(identity.aliasTerms ?? [])
  ]
    .map(normalize)
    .filter(Boolean);
  const tokens = new Set<string>(values);
  for (const value of values) {
    for (const token of value.match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) ?? []) {
      if (!genericIdentityTerms.has(token)) tokens.add(token);
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}

function modelLikeTokens(identity: ResearchIdentity): string[] {
  const explicit = (identity.modelTerms ?? []).map(normalize).filter(Boolean);
  return [...new Set([
    ...explicit,
    ...identityTokens(identity).filter(
      (token) => /[a-z]/i.test(token) && /\d/.test(token)
    )
  ])];
}

function organizationTokens(identity: ResearchIdentity): string[] {
  return [
    ...new Set(
      (identity.organizationTerms ?? []).map(normalize).filter(Boolean)
    )
  ];
}

function platformHost(host: string): boolean {
  return /(^|\.)((bilibili|douyin|tiktok|youtube|youtu|xiaohongshu)\.com|youtu\.be)$/i.test(
    host
  );
}

function productCommerceHost(host: string): boolean {
  return /amazon\.|jd\.com$|tmall\.com$|taobao\.com$|pinduoduo\.com$|aliexpress\.|walmart\.|bestbuy\./i.test(
    host
  );
}

function homepageLike(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/, "");
  return !path || path === "/index" || path === "/index.html";
}

function includesTerm(haystack: string, term: string): boolean {
  return Boolean(term && haystack.includes(term));
}

function clamp(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sourceQualityClass(source: WebResearchSource): ResearchCandidateScore["sourceQualityClass"] {
  const host = new URL(source.url).hostname.toLowerCase();
  if (source.sourceType === "OFFICIAL") return "OFFICIAL";
  if (source.sourceType === "PUBLIC_PRODUCT" || productCommerceHost(host)) {
    return "PRODUCT_PAGE";
  }
  if (source.sourceType === "PLATFORM" || platformHost(host)) return "PLATFORM";
  if (
    source.sourceType === "INDUSTRY" ||
    source.sourceType === "TREND" ||
    source.sourceType === "COMPETITOR"
  ) {
    return "EDITORIAL";
  }
  return "GENERIC";
}

export function scoreResearchCandidate(input: {
  source: WebResearchSource;
  identity: ResearchIdentity;
  sameHostAcceptedCount?: number;
}): ResearchCandidateScore {
  const source = input.source;
  const url = new URL(source.url);
  const host = url.hostname.toLowerCase();
  const title = normalize(source.resultTitle);
  const snippet = normalize(source.resultSnippet);
  const urlText = normalize(source.url);
  const combined = [title, snippet, urlText].filter(Boolean).join("\n");
  const productName = normalize(input.identity.productName);
  const brand = normalize(input.identity.brand);
  const category = normalize(input.identity.category);
  const tokens = identityTokens(input.identity);
  const models = modelLikeTokens(input.identity);
  const organizations = organizationTokens(input.identity);
  const reasons: string[] = [];
  let score = 0;

  const exactProductTitle = includesTerm(title, productName);
  const exactProductSnippet = includesTerm(snippet, productName);
  const exactProductUrl = includesTerm(urlText, productName);
  if (exactProductTitle) {
    score += 42;
    reasons.push("搜索标题完整命中产品名");
  } else if (exactProductSnippet) {
    score += 30;
    reasons.push("搜索摘要完整命中产品名");
  } else if (exactProductUrl) {
    score += 24;
    reasons.push("网址命中产品名");
  }

  if (brand) {
    if (includesTerm(title, brand)) {
      score += 18;
      reasons.push("标题命中品牌");
    } else if (includesTerm(snippet, brand) || includesTerm(urlText, brand)) {
      score += 12;
      reasons.push("摘要或网址命中品牌");
    }
  }

  const matchedModels = models.filter((token) => includesTerm(combined, token));
  if (matchedModels.length) {
    score += Math.min(24, 12 + matchedModels.length * 6);
    reasons.push("命中型号：" + matchedModels.join("、"));
  }

  const matchedOrganizations = organizations.filter((token) =>
    includesTerm(combined, token)
  );
  if (matchedOrganizations.length) {
    score += Math.min(28, 16 + matchedOrganizations.length * 6);
    reasons.push("命中公司/主体身份：" + matchedOrganizations.join("、"));
  }

  const nonModelTokens = tokens
    .filter((token) => !models.includes(token))
    .filter((token) => token !== productName && token !== brand);
  const matchedIdentityTokens = nonModelTokens.filter((token) =>
    includesTerm(combined, token)
  );
  if (matchedIdentityTokens.length) {
    score += Math.min(18, matchedIdentityTokens.length * 6);
    reasons.push("命中产品身份词");
  }

  if (category && includesTerm(title + "\n" + snippet, category)) {
    score += 10;
    reasons.push("命中产品类别");
  }

  const quality = sourceQualityClass(source);
  if (quality === "OFFICIAL") {
    score += 15;
    reasons.push("官方来源加权");
  } else if (quality === "PRODUCT_PAGE") {
    score += 8;
    reasons.push("商品详情来源加权");
  } else if (quality === "PLATFORM") {
    score -= 3;
  }

  const identityMatched =
    exactProductTitle ||
    exactProductSnippet ||
    exactProductUrl ||
    (brand ? includesTerm(combined, brand) : false) ||
    matchedModels.length > 0 ||
    matchedOrganizations.length > 0 ||
    matchedIdentityTokens.length > 0;
  const strongIdentityAvailable = Boolean(
    brand || models.length || organizations.length
  );
  const strongIdentityMatched = Boolean(
    matchedModels.length ||
      matchedOrganizations.length ||
      (brand && includesTerm(combined, brand))
  );

  const home = homepageLike(url);
  if (home) {
    score -= quality === "PLATFORM" ? 55 : 22;
    reasons.push("首页/聚合入口降权");
  }

  if ((input.sameHostAcceptedCount ?? 0) >= 2) {
    score -= 12;
    reasons.push("同域名候选过多降权");
  }

  if (source.discoveryRank && source.discoveryRank > 3) {
    score -= Math.min(8, source.discoveryRank - 3);
  }

  const clearIdentity = Boolean(productName || brand || models.length);
  if (clearIdentity && !identityMatched) {
    score -= 28;
    reasons.push("搜索结果元数据未命中当前产品身份");
  }

  const hardReject =
    (quality === "PLATFORM" && home && !identityMatched) ||
    (platformHost(host) && home && !identityMatched);
  const metadataSparse =
    !source.resultTitle &&
    !source.resultSnippet &&
    !source.discoveryEngine;

  const deterministicScore = clamp(score);
  let decision: ResearchCandidateDecision;
  if (hardReject) {
    decision = "REJECT";
    reasons.push("平台首页且未命中产品身份，直接淘汰");
  } else if (metadataSparse && clearIdentity && !identityMatched) {
    decision = "HOLD";
    reasons.push("发现 Provider 未提供标题/摘要，保留到正文身份门禁");
  } else if (
    deterministicScore >= 55 &&
    (!strongIdentityAvailable || strongIdentityMatched)
  ) {
    decision = "ACCEPT";
  } else if (deterministicScore >= 22) {
    decision = "HOLD";
    if (strongIdentityAvailable && !strongIdentityMatched) {
      reasons.push(
        "仅命中产品名/品类，尚未命中型号、品牌或公司主体，保留为同类候选"
      );
    }
  } else {
    decision = "REJECT";
  }

  return {
    deterministicScore,
    finalScore: deterministicScore,
    decision,
    reasons,
    identityMatched,
    sourceQualityClass: quality
  };
}

export function fetchedDocumentMatchesIdentity(input: {
  finalUrl: string;
  title: string;
  text: string;
  identity: ResearchIdentity;
}): {
  matched: boolean;
  score: number;
  reasons: string[];
} {
  const productName = normalize(input.identity.productName);
  const brand = normalize(input.identity.brand);
  const category = normalize(input.identity.category);
  const models = modelLikeTokens(input.identity);
  const organizations = organizationTokens(input.identity);
  const haystack = normalize(
    [input.finalUrl, input.title, input.text.slice(0, 24000)].join("\n")
  );
  const reasons: string[] = [];
  let score = 0;

  if (productName && haystack.includes(productName)) {
    score += 55;
    reasons.push("正文/标题命中完整产品名");
  }
  if (brand && haystack.includes(brand)) {
    score += 20;
    reasons.push("正文/标题命中品牌");
  }
  const modelHits = models.filter((token) => haystack.includes(token));
  if (modelHits.length) {
    score += Math.min(30, modelHits.length * 15);
    reasons.push("正文/标题命中型号");
  }
  const organizationHits = organizations.filter((token) =>
    haystack.includes(token)
  );
  if (organizationHits.length) {
    score += Math.min(45, organizationHits.length * 30);
    reasons.push("正文/标题命中公司或主体身份");
  }
  if (category && haystack.includes(category)) {
    score += 8;
    reasons.push("正文/标题命中产品类别");
  }

  const clearIdentity = Boolean(
    productName || brand || models.length || organizations.length
  );
  const strongIdentityAvailable = Boolean(
    brand || models.length || organizations.length
  );
  const productNameMatched = Boolean(
    productName && haystack.includes(productName)
  );
  const brandMatched = Boolean(brand && haystack.includes(brand));
  const strongIdentityMatched = Boolean(
    modelHits.length ||
      (brandMatched && productNameMatched) ||
      (organizationHits.length && productNameMatched)
  );
  return {
    matched: clearIdentity
      ? strongIdentityAvailable
        ? strongIdentityMatched
        : score >= 20
      : true,
    score: clamp(score),
    reasons:
      strongIdentityAvailable && !strongIdentityMatched && productNameMatched
        ? [
            ...reasons,
            "只命中通用产品名，未命中型号、品牌或公司主体，不能确认是当前产品"
          ]
        : reasons
  };
}
