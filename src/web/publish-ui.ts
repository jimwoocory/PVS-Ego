
import type { ProjectWorkspace } from "../application/services/product-flow.js";
import { pvsGlobalStyles, renderPvsGlobalHeader, renderPvsMobileHandoffHeader } from "./pvs-global-shell.js";
import type { PublishProviderProbe } from "../application/ports/publish-provider.js";
import type { PublicPublishPackage } from "../application/services/publish-bridge-service.js";
import type { PublishPreference, PublishReceipt } from "../domain/publish.js";
import {renderBrowserPublishPreflightPanel} from "./browser-publish-preflight-ui.js";
import type {BrowserPublishCheckpoint} from "../application/ports/browser-publish-preparation.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function providerLabel(type: string): string {
  if (type === "DOUYIN_BROWSER_AUTOMATION") return "抖音浏览器辅助发布（人机协作）";
  if (type === "DOUYIN_SDK_HANDOFF") return "抖音 Open SDK 唤起发布";
  if (type === "DOUYIN_H5_HANDOFF") return "抖音 H5 扫码投稿";
  if (type === "DOUYIN_OPENAPI_DIRECT") return "抖音 OpenAPI 直发";
  return "下载 MP4 / 手动发布";
}

function probeLabel(code: PublishProviderProbe["code"]): string {
  if (code === "READY") return "可用";
  if (code === "DISABLED") return "未启用";
  if (code === "NOT_CONFIGURED") return "未配置";
  if (code === "AUTH_REQUIRED") return "需要授权 / 能力确认";
  return "不可用";
}

function modeLabel(mode: PublishProviderProbe["mode"]): string {
  if (mode === "DIRECT") return "平台直发";
  if (mode === "HANDOFF") return "手机 / 平台交接";
  return "手动导出";
}

function capabilitySummary(probes: PublishProviderProbe[]): string {
  const ready = probes.filter((probe) => probe.code === "READY");
  const manual = probes.find((probe) => probe.providerType === "MANUAL_EXPORT");
  const externalReady = ready.filter(
    (probe) => probe.providerType !== "MANUAL_EXPORT"
  );
  return `<section class="card"><h3>发布能力状态</h3>
    <p><b>当前可用：${ready.length}/${probes.length}</b> · 外部发布通道可用 ${externalReady.length} 个</p>
    <p class="muted">${manual?.code === "READY"
      ? "最终 MP4 的下载 / 手动发布兜底已就绪；即使浏览器辅助发布或官方发布通道暂不可用，也不会阻断成片交付。"
      : "手动导出异常，请先恢复最终 MP4 下载能力。"}</p>
  </section>`;
}

function statusLabel(status: PublicPublishPackage["status"]): string {
  if (status === "PACKAGE_READY") return "等待手机领取";
  if (status === "HANDOFF_STARTED") return "交接已开始";
  if (status === "AWAITING_USER_ACTION") return "已交给抖音/移动端，等待用户完成发布";
  if (status === "DIRECT_PUBLISHING") return "正在执行平台发布";
  if (status === "SUBMISSION_UNKNOWN") return "发布结果未知，请人工核对，禁止重提";
  if (status === "HANDOFF_COMPLETED") return "交接完成，未确认最终发布";
  if (status === "PUBLISHED_CONFIRMED") return "平台可信回执已确认发布";
  if (status === "FAILED") return "失败";
  return "已过期";
}

