import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {preflightReferenceAudio,type ReferenceAudioPreflightInput} from "../src/application/services/reference-audio-preflight.js";
import {AiRuntimeRouter} from "../src/adapters/ai/ai-runtime-router.js";
import {AiSettingsService} from "../src/application/services/ai-settings-service.js";
import {OpenAiCompatibleClient} from "../src/adapters/ai/openai-compatible-client.js";
import type {StructuredAiRequest} from "../src/application/ports/structured-ai-runtime.js";

const now=new Date("2026-10-19T04:00:00Z"),sha="a".repeat(64);
function fixture():ReferenceAudioPreflightInput{return {
 projectId:"isolated-fixture",intent:"CAPABILITY_TEST",selected:{providerId:"fixture-provider",modelId:"selected"},proposed:{providerId:"fixture-provider",modelId:"fixture-audio"},
 source:{artifactId:"synthetic-only",sha256:sha,sizeBytes:192044,durationMs:6000,mimeType:"audio/wav",fileVerified:true},
 capability:{providerId:"fixture-provider",modelId:"fixture-audio",sourceKind:"PROVIDER_DOCUMENT",sourceUrl:"https://provider.example/stt",sourceHash:sha,inputModalities:["audio"],realAudioTestPassed:false},
 transport:{kind:"MULTIPART_TRANSCRIPTION",endpoint:"https://provider.example/v1/audio/transcriptions",documented:true,implemented:true},account:{modelListed:true,mappingAndFallbackVerified:true},
 pricing:{currency:"USD",unit:"second",unitPrice:0.0001,sourceUrl:"https://provider.example/catalog",sourceHash:sha,checkedAt:"2026-10-19T03:59:00Z",expiresAt:"2026-10-19T04:04:00Z",accountPriceVerified:true,conflictsResolved:true,billingIncrementSeconds:1,minimumBillableSeconds:0,accountMultiplier:1},maximumUsd:0.001
};}
test("model labels cannot establish real audio capability or inference readiness",()=>{
 const input=fixture();input.capability!.sourceKind="LOCAL_TAG";input.intent="REFERENCE_ANALYSIS";
 const result=preflightReferenceAudio(input,now);assert.equal(result.status,"BLOCKED");assert.ok(result.blockers.includes("AUDIO_CAPABILITY_NOT_DOCUMENTED"));assert.ok(result.blockers.includes("REAL_AUDIO_TEST_NOT_VERIFIED"));assert.equal(result.executionAllowed,false);
});
test("documented audio still blocks when the current Key does not list the model and protocol is not implemented",()=>{
 const input=fixture();input.account={modelListed:false,mappingAndFallbackVerified:false};input.transport.implemented=false;
 const result=preflightReferenceAudio(input,now);assert.equal(result.status,"BLOCKED");assert.ok(result.blockers.includes("ACCOUNT_MODEL_NOT_VERIFIED"));assert.ok(result.blockers.includes("ACCOUNT_MAPPING_OR_FALLBACK_UNKNOWN"));assert.ok(result.blockers.includes("AUDIO_TRANSPORT_NOT_IMPLEMENTED"));
});
test("token prices and conflicting public templates cannot become duration quotes",()=>{
 const input=fixture();input.pricing!.unit="million_tokens";input.pricing!.conflictsResolved=false;
 const result=preflightReferenceAudio(input,now);assert.ok(result.blockers.includes("AUDIO_PRICE_UNIT_NOT_VERIFIED"));assert.ok(result.blockers.includes("PRICE_OR_PROTOCOL_CONFLICT_UNRESOLVED"));assert.equal(result.publishedBaseEstimateUsd,undefined);assert.equal(result.accountQuoteUsd,undefined);
});
test("published per-second estimate is separate from unknown actual account cost",()=>{
 const input=fixture();input.source!.durationMs=15000;input.intent="REFERENCE_ANALYSIS";input.pricing!.unitPrice=0.000030834;input.pricing!.accountPriceVerified=false;delete input.pricing!.billingIncrementSeconds;
 const result=preflightReferenceAudio(input,now);assert.equal(result.publishedBaseEstimateUsd,0.00046251);assert.equal(result.accountQuoteUsd,undefined);assert.equal(result.status,"BLOCKED");assert.ok(result.blockers.includes("ACCOUNT_PRICE_NOT_VERIFIED"));assert.ok(result.blockers.includes("BILLING_RULES_UNKNOWN"));
});
test("even a fully checked synthetic preflight waits for separate model, egress and cost confirmation",()=>{
 const input=fixture(),result=preflightReferenceAudio(input,now);assert.equal(result.status,"WAITING_CONFIRMATION");assert.equal(result.executionAllowed,false);assert.equal(result.accountQuoteUsd,0.0006);assert.deepEqual(result.requiredConfirmations,["MODEL_CHANGE","MEDIA_EGRESS","PAID_AUDIO_ANALYSIS"]);
 const changed=structuredClone(input);changed.source!.sha256="b".repeat(64);assert.notEqual(preflightReferenceAudio(changed,now).scopeHash,result.scopeHash);
 changed.proposed.modelId="another-model";assert.ok(preflightReferenceAudio(changed,now).blockers.includes("AUDIO_CAPABILITY_NOT_DOCUMENTED"));
});
test("a missing source, unbounded cost, expired price or mismatched STT endpoint stays blocked",()=>{
 const input=fixture();delete input.source;delete input.maximumUsd;input.pricing!.expiresAt="2026-10-19T03:59:30Z";input.transport.endpoint="https://provider.example/v1/chat/completions";
 const result=preflightReferenceAudio(input,now);for(const code of ["SOURCE_NOT_SELECTED","COST_LIMIT_REQUIRED","AUDIO_PRICE_EXPIRED","AUDIO_ENDPOINT_MISMATCH"])assert.ok(result.blockers.includes(code));assert.equal(result.accountQuoteUsd,undefined);
});
test("actual billing increment and minimum cannot silently use exact audio seconds",()=>{
 const input=fixture();input.pricing!.minimumBillableSeconds=60;input.pricing!.billingIncrementSeconds=60;
 const result=preflightReferenceAudio(input,now);assert.equal(result.publishedBaseEstimateUsd,0.0006);assert.equal(result.accountQuoteUsd,0.006);assert.ok(result.blockers.includes("AUDIO_COST_EXCEEDS_LIMIT"));
});
test("reference audio router refuses before resolving labels, reading credentials or calling any writer",async()=>{
 let settingsCalls=0,writes=0;const settings:any={async resolveForCapabilities(){settingsCalls++;throw Error("must not resolve");},async resolve(){settingsCalls++;throw Error("must not resolve");},async apiKeyFor(){settingsCalls++;throw Error("must not read credentials");}};
 const runtime=new AiRuntimeRouter(settings,{async createExecution(){writes++;}} as any,{id:"fixture",version:"1",async generateJson(){writes++;return {};}});
 await assert.rejects(runtime.generateJson({task:"fixture",instructions:"fixture",input:{},outputContract:{},context:{projectId:"fixture",step:"REFERENCE_VIDEO_ANALYSIS"},media:[{type:"audio",mimeType:"audio/wav",dataBase64:"UklGRg=="}]}),/外发确认/);assert.equal(settingsCalls,0);assert.equal(writes,0);
});
test("strict reference capability resolution never enumerates another provider as an implicit model switch",async()=>{
 let enumerations=0;const repo:any={async getModel(){return {enabled:true,capabilities:["TEXT"]};},async listProviders(){enumerations++;return [];}};const settings=new AiSettingsService(repo,{} as any);settings.resolve=async()=>({source:"SYSTEM_DEFAULT",providerId:"original",modelId:"selected",configVersion:1});
 await assert.rejects(settings.resolveForCapabilities("fixture","REFERENCE_VIDEO_ANALYSIS",["VISION"],{allowModelFallback:false}),/用户确认模型变更/);assert.equal(enumerations,0);
});
test("current selected image model remains usable with strict reference routing",async()=>{
 const normal:any={source:"SYSTEM_DEFAULT",providerId:"original",modelId:"selected",configVersion:1};const settings=new AiSettingsService({async getModel(){return {enabled:true,capabilities:["TEXT","VISION","OCR"]};}} as any,{} as any);settings.resolve=async()=>normal;
 assert.equal(await settings.resolveForCapabilities("fixture","REFERENCE_VIDEO_ANALYSIS",["VISION"],{allowModelFallback:false}),normal);
});
test("existing non-reference capability fallback behavior is preserved",async()=>{
 const provider:any={id:"alternative",enabled:true,hasSecret:true};let secretReads=0;
 const repo:any={async getModel(p:string,modelId:string){return {modelId,enabled:true,capabilities:p==="alternative"?["VISION"]:["TEXT"]};},async listProviders(){return [provider];},async listModels(){return [{enabled:true,modelId:"vision"}];}};
 const settings=new AiSettingsService(repo,{async get(){secretReads++;return "fixture-not-real";}} as any);settings.resolve=async()=>({source:"SYSTEM_DEFAULT",providerId:"original",modelId:"selected",configVersion:1});
 const result=await settings.resolveForCapabilities("fixture","DIRECTOR",["VISION"]);assert.equal(result.source,"CAPABILITY_FALLBACK");assert.equal(result.modelId,"vision");assert.equal(secretReads,1);
});
test("reference image routing requests the selected model without fallback and sends no audio",async()=>{
 let seen:any;const provider:any={id:"p"};const settings:any={async resolveForCapabilities(_p:any,_s:any,_c:any,options:any){seen=options;return {source:"SYSTEM_DEFAULT",providerId:"p",modelId:"same",configVersion:1,provider};},async apiKeyFor(){return "local-fixture-only";}};
 const runtime=new AiRuntimeRouter(settings,{async createExecution(){}} as any,{} as any,{async generateJson(_p:any,id:string,_k:any,request:any){assert.equal(id,"same");assert.equal(request.media[0].type,"image");return {fixture:true};}} as any);
 assert.deepEqual(await runtime.generateJson({task:"fixture",instructions:"fixture",input:{},outputContract:{},context:{projectId:"fixture",step:"REFERENCE_VIDEO_ANALYSIS"},media:[{type:"image",mimeType:"image/png",dataBase64:"fixture"}]}),{fixture:true});assert.deepEqual(seen,{allowModelFallback:false});
});
test("existing wire serializer proves chat input_audio only, not multipart STT vendor support",async()=>{
 let captured:any,calls=0;const server=http.createServer(async(req,res)=>{calls++;const chunks=[];for await(const chunk of req)chunks.push(chunk);captured={path:req.url,type:req.headers["content-type"],body:JSON.parse(Buffer.concat(chunks).toString())};res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:'{"fixture":true}'}}]}));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));try{
  const provider:any={baseUrl:"http://127.0.0.1:"+(server.address() as any).port+"/v1",timeoutMs:5000,maxRetries:0};const request:StructuredAiRequest={task:"synthetic local test",instructions:"fixture",input:{},outputContract:{},media:[{type:"audio",mimeType:"audio/wav",dataBase64:"UklGRg=="}]};
  assert.deepEqual(await new OpenAiCompatibleClient().generateJson(provider,"fixture-model","local-fixture-only",request),{fixture:true});assert.equal(calls,1);assert.equal(captured.path,"/v1/chat/completions");assert.equal(captured.type,"application/json");const audio=captured.body.messages[1].content[1];assert.equal(audio.type,"input_audio");assert.equal(audio.input_audio.format,"wav");assert.equal(audio.input_audio.data,"UklGRg==");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
