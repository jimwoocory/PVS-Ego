import test from "node:test";
import assert from "node:assert/strict";
import { renderClipAssetBindingPreview } from "../src/web/clip-reference-bindings-ui.js";
import type { ProductionAssetSet } from "../src/domain/production-strategy.js";

test("V3/V8 cards show exact clip image ordering and only READY trusted previews",()=>{
  const clip={id:"clip-court",referenceAssets:[
    {assetId:"scene-asset",priority:2,role:"SCENE_REFERENCE" as const,required:true},
    {assetId:"magistrate-asset",priority:0,role:"CHARACTER" as const,required:true},
    {assetId:"advisor-asset",priority:1,role:"CHARACTER" as const,required:true}
  ]};
  const set={entries:[
    {referenceAssetId:"magistrate-asset",label:"县令",status:"READY",artifactIds:["magistrate-file"]},
    {referenceAssetId:"advisor-asset",label:"师爷",status:"PLANNED",artifactIds:[]},
    {referenceAssetId:"scene-asset",label:"公堂",status:"READY",artifactIds:["court-file"]}
  ]} as unknown as ProductionAssetSet;
  const html=renderClipAssetBindingPreview({clip,assetSet:set});
  assert.match(html,/县令@图片1/);
  assert.match(html,/师爷@图片2/);
  assert.match(html,/公堂@图片3/);
  assert.ok(html.indexOf("县令@图片1")<html.indexOf("师爷@图片2"));
  assert.ok(html.indexOf("师爷@图片2")<html.indexOf("公堂@图片3"));
  assert.match(html,/\/api\/artifacts\/magistrate-file\/content/);
  assert.match(html,/\/api\/artifacts\/court-file\/content/);
  assert.doesNotMatch(html,/img[^>]*advisor/);
});
test("untrusted label text cannot inject script or HTML",()=>{
  const html=renderClipAssetBindingPreview({clip:{id:'clip-x',referenceAssets:[
    {assetId:"asset-x",priority:0,required:true,role:"CHARACTER"}
  ]},assetSet:{entries:[{referenceAssetId:"asset-x",label:'<img src=x onerror=alert(1)>',
    status:"READY",artifactIds:["file-x"]}]} as unknown as ProductionAssetSet});
  assert.doesNotMatch(html,/<img src=x onerror=alert\(1\)>/);
  assert.match(html,/&lt;img/);
});
