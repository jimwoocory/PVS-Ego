import test from "node:test";
import assert from "node:assert/strict";
import { duckingEnvelope } from "../src/application/services/audio-envelope.js";

function gainAt(points: Array<{atMs:number;volume:number}>, at: number): number {
  let left = points[0]!;
  for (const right of points.slice(1)) {
    if (at <= right.atMs) return left.volume + (right.volume-left.volume)*(at-left.atMs)/(right.atMs-left.atMs);
    left=right;
  }
  return left.volume;
}

test("ducking merges overlapping and back-to-back speech without a volume spike", () => {
  const points=duckingEnvelope({durationMs:10000,volume:1,windows:[{start:1000,end:4000},{start:4000,end:7000},{start:2500,end:5000}]});
  for(let at=1000;at<=7000;at+=25) assert.ok(Math.abs(gainAt(points,at)-0.3)<1e-9);
  assert.equal(gainAt(points,0),1);assert.equal(gainAt(points,8000),1);
  assert.ok(points.every((p,i)=>p.atMs>=0&&p.atMs<=10000&&(!i||p.atMs>points[i-1]!.atMs)));
});

test("ducking remains low across a short phrase gap and respects each BGM loop boundary", () => {
  const points=duckingEnvelope({durationMs:5000,volume:0.22,windows:[{start:-1000,end:2000},{start:2100,end:6000}],fadeOut:true});
  assert.equal(points[0]!.volume,0.22*0.3);
  for(const at of [500,1999,2050,2300,4000]) assert.ok(gainAt(points,at)<=0.22*0.3+1e-9);
  assert.equal(points.at(-1)!.atMs,5000);assert.equal(points.at(-1)!.volume,0);
});

test("source speech replacement mutes only the replaced window, preserving later ambience", () => {
  const points=duckingEnvelope({durationMs:10000,volume:1,windows:[{start:1000,end:3000}],gain:0,attackMs:10,releaseMs:30});
  assert.equal(gainAt(points,500),1);assert.equal(gainAt(points,2000),0);assert.equal(gainAt(points,5000),1);
});

test("envelopes ignore out-of-item ranges and reject malformed or non-finite values", () => {
  assert.deepEqual(duckingEnvelope({durationMs:1000,volume:1,windows:[{start:-500,end:0},{start:1000,end:2000}]}),[{atMs:0,volume:1}]);
  assert.throws(()=>duckingEnvelope({durationMs:1000,volume:Infinity,windows:[]}));
  assert.throws(()=>duckingEnvelope({durationMs:1000,volume:1,windows:[{start:900,end:100}]}));
});
