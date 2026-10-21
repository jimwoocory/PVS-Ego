import type {IncomingMessage,ServerResponse} from 'node:http';
import type {ResearchEvidenceReader,EvidenceInspection} from '../application/services/research-evidence-reader.js';
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const messages:Record<string,string>={CAPTURE_UNAVAILABLE:'此证据没有保存正文回执。',CAPTURE_UNSUPPORTED:'此来源的正文格式暂不支持核验。',ARTIFACT_UNAVAILABLE:'保存的正文文件尚不可用。',PATH_DENIED:'正文文件不属于当前研究目录。',FILE_MISSING:'保存的正文文件缺失。',FILE_TOO_LARGE:'正文文件超出本次核验大小上限。',ARTIFACT_CHANGED:'正文文件与原文件哈希不一致。',DOCUMENT_INVALID:'正文文件格式不符合原回执。',EVIDENCE_MISMATCH:'正文内容与原证据回执不一致。'};
function local(req:IncomingMessage){
 const host=req.headers.host??'';if(!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)||req.headers['sec-fetch-site']==='cross-site')return false;
 if(req.headers.origin){try{const u=new URL(req.headers.origin),protocol=(req.socket as typeof req.socket&{encrypted?:boolean}).encrypted?'https:':'http:';if(u.origin!==protocol+'//'+host)return false;}catch{return false;}}
 return true;
}
function render(result:EvidenceInspection,projectId:string){
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已保存的研究正文</title><style>body{font:16px/1.7 system-ui;margin:0;background:#f3f6fa;color:#182c45}main{max-width:900px;margin:24px auto;padding:24px;background:white;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7fb;padding:16px}dl{overflow-wrap:anywhere}dt{font-weight:bold}dd{margin:0 0 12px}a{color:#195bb1}.notice{padding:16px;background:#fff8e7}h1{line-height:1.3}</style><main><a href="/projects/${encodeURIComponent(projectId)}/research">返回研究证据</a><h1>已保存的研究正文</h1>${result.status==='VERIFIED'?`<p role="status">正文与文件完整性已核验</p><h2>${escape(result.title)}</h2><div class="notice">这里只核验保存文件与证据回执的一致性。来源事实尚未核实，未调用模型，未采用产品事实。</div><dl><dt>原始来源</dt><dd>${escape(result.sourceUrl)}</dd><dt>最终来源</dt><dd>${escape(result.finalUrl)}</dd><dt>采集时间</dt><dd>${escape(result.fetchedAt)}</dd><dt>正文范围</dt><dd>${result.truncated?'截断正文，未覆盖完整页面':'本次保存的正文未标记截断'}</dd><dt>截图</dt><dd>本页未核验截图</dd><dt>文件 SHA256</dt><dd>${escape(result.artifactSha256)}</dd><dt>正文内容哈希</dt><dd>${escape(result.contentHash)}</dd></dl><h2>采集时保存的正文</h2><pre aria-label="已保存正文">${escape(result.text)}</pre>`:`<p role="alert">证据暂不可核验</p><p>${escape(messages[result.code]??'原证据核验未通过。')}</p><p>已保留原记录，没有重新采集、修复文件或生成摘要。</p>`}</main></html>`;
}
export async function handleResearchEvidenceHttp(req:IncomingMessage,res:ServerResponse,url:URL,deps:{researchEvidence?:ResearchEvidenceReader;productFlow:{getProject(id:string):Promise<unknown>}}){
 const route=url.pathname.match(/^(\/api)?\/projects\/([^/]+)\/research\/runs\/([^/]+)\/evidence\/([^/]+)$/);if(!route)return false;
 res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
 const json=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
 if(!local(req)){json(403,{error:'ORIGIN_REJECTED'});return true;}
 if(req.method!=='GET'){res.setHeader('allow','GET');json(405,{error:'READ_ONLY'});return true;}
 let ids:string[];try{ids=route.slice(2).map(v=>decodeURIComponent(v!));}catch{json(404,{error:'EVIDENCE_NOT_FOUND'});return true;}
 const [projectId,runId,evidenceId]=ids as [string,string,string];
 if(!await deps.productFlow.getProject(projectId)){json(404,{error:'EVIDENCE_NOT_FOUND'});return true;}
 if(!deps.researchEvidence){json(503,{error:'EVIDENCE_READER_NOT_CONFIGURED'});return true;}
 const result=await deps.researchEvidence.inspect(projectId,runId,evidenceId);if(!result){json(404,{error:'EVIDENCE_NOT_FOUND'});return true;}
 const status=result.status==='VERIFIED'?200:409;
 if(route[1])json(status,{result});else{res.writeHead(status,{'content-type':'text/html; charset=utf-8'});res.end(render(result,projectId));}
 return true;
}
