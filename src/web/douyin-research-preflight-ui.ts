/**
 * Read-only DouyinOps readiness check. Only a deliberate button click may
 * call the existing launcher. A search is never submitted until the form's
 * own original submit handler has received a successful preflight result.
 */
export const douyinResearchPreflightControls =
  '<div data-douyin-preflight style="border:1px solid #dbe4ee;border-radius:9px;padding:12px;margin:10px 0">' +
  '<p class="muted" data-douyin-connection-status role="status">抖音研究可选。启用时将在开始前检查实际运营 Bridge 连接。</p>' +
  '<div class="row">' +
  '<button type="button" class="secondary" data-douyin-connect-check>重新检测抖音连接</button>' +
  '<button type="button" class="secondary" data-douyin-connect-launch>启动/恢复抖音连接</button>' +
  '<button type="button" class="secondary" data-douyin-research-skip>暂不搜索抖音，继续普通研究</button>' +
  '</div>' +
  '<p class="danger" data-douyin-connection-error role="alert"></p>' +
  '</div>';

export const douyinResearchPreflightBrowserScript = String.raw`
(() => {
  const containers = [...document.querySelectorAll('[data-douyin-preflight]')];
  if (!containers.length) return;
  const allowOnce = new WeakSet();
  const pendingChecks = new WeakMap();
  function describeStatus(value) {
    // The dedicated read-only endpoint checks research Bridge and identity
    // without the slow /my works list or unrelated publishing account.
    if (value?.ready === true && value?.status === 'READY') {
      return { ready: true, message: '抖音研究连接与账号均已确认。实际搜索仍以平台返回为准。' };
    }
    const code = value?.status || 'UNKNOWN';
    const statuses = {
      BRIDGE_OFFLINE: '本机抖音 Bridge 尚未启动',
      ENGINE_UNAVAILABLE: '抖音研究运行环境不可用',
      SITE_OFFLINE: 'Bridge 已运行，但专用抖音网页尚未注册',
      AUTH_REQUIRED: '抖音研究账号需要在专用网页正常登录',
      LOGIN_REQUIRED: '抖音研究账号需要在专用网页正常登录',
      RISK_CONTROL: '抖音当前需要人工处理平台验证',
      CLIENT_SCRIPT_OUTDATED: '抖音网页用户脚本需要更新后重新检查',
      UNKNOWN: '尚不能确认抖音研究可用'
    };
    return { ready: false, message: (typeof value?.message === 'string' && value.message)
      || statuses[code] || '当前尚不能确认抖音研究连接状态' };
  }
  async function request(url, method = 'GET') {
    const controller = new AbortController();
    // A user-requested browser launch may legitimately take up to 20s.
    // Research readiness is lightweight; never wait for a full works listing.
    const abort = setTimeout(() => controller.abort(), method === 'POST' ? 28000 : 9000);
    try {
      const response = await fetch(url, {
        method, signal: controller.signal,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {})
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message || '请求未完成');
      return json;
    } finally { clearTimeout(abort); }
  }
  async function verify(container) {
    const existing = pendingChecks.get(container);
    if (existing) return existing;
    const job = (async () => {
    const text = container.querySelector('[data-douyin-connection-status]');
    const error = container.querySelector('[data-douyin-connection-error]');
    text.textContent = '正在检查 Bridge、专用网页和当前连接…';
    error.textContent = '';
    try {
      const status = describeStatus(await request('/api/douyin/ops/research-readiness'));
      text.textContent = status.message;
      return status;
    } catch (cause) {
      const message = cause.name === 'AbortError'
        ? '本次检测超时，尚不能确认连接状态；并不代表抖音已断线。可重新检测或先继续普通研究。'
        : '连接检测失败：' + (cause.message || String(cause));
      text.textContent = message;
      return { ready: false, message };
    }
    })();
    pendingChecks.set(container, job);
    try { return await job; }
    finally { pendingChecks.delete(container); }
  }
  document.addEventListener('click', async event => {
    const button = event.target?.closest?.('[data-douyin-connect-check], [data-douyin-connect-launch], [data-douyin-research-skip]');
    if (!button) return;
    const container = button.closest('[data-douyin-preflight]');
    if (!container) return;
    if (button.matches('[data-douyin-research-skip]')) {
      const form = button.closest('form') || document.querySelector('#research-form, #ux-native-research-form');
      const checkbox = form?.querySelector('[name="marketVideoEnabled"]');
      if (checkbox) checkbox.checked = false;
      container.querySelector('[data-douyin-connection-status]').textContent =
        '已暂时关闭抖音竞品搜索。其余联网研究仍可继续；原搜索设置已保留。';
      return;
    }
    button.disabled = true;
    const text = container.querySelector('[data-douyin-connection-status]');
    try {
      if (button.matches('[data-douyin-connect-launch]')) {
        text.textContent = '正在请求启动或复用已存在的抖音专用连接，不会自动登录。';
        await request('/api/douyin/ops/launch', 'POST');
      }
      await verify(container);
    } catch (cause) {
      text.textContent = '启动请求没有证明研究连接已经就绪。';
      container.querySelector('[data-douyin-connection-error]').textContent = cause.message || String(cause);
    } finally { button.disabled = false; }
  });
  // Capture runs before the page's existing submit handler. One verified
  // re-dispatch is allowed, so the original confirmation/cost gate remains.
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!form?.matches?.('#research-form, #ux-native-research-form')) return;
    if (allowOnce.has(form)) { allowOnce.delete(form); return; }
    if (form.querySelector('[name="mode"]')?.value !== 'DEEP' ||
        !form.querySelector('[name="marketVideoEnabled"]')?.checked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const container = form.querySelector('[data-douyin-preflight]');
    if (!container) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    const checked = await verify(container);
    submit.disabled = false;
    if (!checked.ready) {
      container.querySelector('[data-douyin-connection-error]').textContent =
        '尚未确认抖音研究连接可用。请核对上方具体状态，重新检测或先跳过抖音搜索继续普通研究。';
      return;
    }
    allowOnce.add(form);
    form.requestSubmit(submit);
  }, true);
  for (const container of containers) {
    const form = container.closest('form');
    if (!form) continue;
    const checked = form.querySelector('[name="marketVideoEnabled"]');
    const mode = form.querySelector('[name="mode"]');
    const autoCheck = () => {
      if (checked?.checked && mode?.value === 'DEEP') void verify(container);
    };
    checked?.addEventListener('change', autoCheck);
    mode?.addEventListener('change', autoCheck);
    autoCheck();
  }
})();
`;
