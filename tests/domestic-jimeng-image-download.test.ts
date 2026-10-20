import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DomesticJimengImageProvider } from "../src/adapters/image/domestic-jimeng-image-provider.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

test("original Dreamina image GET retries terminated without any generation submit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-jimeng-get-"));
  let fetchCount = 0;
  const download = new DomesticJimengImageProvider(
    async () => null,
    (async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new TypeError("terminated");
      return new Response(png, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(png.length) }
      });
    }) as typeof fetch
  );
  try {
    const destination = path.join(root, "image.png");
    const result = await download.download("https://example.invalid/existing-task-image", destination);
    assert.equal(fetchCount, 2);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.sizeBytes, png.length);
    assert.deepEqual(new Uint8Array(await fs.readFile(destination)), png);
    assert.deepEqual(await fs.readdir(root), ["image.png"], "no .part files remain");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("non-retryable 403 image response fails fast without creating a file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-jimeng-403-"));
  let fetchCount = 0;
  const provider = new DomesticJimengImageProvider(
    async () => null,
    (async () => {
      fetchCount += 1;
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch
  );
  try {
    await assert.rejects(
      () => provider.download("https://example.invalid/image", path.join(root, "image.png")),
      /HTTP 403/
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("200 HTML is not accepted or published as a valid image", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-jimeng-html-"));
  let fetchCount = 0;
  const provider = new DomesticJimengImageProvider(
    async () => null,
    (async () => {
      fetchCount += 1;
      return new Response("<html>expired</html>", { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch
  );
  try {
    await assert.rejects(
      () => provider.download("https://example.invalid/image", path.join(root, "image.png")),
      /不是受支持的图片/
    );
    assert.equal(fetchCount, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
