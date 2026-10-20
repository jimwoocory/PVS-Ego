(() => {
  "use strict";

  const REQUEST = "PVS_DOUYIN_SEARCH_REQUEST";
  const RESULT = "PVS_DOUYIN_SEARCH_RESULT";
  const pending = new Map();
  const port = chrome.runtime.connect({ name: "pvs-douyin-page" });

  port.postMessage({
    type: "page-ready",
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window ||
      !data ||
      data.source !== "pvs-douyin-research-page" ||
      data.type !== RESULT ||
      typeof data.requestId !== "string"
    ) {
      return;
    }
    const commandId = pending.get(data.requestId);
    if (!commandId) return;
    pending.delete(data.requestId);
    port.postMessage({
      type: "page-result",
      id: commandId,
      ...(data.error ? { error: String(data.error) } : { value: data.value })
    });
  });

  port.onMessage.addListener((message) => {
    if (!message || message.type !== "request" || typeof message.id !== "string") {
      return;
    }
    const requestId =
      "pvs-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    pending.set(requestId, message.id);
    window.postMessage(
      {
        source: "pvs-douyin-research-bridge",
        type: REQUEST,
        requestId,
        payload: message.payload || {}
      },
      "*"
    );
    setTimeout(() => {
      const commandId = pending.get(requestId);
      if (!commandId) return;
      pending.delete(requestId);
      port.postMessage({
        type: "page-result",
        id: commandId,
        error: "Douyin page request timeout"
      });
    }, 25000);
  });
})();
