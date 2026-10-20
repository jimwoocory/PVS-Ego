import type { Clip } from "../domain/schemas.js";
import type { ProductionAssetSet } from "../domain/production-strategy.js";

const esc=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));

/**
 * Preview the exact Clip reference ordering. This is a read-only projection:
 * it never changes confirmed prompts, approval scope or uploaded images.
 */
export function renderClipAssetBindingPreview(input:{
  clip:Pick<Clip,"id"|"referenceAssets">;
  assetSet?:ProductionAssetSet;
  imageBindings?:ReadonlyArray<{imageIndex:number;assetName:string;assetId:string;providerSlot:string}>;
}):string {
  const ordered=[...input.clip.referenceAssets].sort((a,b)=>
    a.priority-b.priority || a.assetId.localeCompare(b.assetId));
  if (!ordered.length) return "";
  const mappings=new Map((input.imageBindings??[]).map(b=>[b.imageIndex,b]));
  return '<details class="v3-asset-bindings" data-asset-clip="'+esc(input.clip.id)+'">'+
    '<summary>查看本段图片引用（'+ordered.length+'张）</summary>'+
    '<p class="muted">图片编号按当前片段实际素材顺序显示，修改或重排素材需重新校验生成前确认；普通多图参考不等于硬首帧。</p>'+
    '<div style="display:flex;gap:12px;flex-wrap:wrap">'+
    ordered.map((asset,index)=>{
      const number=index+1;
      const entry=input.assetSet?.entries.find(e=>e.referenceAssetId===asset.assetId);
      const stored=entry?.artifactIds?.[0];
      const image=entry?.status==="READY"&&stored
        ? '<a href="/api/artifacts/'+encodeURIComponent(stored)+'/content" target="_blank" rel="noopener">'+
          '<img loading="lazy" style="display:block;max-width:120px;width:120px;max-height:115px;object-fit:contain" src="/api/artifacts/'+
          encodeURIComponent(stored)+'/content" alt="'+esc(entry.label)+'"></a>'
        : '<div class="muted">当前素材没有已确认的预览图</div>';
      const mapping=mappings.get(number);
      const label=mapping?.assetName??entry?.label??asset.role;
      const exact=mapping?.assetId===asset.assetId;
      return '<article data-image-index="'+number+'" data-reference-id="'+esc(asset.assetId)+'" style="min-width:108px;max-width:145px">'+
        image+'<div><b>'+esc(label)+'@图片'+number+'</b></div>'+
        '<small class="muted">'+esc(mapping ? exact?mapping.providerSlot:"绑定记录已失配":asset.role)+'</small></article>';
    }).join("")+
    '</div></details>';
}
