/** Stores only the exact follow-up sync, never the original user review or a generation request. */
export const savedReviewSyncBrowserScript = String.raw`
window.createPvsSavedReviewSync=function({project,post,storage,onPending}){
  const key='pvs-saved-review-sync:'+project;let rows=[],durable=true;
  try{const parsed=JSON.parse(storage.getItem(key)||'[]');if(Array.isArray(parsed))rows=parsed.filter(r=>r.project===project&&typeof r.runId==='string'&&r.runId.length<=200&&['resume','final-confirmed'].includes(r.mode)&&Number.isInteger(r.expectedRevision)&&r.expectedRevision>0).slice(-20);}catch{durable=false;}
  function notify(){onPending(rows.map(r=>({...r})),durable);}
  function save(){try{storage.setItem(key,JSON.stringify(rows));durable=true;}catch{durable=false;}notify();}
  function remember(runId,mode,expectedRevision){if(!runId||!['resume','final-confirmed'].includes(mode)||!Number.isInteger(expectedRevision)||expectedRevision<1)throw new Error('找不到原任务版本；审核已保存，请在原任务页核对。');
    let row=rows.find(r=>r.runId===runId&&r.mode===mode&&r.expectedRevision===expectedRevision);
    if(!row){row={project,runId,mode,expectedRevision,id:crypto.randomUUID()};rows.push(row);save();}return {...row};}
  async function retry(id){const row=rows.find(r=>r.id===id);if(!row)return;
    await post('/api/projects/'+encodeURIComponent(project)+'/smart-runs/'+encodeURIComponent(row.runId)+'/'+row.mode,{expectedRevision:row.expectedRevision});
    rows=rows.filter(r=>r.id!==id);save();}
  notify();return {remember,retry,pending:()=>rows.map(r=>({...r}))};
};`;
