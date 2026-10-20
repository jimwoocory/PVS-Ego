(() => {
  "use strict";

  const SERVER = "http://127.0.0.1:19422";
  const SITE = "douyin.com";
  const TOKEN = "__PVS_BRIDGE_TOKEN__";
  const pages = new Map();
  const waiters = new Map();
  let connectionId = "";
  let running = false;

  const headers = {
    "content-type": "application/json",
    authorization: "Bearer " + TOKEN
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(path, options = {}) {
    const response = await fetch(SERVER + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Bridge returned invalid JSON");
    }
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || ("Bridge HTTP " + response.status));
    }
    return body;
  }

  function newestPage() {
    const values = [...pages.values()];
    return values.length ? values[values.length - 1] : null;
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "pvs-douyin-page") return;
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== "number") return;
    const entry = { tabId, port, meta: {}, readyAt: Date.now() };
    pages.set(tabId, entry);

    port.onMessage.addListener((message) => {
      if (!message) return;
      if (message.type === "page-ready") {
        entry.meta = {
          url: String(message.url || ""),
          title: String(message.title || ""),
          userAgent: String(message.userAgent || "")
        };
        entry.readyAt = Date.now();
        ensureLoop();
        return;
      }
      if (message.type === "page-result" && typeof message.id === "string") {
        const waiter = waiters.get(message.id);
        if (!waiter) return;
        waiters.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(String(message.error)));
        else waiter.resolve(message.value);
      }
    });

    port.onDisconnect.addListener(() => {
      pages.delete(tabId);
    });
  });

  function runPageRequest(commandId, payload) {
    const page = newestPage();
    if (!page) return Promise.reject(new Error("No douyin.com page connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(commandId);
        reject(new Error("Douyin page search timeout"));
      }, 27000);
      waiters.set(commandId, { resolve, reject, timer });
      page.port.postMessage({
        type: "request",
        id: commandId,
        payload
      });
    });
  }

  async function register() {
    const page = newestPage();
    if (!page) throw new Error("No douyin.com page connected");
    const registered = await request("/api/connect", {
      method: "POST",
      body: JSON.stringify({
        site: SITE,
        url: page.meta.url || "https://www.douyin.com/",
        title: page.meta.title || "Douyin",
        userAgent: page.meta.userAgent || ""
      })
    });
    connectionId = registered.id || "";
  }

  async function loop() {
    await register();
    while (pages.size > 0) {
      const command = await request(
        "/api/poll?site=" +
          encodeURIComponent(SITE) +
          "&id=" +
          encodeURIComponent(connectionId),
        { method: "GET" }
      );
      if (command.type !== "eval") continue;

      let value;
      let error;
      try {
        const expression = String(command.expression || "");
        let payload;
        if (expression.startsWith("PVS_SEARCH:")) {
          payload = {
            operation: "search",
            ...JSON.parse(expression.slice("PVS_SEARCH:".length))
          };
        } else if (expression.startsWith("PVS_DETAIL:")) {
          payload = {
            operation: "detail",
            ...JSON.parse(expression.slice("PVS_DETAIL:".length))
          };
        } else {
          throw new Error(
            "PVS read-only bridge only accepts search/detail commands"
          );
        }
        value = await runPageRequest(command.id, payload);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }

      await request("/api/result", {
        method: "POST",
        body: JSON.stringify({
          id: command.id,
          ...(error ? { error } : { value })
        })
      });
    }
  }

  async function ensureLoop() {
    if (running) return;
    running = true;
    try {
      while (pages.size > 0) {
        try {
          await loop();
        } catch {
          await sleep(1500);
        }
      }
    } finally {
      running = false;
      connectionId = "";
    }
  }
})();
