import test from "node:test";
import assert from "node:assert/strict";
import { hashValue, stableStringify } from "../src/domain/hashing.js";

test("canonical serialization is stable across object key order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(hashValue(left), hashValue(right));
});
