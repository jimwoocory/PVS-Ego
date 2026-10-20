import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProductFlowService } from "../application/services/product-flow.js";
import type { AutoEditService } from "../application/services/auto-edit-service.js";
import type { ArtifactRepository } from "../application/ports/artifact-repository.js";
import type { TimelineService } from "../application/services/timeline-service.js";
import { AutoEditBlocked, postProductionSettingsSchema } from "../domain/auto-edit.js";
import { LocalArtifactStore } from "../adapters/store/local-artifact-store.js";
import { inspectMedia } from "../adapters/media/inspect-media.js";
import { renderPostProductionControls, postProductionBrowserScript } from "./post-production-ui.js";
import { pvsGlobalStyles, renderPvsGlobalHeader } from "./pvs-global-shell.js";
import { BUILTIN_BGM_LIBRARY, builtinBgmArtifactId, renderBuiltinBgmWav } from "../application/services/builtin-bgm-library.js";
const escaped = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const send = (res: ServerResponse, code: number, value: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
async function readBody(req: IncomingMessage, maximum = 200_000) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > maximum) throw new AutoEditBlocked("REQUEST_TOO_LARGE", "请求文件过大"); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new AutoEditBlocked("INVALID_JSON", "请求格式无效"); }
}

async function ensureBuiltinBgmAssets(input: {
  projectId: string;
  projectsRoot: string;
  artifacts: ArtifactRepository;
}) {
  const root = path.resolve(input.projectsRoot, input.projectId);
  const store = new LocalArtifactStore(root, input.artifacts);
  const result: Array<{
    id: string;
    sha256?: string;
    name: string;
    mimeType: string;
    source: "BUILTIN_BGM";
  }> = [];
  for (const def of BUILTIN_BGM_LIBRARY) {
    const id = builtinBgmArtifactId(input.projectId, def.key);
    let artifact = await input.artifacts.findById(id);
    if (!artifact) {
      artifact = await store.writeImmutable({
        id,
        projectId: input.projectId,
        kind: "OTHER",
        immutable: true,
        relativePath: "post-production/bgm-library/" + def.filename,
        bytes: renderBuiltinBgmWav(def),
        mimeType: "audio/wav"
      });
    }
    if (artifact.projectId !== input.projectId || artifact.integrityStatus !== "READY") continue;
    result.push({
      id: artifact.id,
      sha256: artifact.sha256,
      name: def.label,
      mimeType: artifact.mimeType ?? "audio/wav",
      source: "BUILTIN_BGM"
    });
  }
  return result;
}

