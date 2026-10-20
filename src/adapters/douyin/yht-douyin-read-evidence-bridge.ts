import "../../isolation/require-isolation.js";
import {createRequire} from "node:module";import path from "node:path";import {pathToFileURL} from "node:url";
/** Owned read-only entry point. No external CLI edits and no publish/reply command surface. */
export async function readDouyinPageWithEvidence(engineRoot:string,operation:string,flags:Record<string,string>,injectedRuntime?:any){
 if(!["comments","replies"].includes(operation)||Object.keys(flags).some(k=>!["aweme-id","cid","cursor","count"].includes(k))||!/^\d{8,30}$/.test(flags["aweme-id"]??"")||!/^\d{1,40}$/.test(flags.cursor??"0")||operation==="replies"&&!/^\d{1,40}$/.test(flags.cid??"")||operation==="comments"&&flags.cid!==undefined)throw Error("READ_EVIDENCE_ARGUMENT_REJECTED");
 const count=Number(flags.count??20);if(!Number.isInteger(count)||count<1||count>20)throw Error("READ_EVIDENCE_BOUND_REJECTED");
 const require=createRequire(path.join(path.resolve(engineRoot),"package.json"));const runtime=injectedRuntime??new (require("./lib/pvs/runtime.js").PvsDouyinRuntime)({root:engineRoot});
 const expected=operation==="comments"?`window.__bridge.getComments(${JSON.stringify(flags["aweme-id"])},${JSON.stringify(flags.cursor??"0")},${count})`:`window.__bridge.replies(${JSON.stringify(flags.cid)},${JSON.stringify(flags["aweme-id"])},${JSON.stringify(flags.cursor??"0")},${count})`;
 const original=runtime._call.bind(runtime);let raw:unknown,seen=0;
 const pick=(v:any,keys:string[])=>Object.fromEntries(keys.filter(k=>Object.hasOwn(v??{},k)).map(k=>[k,v[k]]));
 runtime._call=async(expression:string,...args:unknown[])=>{if(expression!==expected||++seen!==1)throw Error("READ_EVIDENCE_EXPRESSION_REJECTED");const v=await original(expression,...args);raw={...pick(v,["status_code","cursor","has_more","total"]),...(Array.isArray(v?.comments)?{comments:v.comments.map((c:any)=>pick(c,["cid","aweme_id","parent_cid","reply_id","reply_to_reply_id","root_comment_id","digg_count","reply_comment_total"]))}:{})};return v;};
 try{const data=await runtime[operation]({awemeId:flags["aweme-id"],cid:flags.cid,cursor:flags.cursor??"0",count});if(seen!==1)throw Error("READ_EVIDENCE_MISSING");return {...data,readEvidence:{version:"douyin-read-page-v1",kind:operation==="comments"?"COMMENTS":"REPLIES",awemeId:flags["aweme-id"],parentCid:flags.cid??null,requestCursor:flags.cursor??"0",count,observedAt:new Date().toISOString(),raw}};}finally{runtime._call=original;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [engineRoot,operation,...args]=process.argv.slice(2);const flags:Record<string,string>={};let valid=args.length%2===0;
 for(let i=0;i<args.length;i+=2){const k=args[i]??"";if(!k.startsWith("--")||Object.hasOwn(flags,k.slice(2)))valid=false;flags[k.slice(2)]=args[i+1]??"";}
 try{if(!valid||!engineRoot||!operation)throw Error("READ_EVIDENCE_ARGUMENT_REJECTED");const data=await readDouyinPageWithEvidence(engineRoot,operation,flags);console.log("PVS_DOUYIN_JSON:"+JSON.stringify({contractVersion:1,readonly:true,operation,ok:true,status:"READY",checkedAt:new Date().toISOString(),data}));}
 catch(e){const code=typeof (e as any)?.code==="string"&&(e as any).code.match(/^[A-Z_]{3,80}$/)?(e as any).code:"PROTOCOL_ERROR";console.log("PVS_DOUYIN_JSON:"+JSON.stringify({contractVersion:1,readonly:true,operation:operation??"",ok:false,status:code,checkedAt:new Date().toISOString(),error:{code,message:"只读原始证据采集失败；停止，不回退为无证据成功"}}));process.exitCode=1;}
}
