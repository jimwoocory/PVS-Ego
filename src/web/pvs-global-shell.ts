/**
 * Shared application chrome for every user-facing PVS page.
 * Keep this independent of business state: the individual pages render their
 * real WorkflowReadModel and gates, while the site header only navigates.
 */
export type PvsSection = "projects" | "studio" | "agent-cycle" | "tasks" | "ops" | "settings" | "health";

const escapeHtml = (value: string) => String(value).replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]!);

const navItems: Array<{ section: PvsSection; label: string; href: string }> = [
  { section: "projects", label: "项目", href: "/projects" },
  { section: "studio", label: "视频制作", href: "/agent" },
  { section: "agent-cycle", label: "智能业务工作台", href: "/agent-cycle" },
  { section: "tasks", label: "任务中心", href: "/tasks" },
  { section: "ops", label: "抖音运营", href: "/douyin-ops" },
  { section: "settings", label: "模型设置", href: "/settings/ai" },
  { section: "health", label: "系统诊断", href: "/health-center" }
];

export function renderPvsGlobalHeader(section: PvsSection, options: { advancedToggle?: boolean; project?: { id: string; name: string } } = {}): string {
  return `<header class="pvs-global-header" data-pvs-ui-shell="unified-v2" role="banner">
    <div class="pvs-global-header-inner">
      <a class="pvs-global-brand" href="/projects" aria-label="返回 Product Video Studio 项目">
        <span class="pvs-global-monogram" aria-hidden="true">P</span>
        <span>Product Video Studio<small>统一视频制作工作台</small></span>
      </a>
      <nav class="pvs-global-nav" aria-label="全局导航">
        ${navItems.map(item => `<a href="${item.href}"${item.section === section ? ' aria-current="page"' : ""}>${item.label}</a>`).join("")}
      </nav>
      ${options.advancedToggle ? '<button class="pvs-advanced-toggle advanced-toggle" id="advanced-toggle" type="button">高级信息</button>' : ""}
    </div>
    ${options.project ? `<div class="pvs-project-context"><span>当前项目：<b>${escapeHtml(options.project.name)}</b></span><a href="/projects/${encodeURIComponent(options.project.id)}/smart">回到制作工作台 →</a></div>` : ""}
  </header>`;
}

/** Minimal branded chrome for the phone handoff, without unusable LAN-local links. */
export function renderPvsMobileHandoffHeader(): string {
  return `<header class="pvs-global-header" data-pvs-ui-shell="unified-v2" role="banner"><div class="pvs-global-header-inner"><div class="pvs-global-brand"><span class="pvs-global-monogram" aria-hidden="true">P</span><span>Product Video Studio<small>手机发布交接</small></span></div></div></header>`;
}

export const pvsGlobalStyles = `
:root{--pvs-page:#f4f7fc;--pvs-text:#172a46;--pvs-border:#dce5f0;--pvs-accent:#2767ca;--pvs-muted:#62758e}
body{background:var(--pvs-page)!important;color:var(--pvs-text);min-width:0}
.pvs-global-header{background:#fff;border-bottom:1px solid var(--pvs-border);position:relative;z-index:10;box-shadow:0 2px 10px rgba(20,55,103,.035)}
.pvs-global-header *{box-sizing:border-box}
.pvs-global-header-inner{max-width:1320px;margin:auto;padding:12px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.pvs-global-brand{display:inline-flex;align-items:center;gap:10px;color:#172a46!important;font-weight:800;font-size:16px;text-decoration:none!important;line-height:1.3;white-space:nowrap}
.pvs-global-brand small{display:block;color:#74859b;font-size:10px;font-weight:500;margin-top:4px}
.pvs-global-monogram{width:36px;height:36px;border-radius:10px;background:#2767ca;color:white;display:grid;place-items:center;font-size:20px;font-weight:800}
.pvs-global-nav{display:flex;align-items:center;flex-wrap:wrap;gap:5px}
.pvs-global-nav a{color:#536883!important;text-decoration:none!important;border:1px solid transparent;padding:9px 11px;border-radius:9px;font-size:13px;font-weight:600;white-space:nowrap}
.pvs-global-nav a[aria-current="page"]{background:#eaf2ff;border-color:#c9dbf8;color:#225cb4!important}
.pvs-global-nav a:hover,.pvs-global-nav a:focus-visible{background:#eff4fb;color:#153c77!important}
.pvs-global-nav a:focus-visible,.pvs-global-brand:focus-visible{outline:2px solid #2767ca;outline-offset:2px}
.pvs-global-header+main{margin-top:0}
.pvs-project-context{max-width:1320px;margin:-3px auto 0;padding:4px 22px 11px;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:12px;color:#667b97}
.pvs-project-context b{color:#2e4668}
.pvs-project-context a{color:#2767ca!important;text-decoration:none!important;font-weight:700}
.pvs-project-context a:hover{text-decoration:underline!important}
.pvs-advanced-toggle{background:#fff;border:1px solid #c8d4e5;border-radius:8px;color:#385476;font-size:12px;padding:8px 11px;cursor:pointer;margin:0!important}
.pvs-advanced-toggle:hover{background:#eef4fc}
/* Shared visual language without changing legacy business controls. */
body main h1{color:#182d49;font-size:clamp(23px,2vw,29px);line-height:1.3}
body main h2,body main h3{color:#243b5b}
body main .card,body main .toolbar,body main .candidate,body main .provider,body main .asset-card{border-color:#dae4f0;border-radius:12px}
body main .card{box-shadow:0 5px 22px rgba(20,48,88,.035)}
body main .muted{color:#63758d}
body main a:not([class]){color:#235fb8}
body main input:focus-visible,body main select:focus-visible,body main textarea:focus-visible,body main button:focus-visible{outline:2px solid #3c78dc;outline-offset:2px}
body main .primary:not(:disabled),body main button:not(.secondary):not(.pvs-advanced-toggle):not([disabled]){transition:filter .15s ease}
body main .primary:not(:disabled):hover,body main button:not(.secondary):not(.pvs-advanced-toggle):not([disabled]):hover{filter:brightness(1.08)}
body main .workflow-nav,body main .workflow-tools{border-color:#dce5f0}
@media(max-width:720px){
 .pvs-global-header-inner{padding:10px 13px;gap:10px}
 .pvs-project-context{padding:5px 13px 10px;flex-wrap:wrap;gap:6px}
 .pvs-global-brand{font-size:14px}
 .pvs-global-monogram{width:32px;height:32px;font-size:17px}
 .pvs-global-nav{width:100%;display:flex;overflow-x:auto;flex-wrap:nowrap;scrollbar-width:thin;gap:2px}
 .pvs-global-nav a{padding:8px 10px;font-size:12px}
}
`;