export async function handleAutoEditHttp(req: IncomingMessage, res: ServerResponse, url: URL, d: {
  autoEdit?: AutoEditService; productFlow: ProductFlowService; artifacts: ArtifactRepository; timeline: TimelineService; projectsRoot: string
}): Promise<boolean> {
  const page = url.pathname.match(/^\/projects\/([^/]+)\/auto-edit$/);
  const action = url.pathname.match(/^\/api\/projects\/([^/]+)\/(auto-edit|post-production)(?:\/(audio))?$/);
  const audioEdit = url.pathname.match(/^\/api\/projects\/([^/]+)\/timeline\/audio\/([^/]+)$/);
  if (!page && !action && !audioEdit) return false;
  if (!d.autoEdit) { send(res, 503, { message: "自动剪辑服务尚未配置" }); return true; }
  const projectId = decodeURIComponent((page ?? action ?? audioEdit)![1]!);
  const w = await d.productFlow.getWorkspace(projectId);
  if (!w) { send(res, 404, { message: "项目不存在" }); return true; }
  try {
    if (audioEdit && req.method === "POST") {
      const input = z.object({ expectedHash: z.string().regex(/^[a-f0-9]{64}$/i), inMs: z.number().int().nonnegative().optional(),
        outMs: z.number().int().positive().optional(), startMs: z.number().int().nonnegative().optional(), volume: z.number().min(0).max(2).optional(),
        muted: z.boolean().optional(), deleted: z.boolean().optional(), clearKeyframes: z.boolean().optional() }).strict().parse(await readBody(req));
      send(res, 200, { timeline: await d.timeline.updateAudioItem(projectId, decodeURIComponent(audioEdit[2]!), input) }); return true;
    }
    if (page && req.method === "GET") {
      const current = await d.timeline.latestTimeline(projectId);
      const data = { projectId, planHash: w.productionPlan?.contentHash, replaceTimeline: current && current.status !== "STALE" ? { id: current.id, hash: current.contentHash } : null };
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自动剪辑 · ${escaped(w.project.name)}</title><style>body{font:16px/1.6 system-ui;background:#f5f6f8;color:#17212b;margin:0}main{max-width:1060px;margin:30px auto;padding:0 20px}.card{background:white;padding:24px;border:1px solid #d6dce2;border-radius:12px;margin:20px 0}.row{display:flex;gap:16px;flex-wrap:wrap}.field{display:flex;flex-direction:column;min-width:180px;flex:1}input,select,button{font:inherit}input[type=number]{max-width:160px}select{padding:9px;max-width:100%}button{padding:10px 16px;margin:12px 12px 0 0;cursor:pointer}button:disabled{opacity:.5}a{color:#245b91}.muted{color:#64717f;font-size:14px}.error{color:#a32323}.post-binding{border-bottom:1px solid #ddd;padding:12px 0}label{margin-right:10px}${pvsGlobalStyles}</style></head><body>${renderPvsGlobalHeader("studio", { project: { id: projectId, name: w.project.name } })}<main data-state="${escaped(JSON.stringify(data))}"><nav><a href="/projects/${encodeURIComponent(projectId)}/smart">一键成片</a> · <a href="/projects/${encodeURIComponent(projectId)}/generate">审片</a> · <a href="/projects/${encodeURIComponent(projectId)}/timeline">手工时间线</a></nav><h1>自动剪辑</h1><p>${escaped(w.project.name)}</p><p>按已确认分镜与已采用视频创建新的剪辑决策和时间线。保留原视频，不重提生成，不自动发布。</p><section class="card">
      ${renderPostProductionControls({ projectId, plan: w.productionPlan })}
      ${data.replaceTimeline ? '<p><label><input id="replace-timeline" type="checkbox"> 我明确同意创建新的自动时间线；当前手工版本保留为历史版本。</label></p>' : ""}
      <button id="run-auto-edit">生成自动剪辑草稿</button><p id="auto-edit-message" role="status"></p><pre id="auto-edit-warnings" style="white-space:pre-wrap"></pre><div id="auto-edit-next"></div></section></main>
      ${postProductionBrowserScript}<script>(()=>{const state=JSON.parse(document.querySelector('main').dataset.state),button=document.querySelector('#run-auto-edit'),message=document.querySelector('#auto-edit-message');button.addEventListener('click',async()=>{button.disabled=true;message.textContent='正在检查已采用素材、准备音轨并生成剪辑草稿…';try{if(state.replaceTimeline&&!document.querySelector('#replace-timeline').checked)throw new Error('已有时间线，请先明确确认创建新的自动版本。');const response=await fetch('/api/projects/'+encodeURIComponent(state.projectId)+'/auto-edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({settings:window.pvsReadPostProduction(document.querySelector('.post-production-settings')),expectedPlanHash:state.planHash,...(state.replaceTimeline?{replaceTimeline:state.replaceTimeline}:{})})});const data=await response.json();if(!response.ok)throw new Error(data.message||'自动剪辑失败');message.textContent='自动剪辑草稿已保存。进入时间线可微调并确认，然后渲染。';document.querySelector('#auto-edit-warnings').textContent=data.plan.warnings.join('\\n');const link=document.createElement('a');link.href='/projects/'+encodeURIComponent(state.projectId)+'/timeline';link.textContent='进入时间线检查与渲染';document.querySelector('#auto-edit-next').replaceChildren(link);}catch(error){message.textContent=error.message;button.disabled=false;}});})();</script></body></html>`);
      return true;
    }
    if (!action) { send(res, 405, { message: "不支持此操作" }); return true; }
    if (action[2] === "post-production" && !action[3] && req.method === "GET") {
      const builtinBgm = await ensureBuiltinBgmAssets({ projectId, projectsRoot: d.projectsRoot, artifacts: d.artifacts });
      const builtinIds = new Set(builtinBgm.map(item => item.id));
      const projectAudio = (await d.artifacts.listByProject(projectId))
        .filter(a => !builtinIds.has(a.id) && a.integrityStatus === "READY" && a.mimeType?.startsWith("audio/"))
        .map(a => ({ id: a.id, sha256: a.sha256, name: path.basename(a.relativePath), mimeType: a.mimeType, source: "PROJECT_AUDIO" as const }));
      const audioAssets = [...builtinBgm, ...projectAudio];
      const timeline = await d.timeline.latestTimeline(projectId);
      send(res, 200, { voices: await d.autoEdit.voices(), audioAssets, timeline: timeline ? { id: timeline.id, hash: timeline.contentHash, status: timeline.status, productionPlanHash: timeline.productionPlanHash } : null }); return true;
    }
    if (action[2] === "post-production" && action[3] === "audio" && req.method === "POST") {
      const input = z.object({ filename: z.string().min(1).max(240), base64: z.string().min(4).max(28_000_000) }).strict().parse(await readBody(req, 29_000_000));
      const ext = path.extname(input.filename).toLowerCase();
      const mime = ({ ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac" } as Record<string,string>)[ext];
      if (!mime || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new AutoEditBlocked("INVALID_AUDIO_UPLOAD", "请选择 WAV、MP3、M4A、AAC、OGG 或 FLAC 音频");
      const bytes = Buffer.from(input.base64, "base64"); if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new AutoEditBlocked("AUDIO_UPLOAD_LIMIT", "后期音频应大于0且不超过20MB");
      const id = randomUUID(), root = path.resolve(d.projectsRoot, projectId), directory = path.join(root, ".tmp", "audio-upload-" + id);
      await fs.mkdir(directory, { recursive: true });
      try {
        const file = path.join(directory, "audio" + ext); await fs.writeFile(file, bytes, { flag: "wx" });
        const media = await inspectMedia(file); if (!media.hasAudio || media.hasVideo || media.durationMs > 600_000) throw new AutoEditBlocked("INVALID_AUDIO_UPLOAD", "文件必须是10分钟以内的纯音频");
        const name = path.basename(input.filename).replace(/[^\p{L}\p{N}._-]/gu, "_");
        const artifact = await new LocalArtifactStore(root, d.artifacts).writeImmutable({ id, projectId, kind: "OTHER", immutable: true,
          relativePath: "post-production/uploads/" + id + "-" + name, bytes, mimeType: mime });
        send(res, 201, { artifact, media });
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
      return true;
    }
    if (action[2] === "auto-edit" && !action[3] && req.method === "POST") {
      const input = z.object({ settings: postProductionSettingsSchema, expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/i),
        replaceTimeline: z.object({ id: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().optional() }).strict().parse(await readBody(req));
      send(res, 201, await d.autoEdit.create({ projectId, ...input })); return true;
    }
    send(res, 405, { message: "不支持此操作" }); return true;
  } catch (error) {
    if (error instanceof AutoEditBlocked || error instanceof z.ZodError) {
      send(res, 400, { code: error instanceof AutoEditBlocked ? error.code : "INVALID_INPUT", message: error.message }); return true;
    }
    throw error;
  }
}
