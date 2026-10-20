(() => {
  "use strict";

  const REQUEST = "PVS_DOUYIN_SEARCH_REQUEST";
  const RESULT = "PVS_DOUYIN_SEARCH_RESULT";

  function commonParams() {
    const connection = navigator.connection || {};
    const ua = navigator.userAgent || "";
    const chromeMatch = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    const chromeVersion = chromeMatch ? chromeMatch[1] : "154.0.0.0";
    return {
      device_platform: "webapp",
      aid: "6383",
      channel: "channel_pc_web",
      pc_client_type: "1",
      pc_libra_divert: "Windows",
      update_version_code: "170400",
      support_h265: "1",
      support_dash: "1",
      version_code: "170400",
      version_name: "17.4.0",
      cookie_enabled: "true",
      screen_width: String(screen.width),
      screen_height: String(screen.height),
      browser_language: navigator.language || "zh-CN",
      browser_platform: "Win32",
      browser_name: "Chrome",
      browser_version: chromeVersion,
      browser_online: "true",
      engine_name: "Blink",
      engine_version: chromeVersion,
      os_name: "Windows",
      os_version: "10",
      cpu_core_num: String(navigator.hardwareConcurrency || 12),
      device_memory: String(navigator.deviceMemory || 16),
      platform: "PC",
      downlink: String(connection.downlink || 10),
      effective_type: connection.effectiveType || "4g",
      round_trip_time: String(connection.rtt || 100)
    };
  }

  async function search(keyword, offset, count) {
    const params = new URLSearchParams({
      ...commonParams(),
      keyword,
      offset: String(offset || 0),
      count: String(Math.max(1, Math.min(20, count || 10))),
      search_channel: "aweme_general",
      search_source: "normal_search",
      query_correct_type: "1",
      is_filter_search: "0",
      need_filter_settings: "0",
      list_type: "single"
    });
    const response = await fetch(
      "/aweme/v1/web/general/search/single/?" + params.toString(),
      {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      }
    );
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!response.ok) {
      throw new Error("Douyin search HTTP " + response.status);
    }
    if (!/json/i.test(contentType) && /^\s*</.test(text)) {
      throw new Error("Douyin search returned verification/login HTML");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Douyin search returned invalid JSON");
    }
  }

  async function detail(videoId) {
    const params = new URLSearchParams({
      ...commonParams(),
      aweme_id: String(videoId || "")
    });
    const response = await fetch(
      "/aweme/v1/web/aweme/detail/?" + params.toString(),
      {
        method: "GET",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*"
        }
      }
    );
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!response.ok) {
      throw new Error("Douyin detail HTTP " + response.status);
    }
    if (!/json/i.test(contentType) && /^\s*</.test(text)) {
      throw new Error("Douyin detail returned verification/login HTML");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Douyin detail returned invalid JSON");
    }
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (
      event.source !== window ||
      !data ||
      data.source !== "pvs-douyin-research-bridge" ||
      data.type !== REQUEST ||
      typeof data.requestId !== "string"
    ) {
      return;
    }

    const payload = data.payload || {};
    try {
      const value =
        payload.operation === "detail"
          ? await detail(String(payload.videoId || ""))
          : await search(
              String(payload.keyword || ""),
              Number(payload.offset || 0),
              Number(payload.count || 10)
            );
      window.postMessage(
        {
          source: "pvs-douyin-research-page",
          type: RESULT,
          requestId: data.requestId,
          value
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: "pvs-douyin-research-page",
          type: RESULT,
          requestId: data.requestId,
          error: error instanceof Error ? error.message : String(error)
        },
        "*"
      );
    }
  });
})();