export function renderPublishSettingsPage(input: {
  workspace: ProjectWorkspace;
  preference: PublishPreference;
  probes: PublishProviderProbe[];
}): string {
  const browserProbe = input.probes.find(
    (probe) => probe.providerType === "DOUYIN_BROWSER_AUTOMATION"
  );
  const browserLogin = browserProbe
    ? "<section class=\"card\"><h3>抖音账号</h3><p><b>" +
      esc(browserProbe.accountDisplayName ?? "抖音账号") +
      "</b> · " +
      esc(probeLabel(browserProbe.code)) +
      "</p>" +
      (browserProbe.platformUserId
        ? "<p class=\"muted\">抖音号：" + esc(browserProbe.platformUserId) + "</p>"
        : "") +
      "<p class=\"muted\">首次使用或登录过期时，点击按钮后会弹出 Chromium 浏览器，请用抖音扫码登录。</p><p><button class=\"secondary\" id=\"douyin-browser-login\">" +
      (browserProbe.code === "READY" ? "重新登录抖音" : "登录抖音") +
      "</button></p><div id=\"douyin-browser-login-status\" class=\"muted\"></div></section>"
    : "";
  const cards = input.probes.map((probe) => {
    const selected = input.preference.providerType === probe.providerType;
    return "<label class=\"provider " + (selected ? "selected" : "") + "\">" +
      "<div><input type=\"radio\" name=\"provider\" value=\"" + esc(probe.providerType) + "\"" + (selected ? " checked" : "") + "> " +
      "<b>" + esc(probe.displayName) + "</b> <span class=\"badge\">" + esc(probeLabel(probe.code)) + "</span> <span class=\"badge\">" + esc(modeLabel(probe.mode)) + "</span></div>" +
      (probe.accountDisplayName ? "<p class=\"muted\">账号：" + esc(probe.accountDisplayName) + "</p>" : "") +
      (probe.platformUserId ? "<p class=\"muted\">抖音号：" + esc(probe.platformUserId) + "</p>" : "") +
      (probe.reason ? "<p class=\"danger\">" + esc(probe.reason) + "</p>" : "") +
      (probe.complianceNotice ? "<p class=\"muted\">" + esc(probe.complianceNotice) + "</p>" : "") +
      "<p class=\"muted\">" + (probe.supportsTrustedFinalConfirmation ? "可提供可信最终回执" : "交接本身不能证明最终发布") + "</p>" +
      "</label>";
  }).join("");
  const projectId = JSON.stringify(input.workspace.project.id);
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>发布设置</title><style>:root{font-family:Inter,\"Microsoft YaHei\",system-ui,sans-serif;background:#f5f5f3;color:#171717}*{box-sizing:border-box}body{margin:0}.wrap{max-width:920px;margin:auto;padding:24px}.card,.provider{display:block;background:white;border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}.provider.selected{border:2px solid #171717}.badge{background:#eee;border-radius:999px;padding:4px 8px;font-size:12px}.muted{color:#707070;font-size:13px}.danger{color:#8a1f11}.primary,.secondary{border-radius:9px;padding:10px 14px;font-weight:700}.primary{border:0;background:#171717;color:white}.secondary{border:1px solid #bbb;background:white;color:#171717;text-decoration:none}" + pvsGlobalStyles + "</style></head><body>" + renderPvsGlobalHeader("studio", { project: { id: input.workspace.project.id, name: input.workspace.project.name } }) + "<main class=\"wrap\">" +
    "<p><a class=\"secondary\" href=\"/projects/" + esc(input.workspace.project.id) + "/final\">← 返回成片与发布</a></p>" +
    "<section class=\"card\"><h2>发布方式</h2><p class=\"muted\">当前主发布路径为“抖音浏览器辅助发布（人机协作）”，使用本机已登录的创作者中心；平台可能要求验证码或用户接管。该路径不代表取得官方后台直发资格，也不承诺免验证。下载 MP4 手动发布始终保留。</p><p class=\"muted\">浏览器点击发布也不直接等于“已发布”；系统只有在作品管理页再次确认到本次作品时才写入可信发布结果。</p></section>" +
    capabilitySummary(input.probes) +
    browserLogin +
    cards +
    "<p><button class=\"primary\" id=\"save\">保存发布方式</button></p><div id=\"error\" class=\"danger\"></div></main>" +
    "<script>(()=>{const projectId=" + projectId + ";const login=document.querySelector('#douyin-browser-login');if(login)login.addEventListener('click',async()=>{const status=document.querySelector('#douyin-browser-login-status');login.disabled=true;status.textContent='正在打开抖音登录浏览器，请扫码完成登录…';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/douyin-browser/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||j.login?.message);status.textContent='登录成功，正在刷新状态…';location.reload();}catch(err){status.textContent=err.message||String(err);login.disabled=false;}});document.querySelector('#save').addEventListener('click',async()=>{const selected=document.querySelector('input[name=provider]:checked');if(!selected)return;const b=document.querySelector('#save'),e=document.querySelector('#error');b.disabled=true;e.textContent='';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/provider',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerType:selected.value})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}catch(err){e.textContent=err.message||String(err);b.disabled=false;}});})();</script></body></html>";
}

export function renderPublishCenter(input: {
  projectId: string;
  projectName: string;
  acceptedFinal: boolean;
  preference: PublishPreference;
  probes: PublishProviderProbe[];
  packages: PublicPublishPackage[];
  receipts: PublishReceipt[];
  browserPreparationSupported?:boolean;
  browserCheckpoints?:Array<BrowserPublishCheckpoint|null>;
}): string {
  if (!input.acceptedFinal) {
    return "<section class=\"card\"><h3>发布中心</h3><p class=\"muted\">先生成或恢复一个可校验、可下载，并已确认的最终 MP4，才能创建发布包。发布资质不会替代成片完整性检查。</p></section>";
  }
  const selected = input.probes.find((probe) => probe.providerType === input.preference.providerType);
  const direct = selected?.mode === "DIRECT";
  const accountId = selected?.platformUserId?.trim() ?? "";
  const ready = selected?.code === "READY" && (!direct || !!accountId);
  const browserSelected = input.preference.providerType === "DOUYIN_BROWSER_AUTOMATION";
  const openApiSelected = input.preference.providerType === "DOUYIN_OPENAPI_DIRECT";
  const manualSelected = input.preference.providerType === "MANUAL_EXPORT";
  const manual = input.probes.find((probe) => probe.providerType === "MANUAL_EXPORT");
  const manualFallback =
    !ready && manual?.code === "READY" && !manualSelected
      ? "<p class=\"muted\">当前选择的外部发布方式暂不可用，但不会阻断成片交付。</p><p><button class=\"secondary\" id=\"p1-manual-fallback\">切换到下载 MP4 / 手动发布</button></p>"
      : manualSelected
        ? "<p class=\"muted\">手动发布不需要平台 API。你可以直接使用上方“下载成片 MP4”；一次性发布包仅用于安全地把成片交给手机。</p>"
        : "";
  const browserProbe = input.probes.find(
    (probe) => probe.providerType === "DOUYIN_BROWSER_AUTOMATION"
  );
  const browserPanel = browserSelected && browserProbe
    ? "<div class=\"clip\"><b>抖音账号：</b>" +
      esc(browserProbe.accountDisplayName ?? "抖音账号") +
      " · " +
      esc(probeLabel(browserProbe.code)) +
      (browserProbe.platformUserId
        ? "<p class=\"muted\">抖音号：" + esc(browserProbe.platformUserId) + "</p>"
        : "") +
      "<p><button class=\"secondary\" id=\"p1-douyin-login\">" +
      (browserProbe.code === "READY" ? "重新登录抖音" : "登录抖音") +
      "</button></p><div id=\"p1-douyin-login-status\" class=\"muted\"></div></div>"
    : "";
  const overview = input.probes.map((probe) =>    "<div class=\"clip\"><b>" + esc(probe.displayName) + "</b> · " + esc(probeLabel(probe.code)) +
      " · " + esc(modeLabel(probe.mode)) +
      (probe.reason ? "<p class=\"muted\">" + esc(probe.reason) + "</p>" : "") +
    "</div>"
  ).join("");
  const history = input.packages.length ? input.packages.slice().reverse().map((pkg) => {
    const count = input.receipts.filter((r) => r.packageId === pkg.id).length;
    return "<div class=\"clip\"><b>" + esc(providerLabel(pkg.providerType)) + " · " + esc(statusLabel(pkg.status)) + "</b>" +
      "<p class=\"muted\">" + esc(pkg.titleDraft) + " · " + esc(pkg.expiresAt) + "</p>" +
      (pkg.errorMessage ? "<p class=\"danger\">" + esc(pkg.errorMessage) + "</p>" : "") +
      "<p class=\"technical hash\">package=" + esc(pkg.id) + "<br>receipts=" + count + "</p></div>";
  }).join("") : "<p class=\"muted\">还没有发布记录。</p>";
  const oauth = openApiSelected && selected && (selected.code === "AUTH_REQUIRED" || selected.code === "NOT_CONFIGURED")
    ? "<p><a class=\"secondary\" href=\"/api/projects/" + esc(input.projectId) + "/publish/douyin/oauth/start\">连接 / 重新授权抖音 OpenAPI</a></p>"
    : "";
  const projectId = JSON.stringify(input.projectId);
  const directFlag = direct ? "true" : "false";
  const browserFlag = browserSelected ? "true" : "false";
  const expectedAccountId = JSON.stringify(accountId).replace(/</g, "\\u003c");
  const directConfirmation = browserSelected&&input.browserPreparationSupported
    ? '<div id="p1-direct" hidden><p>发布包已创建，尚未上传或提交。请刷新进入分阶段预检。</p><button type="button" onclick="location.reload()">查看本次预检</button></div>' : browserSelected
    ? "<div id=\"p1-direct\" hidden><p class=\"danger\"><b>这是浏览器辅助发布，需要人机协作。确认后会上传成片、填写文案并按本次授权尝试提交。</b></p><p class=\"muted\">平台可能要求验证码或用户接管，不承诺免验证。只有在作品管理页核实本次作品才标记已发布；结果无法确认时保留原任务，禁止自动重试、换引擎重发或把手工关联当作发布成功。</p><label><input id=\"p1-direct-confirm\" type=\"checkbox\"> 我明确确认本次发布到抖音</label><p><button class=\"primary\" id=\"p1-direct-go\">确认本次辅助发布</button></p><div id=\"p1-direct-error\" class=\"danger\"></div></div>"
    : "<div id=\"p1-direct\" hidden><p class=\"danger\"><b>抖音 OpenAPI 直发会直接提交平台。</b></p><label><input id=\"p1-direct-confirm\" type=\"checkbox\"> 我明确确认本次直发</label><p><button class=\"primary\" id=\"p1-direct-go\">确认直发</button></p><div id=\"p1-direct-error\" class=\"danger\"></div></div>";
  return capabilitySummary(input.probes) +
    "<section class=\"card\" id=\"publish-center\"><h3>发布中心</h3>" +
    "<p><b>当前发布方式：</b>" + esc(selected?.displayName ?? providerLabel(input.preference.providerType)) + " · " + esc(selected ? probeLabel(selected.code) : "未知") + "</p>" +
    (selected?.reason ? "<p class=\"danger\">" + esc(selected.reason) + "</p>" : "") +
    (selected?.complianceNotice ? "<p class=\"muted\">" + esc(selected.complianceNotice) + "</p>" : "") +
    browserPanel +
    (direct ? "<p class=\"muted\">本次发布账号 ID：<b>" + esc(accountId || "尚未取得，请重新登录或授权并刷新状态") + "</b>。确认发布仅适用于此账号。</p>" : "") +
    manualFallback +
    "<details><summary>查看全部发布能力</summary>" + overview + "</details>" +
    "<p><a class=\"secondary\" href=\"/projects/" + esc(input.projectId) + "/publish-settings\">发布设置 / 切换发布方式</a></p>" + oauth +
    "<div class=\"row\"><label class=\"field\">发布标题<input id=\"p1-title\" maxlength=\"100\" value=\"" + esc(input.projectName) + "\"></label></div>" +
    "<label class=\"field\">描述 / 话题<textarea id=\"p1-desc\" placeholder=\"可选\"></textarea></label>" +
    "<p><button class=\"primary\" id=\"p1-create\" " + (ready ? "" : "disabled") + ">" + (browserSelected ? "创建抖音发布任务" : direct ? "创建直发发布包" : manualSelected ? "创建手机领取包（可选）" : "创建一次性发布包 / 手机二维码") + "</button></p>" +
    "<div id=\"p1-error\" class=\"danger\"></div><div id=\"p1-result\"></div>" +
    directConfirmation +
    (browserSelected&&(input.browserPreparationSupported||input.browserCheckpoints?.some(Boolean))?renderBrowserPublishPreflightPanel({projectId:input.projectId,accountId,packages:input.packages,checkpoints:input.browserCheckpoints??[]}):"")+
    "<details><summary>发布记录（" + input.packages.length + "）</summary>" + history + "</details>" +
    "<p class=\"muted\">“交接完成”不等于“已发布”。只有可信平台回执才会把项目标记为已发布。</p></section>" +
    "<script>(()=>{const projectId=" + projectId + ",direct=" + directFlag + ",browser=" + browserFlag + ",expectedAccountId=" + expectedAccountId + ";let packageId='';const login=document.querySelector('#p1-douyin-login');if(login)login.addEventListener('click',async()=>{const status=document.querySelector('#p1-douyin-login-status');login.disabled=true;status.textContent='正在打开抖音登录浏览器，请扫码完成登录…';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/douyin-browser/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error||j.login?.message);status.textContent='登录成功，正在刷新状态…';location.reload();}catch(err){status.textContent=err.message||String(err);login.disabled=false;}});const fallback=document.querySelector('#p1-manual-fallback');if(fallback)fallback.addEventListener('click',async()=>{fallback.disabled=true;try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/provider',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerType:'MANUAL_EXPORT'})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}catch(err){document.querySelector('#p1-error').textContent=err.message||String(err);fallback.disabled=false;}});const create=document.querySelector('#p1-create');if(create)create.addEventListener('click',async()=>{const e=document.querySelector('#p1-error'),o=document.querySelector('#p1-result');create.disabled=true;e.textContent='';o.innerHTML='';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/packages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('#p1-title').value,description:document.querySelector('#p1-desc').value})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);packageId=j.package.id;if(direct){document.querySelector('#p1-direct').hidden=false;o.innerHTML='<div class=\"clip\"><b>'+(browser?'抖音发布任务已准备':'直发发布包已创建')+'</b><p class=\"muted\">还需要再次明确确认，确认后才会真正提交平台。</p></div>';}else{o.innerHTML='<div class=\"clip\"><b>一次性发布包已创建</b><p class=\"muted\">二维码只在本次创建后显示；刷新后需重新创建发布包。</p><div class=\"publish-qr\">'+j.qrSvg+'</div><p><a class=\"secondary\" target=\"_blank\" rel=\"noopener\" href=\"'+j.claimUrl+'\">打开手机领取页</a></p></div>';}}catch(err){e.textContent=err.message||String(err);create.disabled=false;}});const go=document.querySelector('#p1-direct-go');if(go)go.addEventListener('click',async()=>{if(!document.querySelector('#p1-direct-confirm').checked){alert(browser?'请先确认本次抖音发布内容':'请先明确确认直发');return;}if(!packageId)return;if(!expectedAccountId){alert('请先刷新并确认发布账号');return;}go.disabled=true;const e=document.querySelector('#p1-direct-error');if(browser)e.textContent='正在打开 Chromium 并执行抖音发布，请不要关闭弹出的浏览器…';try{const r=await fetch('/api/projects/'+encodeURIComponent(projectId)+'/publish/packages/'+encodeURIComponent(packageId)+'/direct',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,expectedAccountId})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);location.reload();}catch(err){e.textContent=err.message||String(err);go.disabled=false;}});})();</script>";
}

export function renderMobilePublishPage(packageId: string): string {
  const id = JSON.stringify(packageId);
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\"><title>手机发布交接</title><style>:root{font-family:Inter,\"Microsoft YaHei\",system-ui,sans-serif;background:#f4f4f2;color:#171717}*{box-sizing:border-box}body{margin:0}.wrap{max-width:620px;margin:auto;padding:18px}.card{background:white;border:1px solid #ddd;border-radius:14px;padding:18px;margin:12px 0}.primary,.secondary{display:inline-block;border-radius:10px;padding:12px 16px;font-weight:700;text-decoration:none}.primary{border:0;background:#171717;color:white}.secondary{border:1px solid #bbb;background:white;color:#171717}.muted{color:#707070;font-size:13px}.danger{color:#8a1f11}.status{background:#f4f4ef;padding:10px;border-radius:9px}" + pvsGlobalStyles + "</style></head><body>" + renderPvsMobileHandoffHeader() + "<main class=\"wrap\"><section class=\"card\"><h2>Product Video Studio</h2><p>手机发布交接</p><p class=\"muted\">领取凭证只能使用一次；领取后立即失效，并切换为短时安全会话。</p></section><section class=\"card\" id=\"content\">正在读取发布包…</section></main>" +
    "<script>(()=>{const packageId=" + id + ",key='pvs-publish-session:'+packageId,box=document.querySelector('#content');const clean=s=>String(s||'').replace(/[<>&]/g,'');const api=async(path,opts={})=>{const session=sessionStorage.getItem(key)||'',headers={...(opts.headers||{})};if(session)headers.authorization='Bearer '+session;const r=await fetch('/api/publish/packages/'+encodeURIComponent(packageId)+path,{...opts,headers});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);return j;};const providerName=s=>s==='DOUYIN_SDK_HANDOFF'?'抖音 SDK 唤起发布':s==='DOUYIN_H5_HANDOFF'?'抖音 H5 扫码投稿':s==='DOUYIN_OPENAPI_DIRECT'?'抖音 OpenAPI 直发':'下载 MP4 / 手动发布';const label=s=>s==='PACKAGE_READY'?'发布包已领取':s==='AWAITING_USER_ACTION'?'已交给抖音/移动端，请在抖音完成最终发布':s==='HANDOFF_COMPLETED'?'交接完成，但未确认最终发布':s==='PUBLISHED_CONFIRMED'?'平台可信回执已确认发布':s;const render=p=>{box.innerHTML='<h3>'+clean(p.titleDraft)+'</h3><p class=\"status\"><b>'+clean(label(p.status))+'</b></p><p class=\"muted\">发布方式：'+clean(providerName(p.providerType))+'<br>有效期：'+clean(p.expiresAt)+'</p>'+((p.status==='PACKAGE_READY'||p.status==='HANDOFF_STARTED'||p.status==='AWAITING_USER_ACTION')?'<p><button class=\"primary\" id=\"start\">开始交接 / 打开发布流程</button></p>':'')+((p.status==='HANDOFF_STARTED'||p.status==='AWAITING_USER_ACTION')?'<p><button class=\"secondary\" id=\"complete\">我已完成交接（不代表已发布）</button></p>':'')+'<div id=\"handoff\"></div>';document.querySelector('#start')?.addEventListener('click',start);document.querySelector('#complete')?.addEventListener('click',complete);};const claim=async token=>{const r=await fetch('/api/publish/packages/'+encodeURIComponent(packageId)+'/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})});const j=await r.json();if(!r.ok)throw new Error(j.message||j.error);sessionStorage.setItem(key,j.sessionToken);history.replaceState(null,'',location.pathname);render(j.package);};const start=async()=>{try{const j=await api('/handoff/start',{method:'POST'});render(j.package);if(j.handoff.launchUrl)document.querySelector('#handoff').innerHTML='<p>'+clean(j.handoff.instruction)+'</p><p><a class=\"primary\" href=\"'+String(j.handoff.launchUrl)+'\">打开发布流程</a></p>';}catch(err){box.insertAdjacentHTML('beforeend','<p class=\"danger\">'+clean(err.message||err)+'</p>');}};const complete=async()=>{try{const j=await api('/handoff/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({note:'用户确认交接动作完成；不作为最终发布确认。'})});render(j.package);}catch(err){box.insertAdjacentHTML('beforeend','<p class=\"danger\">'+clean(err.message||err)+'</p>');}};(async()=>{try{const token=new URLSearchParams(location.hash.slice(1)).get('token');if(token){await claim(token);return;}const session=sessionStorage.getItem(key);if(!session)throw new Error('领取链接已失效或缺少一次性凭证，请从电脑端重新创建发布包并扫码。');render((await api('',{method:'GET'})).package);}catch(err){box.innerHTML='<p class=\"danger\">'+clean(err.message||err)+'</p>';}})();})();</script></body></html>";
}
