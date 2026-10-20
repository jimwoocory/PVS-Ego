import test from "node:test";
import assert from "node:assert/strict";
import type {
  BrowserResearchProvider,
  BrowserResearchResult
} from "../src/application/ports/research-provider.js";
import {
  HybridBrowserResearchProvider,
  PublicSearchResearchProvider
} from "../src/adapters/research/public-search-research-provider.js";

function fakeSearchFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("bing.com/search")) {
    return Promise.resolve(
      new Response(
        '<html><body><ol><li class="b_algo"><h2><a href="https://tonemay.example.com/manual">Manual</a></h2></li><li class="b_algo"><h2><a href="https://shop.example.com/item">Shop</a></h2></li></ol></body></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      )
    );
  }
  return Promise.resolve(new Response("", { status: 404 }));
}

test("PublicSearchResearchProvider discovers and classifies public search results", async () => {
  const provider = new PublicSearchResearchProvider({
    fetcher: fakeSearchFetch as typeof fetch,
    maxQueries: 2,
    maxResultsPerQuery: 5
  });
  const result = await provider.discover({
    projectId: "project-search",
    goal: "核实佩戴方法",
    queries: ["Tonemay Q8 官网 说明书"]
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0]?.url, "https://tonemay.example.com/manual");
  assert.equal(result.sources[0]?.sourceType, "OFFICIAL");
  assert.equal(result.sources[0]?.resultTitle, "Manual");
  assert.equal(result.sources[0]?.discoveryEngine, "bing");
  assert.equal(result.sources[0]?.discoveryRank, 1);
  assert.equal(result.sources[0]?.discoveryQuery, "Tonemay Q8 官网 说明书");
});

class NotConfiguredProvider implements BrowserResearchProvider {
  readonly id = "external-test";
  async discover(): Promise<BrowserResearchResult> {
    return {
      status: "BLOCKED",
      blockerCode: "BROWSER_PROVIDER_NOT_CONFIGURED",
      message: "not configured",
      requiredUserAction: "connect"
    };
  }
}

test("HybridBrowserResearchProvider falls back to public search when external browser provider is not configured", async () => {
  const publicSearch = new PublicSearchResearchProvider({
    fetcher: fakeSearchFetch as typeof fetch
  });
  const provider = new HybridBrowserResearchProvider(
    new NotConfiguredProvider(),
    publicSearch
  );
  const result = await provider.discover({
    projectId: "project-search",
    goal: "研究使用方法",
    queries: ["Tonemay Q8 使用方法"]
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.ok(result.sources.some((item) => item.url.includes("tonemay.example.com")));
});


test("PublicSearchResearchProvider classifies commerce host before query wording", async () => {
  const provider = new PublicSearchResearchProvider({
    fetcher: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("bing.com/search")) {
        return new Response(
          '<html><body><ol><li class="b_algo"><h2><a href="https://detail.1688.com/offer/123.html">瑶药护颈枕商品</a></h2></li></ol></body></html>',
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch
  });
  const result = await provider.discover({
    projectId: "project-commerce-classification",
    goal: "查产品资料",
    queries: ["瑶药护颈枕 官网"]
  });
  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.sources[0]?.sourceType, "PUBLIC_PRODUCT");
});

test("PublicSearchResearchProvider searches every query before applying the global result cap", async () => {
  const seenQueries: string[] = [];
  const provider = new PublicSearchResearchProvider({
    fetcher: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.hostname.includes("bing.com")) {
        return new Response("", { status: 404 });
      }
      const query = url.searchParams.get("q") ?? "";
      seenQueries.push(query);
      const slug = encodeURIComponent(query);
      return new Response(
        '<html><body><ol><li class="b_algo"><h2><a href="https://example.com/' +
          slug +
          '">Result ' +
          query +
          '</a></h2></li></ol></body></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }) as typeof fetch,
    maxQueries: 3,
    maxResultsPerQuery: 1,
    maxTotalResults: 2
  });
  const queries = ["query-one", "query-two", "query-three"];
  const result = await provider.discover({
    projectId: "project-balanced-search",
    goal: "research",
    queries
  });
  assert.equal(result.status, "READY");
  assert.deepEqual(seenQueries, queries);
  if (result.status !== "READY") return;
  assert.equal(result.sources.length, 2);
  assert.deepEqual(
    result.sources.map((item) => item.discoveryQuery),
    ["query-one", "query-two"]
  );
});
