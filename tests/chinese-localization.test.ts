import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import http from "node:http";
import { localizeWorkbenchHtml, translateUiText, installChineseResponse } from "../src/web/chinese-response.js";

test("Chinese options retain all API enum values and user input bytes", () => {
  const source=`<html><body><h1>Product Video Studio</h1><select name="purpose"><option value="CTA">CTA</option></select><select name="audio"><option value="DIALOGUE">DIALOGUE</option><option value="NONE">NONE</option></select><input name="brand" value="ACME HARD" placeholder="Purpose"><textarea>HARD &amp; Product Truth</textarea><pre>Original Prompt: HARD</pre><code>requestId=ACME</code><script>const payload={purpose:"CTA",kind:"DIALOGUE"};</script></body></html>`;
  const html=localizeWorkbenchHtml(source);
  assert.match(html, /<option value="CTA">引导用户行动（如咨询、购买）<\/option>/);
  assert.match(html, /<option value="DIALOGUE">人物对白<\/option>/);
  assert.match(html, /value="ACME HARD"/);
  assert.match(html, /<textarea>HARD &amp; Product Truth<\/textarea>/);
  assert.match(html, /<pre>Original Prompt: HARD<\/pre>/);
  assert.match(html, /const payload=\{purpose:"CTA",kind:"DIALOGUE"\}/);
  assert.match(html, /placeholder="段落用途"/);
  assert.match(html, /data-pvs-locale="zh-CN"/);
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  for(const script of scripts)assert.doesNotThrow(()=>new Script(script[1]!));
});

test("new workflows, continuity, audio and publishing vocabulary explain their actual meaning",()=>{
  for(const [raw,chinese] of Object.entries({HARD:"严格禁止修改",SOFT:"尽量保持不变",NARRATION:"旁白解说",AMBIENT:"有环境音",OFFSCREEN:"画外音",HARD_CONTINUITY:"强连续：必须承接上一片段",SAME_SCENE_CUT:"同场景切换机位",SCENE_OR_TIME_JUMP:"场景或时间跳转",FIRST_FRAME:"专用首帧",REFERENCE_IMAGE:"普通参考图片",CROSSFADE:"交叉叠化",DOUYIN_BROWSER_AUTOMATION:"抖音浏览器自动发布",READY_FOR_PAID_CONFIRM:"等待视频生成费用确认"}))assert.equal(translateUiText(raw),chinese);
  assert.equal(translateUiText("产品 · HIGH · 10s"),"产品 · 高风险 · 10 秒");
  assert.equal(translateUiText("seedance2.0mini / OpenAI / ACME"),"seedance2.0mini / OpenAI / ACME");
});

test("localization is idempotent and skips technical or serialized content",()=>{
  const html=localizeWorkbenchHtml('<html><body><div data-state="{&quot;kind&quot;:&quot;NONE&quot;}">Product Truth</div><script>if(1<2){document.body.dataset.value="HARD";}</script></body></html>');
  assert.equal(localizeWorkbenchHtml(html),html);
  assert.match(html,/data-state="\{&quot;kind&quot;:&quot;NONE&quot;\}"/);
  assert.match(html,/if\(1<2\)\{document.body.dataset.value="HARD";\}/);
});

test("response boundary covers independently mounted HTML routes and translates errors only",async()=>{
  const server=http.createServer((req,res)=>{installChineseResponse(res);if(req.url==='/html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<html><body><button>Preflight</button></body></html>');}else{res.writeHead(req.url==='/error'?400:200,{'content-type':'application/json'});res.end(JSON.stringify({error:'VALIDATION_ERROR',message:'Project name is required',kind:'DIALOGUE'}));}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
    assert.match(await(await fetch(base+'/html')).text(),/<button>生成前检查<\/button>/);
    const failed=await(await fetch(base+'/error')).json() as Record<string,string>;
    assert.equal(failed.error,'VALIDATION_ERROR');assert.equal(failed.kind,'DIALOGUE');assert.equal(failed.message,'请填写项目名称。');
    const success=await(await fetch(base+'/ok')).json() as Record<string,string>;assert.equal(success.message,'Project name is required');
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test("Chinese UI middleware preserves MCP JSON-RPC error objects exactly",async()=>{
  const payload={jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}};
  const server=http.createServer((_req,res)=>{installChineseResponse(res);res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify(payload));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{const address=server.address();assert(address&&typeof address!=="string");assert.deepEqual(await(await fetch(`http://127.0.0.1:${address.port}`)).json(),payload);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
