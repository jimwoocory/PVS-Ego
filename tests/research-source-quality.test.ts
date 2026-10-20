import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchedDocumentMatchesIdentity,
  scoreResearchCandidate
} from "../src/application/services/research-source-quality.js";

const identity = {
  productName: "Tonemay Q8",
  brand: "Tonemay",
  category: "耳夹式蓝牙耳机"
};

test("platform homepage without product identity is rejected before fetch", () => {
  const score = scoreResearchCandidate({
    source: {
      url: "https://www.bilibili.com/",
      sourceType: "PLATFORM",
      discoveryQuery: "Tonemay Q8 评测",
      discoveryEngine: "bing",
      discoveryRank: 1,
      resultTitle: "哔哩哔哩 (゜-゜)つロ 干杯~",
      resultSnippet: "动画 游戏 音乐 知识 科技"
    },
    identity
  });

  assert.equal(score.decision, "REJECT");
  assert.equal(score.identityMatched, false);
  assert.ok(score.reasons.some((item) => item.includes("平台首页")));
});

test("official result with exact product identity is accepted", () => {
  const score = scoreResearchCandidate({
    source: {
      url: "https://support.tonemay.example.com/q8/manual",
      sourceType: "OFFICIAL",
      discoveryQuery: "Tonemay Q8 官网 说明书",
      discoveryEngine: "bing",
      discoveryRank: 1,
      resultTitle: "Tonemay Q8 使用说明书",
      resultSnippet: "Tonemay Q8 耳夹式蓝牙耳机佩戴、充电和注意事项"
    },
    identity
  });

  assert.equal(score.decision, "ACCEPT");
  assert.equal(score.identityMatched, true);
  assert.ok(score.deterministicScore >= 55);
});

test("generic category article cannot masquerade as a strong product match", () => {
  const score = scoreResearchCandidate({
    source: {
      url: "https://example.com/bluetooth-headphones-guide",
      sourceType: "INDUSTRY",
      discoveryQuery: "Tonemay Q8 使用方法",
      discoveryEngine: "duck",
      discoveryRank: 2,
      resultTitle: "2026 蓝牙耳机选购指南",
      resultSnippet: "介绍多种耳机形态和通用佩戴方式"
    },
    identity
  });

  assert.notEqual(score.decision, "ACCEPT");
  assert.equal(score.identityMatched, false);
});

test("same-host saturation lowers later candidates", () => {
  const base = {
    source: {
      url: "https://shop.example.com/tonemay-q8",
      sourceType: "PUBLIC_PRODUCT" as const,
      resultTitle: "Tonemay Q8 商品详情",
      resultSnippet: "Tonemay Q8 耳夹式蓝牙耳机"
    },
    identity
  };
  const first = scoreResearchCandidate(base);
  const later = scoreResearchCandidate({
    ...base,
    sameHostAcceptedCount: 2
  });
  assert.ok(later.deterministicScore < first.deterministicScore);
});

test("fetched document identity gate rejects unrelated page body", () => {
  const unrelated = fetchedDocumentMatchesIdentity({
    finalUrl: "https://www.bilibili.com/",
    title: "热门视频",
    text: "游戏 动画 音乐 舞蹈 影视 娱乐",
    identity
  });
  assert.equal(unrelated.matched, false);

  const relevant = fetchedDocumentMatchesIdentity({
    finalUrl: "https://support.tonemay.example.com/q8",
    title: "Tonemay Q8 支持",
    text: "Tonemay Q8 耳夹式蓝牙耳机使用说明与佩戴注意事项。",
    identity
  });
  assert.equal(relevant.matched, true);
  assert.ok(relevant.score >= 20);
});


test("strong identity keeps same-category competitor out of current-product evidence", () => {
  const yaoIdentity = {
    productName: "瑶药护颈枕",
    category: "草本养生寝具 / 瑶药护颈枕",
    modelTerms: ["KYTYYZ001"],
    organizationTerms: ["广西金秀康瑶堂瑶药"]
  };

  const candidate = scoreResearchCandidate({
    source: {
      url: "https://example.com/yao-pillow",
      sourceType: "PUBLIC_PRODUCT",
      resultTitle: "瑶药护颈枕 草本助眠枕 商品详情",
      resultSnippet: "广西金秀同类瑶药枕，未标注目标型号或公司主体"
    },
    identity: yaoIdentity
  });

  assert.notEqual(candidate.decision, "ACCEPT");
  assert.ok(
    candidate.reasons.some((item) => item.includes("保留为同类候选"))
  );

  const unrelatedProduct = fetchedDocumentMatchesIdentity({
    finalUrl: "https://example.com/yao-pillow",
    title: "瑶药护颈枕 商品详情",
    text: "这是另一家商家的瑶药护颈枕，介绍草本填充与睡眠场景。",
    identity: yaoIdentity
  });
  assert.equal(unrelatedProduct.matched, false);
  assert.ok(
    unrelatedProduct.reasons.some((item) => item.includes("不能确认是当前产品"))
  );

  const exactModel = fetchedDocumentMatchesIdentity({
    finalUrl: "https://example.com/kyt-yyz001",
    title: "KYTYYZ001 瑶药护颈枕",
    text: "KYTYYZ001 瑶药护颈枕产品说明。",
    identity: yaoIdentity
  });
  assert.equal(exactModel.matched, true);
});
