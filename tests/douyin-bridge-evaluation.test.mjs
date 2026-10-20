import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateBridgeExpression} from '../scripts/douyin-bridge-evaluation.mjs';

test('a stalled read ends without blocking the authenticated command queue forever', async()=>{
  await assert.rejects(evaluateBridgeExpression({evaluate:()=>new Promise(()=>{})},'window.__bridge.replies("1","2",0,10)',5),/Readonly CDP request timeout/);
});
test('the read deadline never changes an external-write outcome',async()=>{
  const result=await evaluateBridgeExpression({evaluate:()=>new Promise(resolve=>setTimeout(()=>resolve({submitted:true}),20))},'window.__bridge.publish("1","reply")',1);
  assert.deepEqual(result,{submitted:true});
});
test('a real completed read preserves its exact data',async()=>{
  assert.deepEqual(await evaluateBridgeExpression({evaluate:async()=>({comments:[],has_more:false})},'window.__bridge.getComments("1",0,20)',10),{comments:[],has_more:false});
});
