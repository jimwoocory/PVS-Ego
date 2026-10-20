import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GeneratedAudioQcService } from "../src/application/services/generated-audio-qc.js";
import { inspectMedia } from "../src/adapters/media/inspect-media.js";
import type { StructuredAiRuntime } from "../src/application/ports/structured-ai-runtime.js";
import { makeRequest, H } from "./fixtures.js";

const execute = promisify(execFile);

async function makeVideo(dir: string) {
  const file = path.join(dir, "native-audio.mp4");
  await execute(
    process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x240:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-shortest",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-y",
      file
    ],
    { windowsHide: true, timeout: 30_000 }
  );
  return file;
}

function v2Request(generateAudio: boolean) {
  return {
    ...makeRequest(),
    generateAudio,
    inputVersionRefs: [
      {
        entityType: "ProductionAssetSet",
        entityId: "production-assets-1",
        version: 1,
        hash: H.a
      }
    ]
  };
}

function v3Request(generateAudio = true) {
  return {
    ...v2Request(generateAudio),
    audioPolicy: "V3_NATIVE_NO_BGM" as const
  };
}

test("V2 native audio is stripped when music is detected or uncertain", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-audio-qc-"));
  try {
    const file = await makeVideo(dir);
    let calls = 0;
    const runtime: StructuredAiRuntime = {
      id: "audio-qc-test",
      version: "1",
      async generateJson() {
        calls += 1;
        return {
          music: "PRESENT",
          confidence: "HIGH",
          reason: "持续可辨认的音乐性音调"
        };
      }
    };
    const result = await new GeneratedAudioQcService(runtime).sanitize(
      file,
      v2Request(true),
      dir
    );
    assert.equal(calls, 1);
    assert.equal(result.nativeAudioState, "STRIPPED_MUSIC_OR_UNCERTAIN");
    assert.equal((await inspectMedia(result.path)).hasAudio, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("V2 keeps native audio only on HIGH-confidence no-music assessment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-audio-qc-clean-"));
  try {
    const file = await makeVideo(dir);
    const runtime: StructuredAiRuntime = {
      id: "audio-qc-test",
      version: "1",
      async generateJson() {
        return {
          music: "ABSENT",
          confidence: "HIGH",
          reason: "仅检测到对白/自然动作声特征，无音乐层"
        };
      }
    };
    const result = await new GeneratedAudioQcService(runtime).sanitize(
      file,
      v2Request(true),
      dir
    );
    assert.equal(result.path, file);
    assert.equal(result.nativeAudioState, "PRESERVED_VERIFIED_NO_MUSIC");
    assert.equal((await inspectMedia(result.path)).hasAudio, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SILENT clip never keeps provider audio and does not call the classifier", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-audio-qc-silent-"));
  try {
    const file = await makeVideo(dir);
    let calls = 0;
    const runtime: StructuredAiRuntime = {
      id: "audio-qc-test",
      version: "1",
      async generateJson() {
        calls += 1;
        return {
          music: "ABSENT",
          confidence: "HIGH",
          reason: "unused"
        };
      }
    };
    const result = await new GeneratedAudioQcService(runtime).sanitize(
      file,
      v2Request(false),
      dir
    );
    assert.equal(calls, 0);
    assert.equal(result.nativeAudioState, "NOT_REQUESTED");
    assert.equal((await inspectMedia(result.path)).hasAudio, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Director V3 preserves the complete native track when BGM is suspected and surfaces regeneration guidance", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-audio-qc-v3-bgm-")
  );
  try {
    const file = await makeVideo(dir);
    const runtime: StructuredAiRuntime = {
      id: "audio-qc-v3-test",
      version: "1",
      async generateJson() {
        return {
          music: "PRESENT",
          confidence: "HIGH",
          reason: "检测到持续音乐层"
        };
      }
    };
    const result =
      await new GeneratedAudioQcService(runtime).sanitize(
        file,
        v3Request(),
        dir
      );
    assert.equal(result.path, file);
    assert.equal(
      result.nativeAudioState,
      "PRESERVED_V3_NATIVE_BGM_SUSPECTED"
    );
    assert.equal(
      (await inspectMedia(result.path)).hasAudio,
      true
    );
    assert.match(
      result.reason ?? "",
      /保留.*原生|建议重新生成/
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("Director V3 preserves native audio when BGM assessment itself fails", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-audio-qc-v3-unknown-")
  );
  try {
    const file = await makeVideo(dir);
    const runtime: StructuredAiRuntime = {
      id: "audio-qc-v3-test",
      version: "1",
      async generateJson() {
        throw new Error("classifier unavailable");
      }
    };
    const result =
      await new GeneratedAudioQcService(runtime).sanitize(
        file,
        v3Request(),
        dir
      );
    assert.equal(result.path, file);
    assert.equal(
      result.nativeAudioState,
      "PRESERVED_V3_NATIVE_BGM_SUSPECTED"
    );
    assert.equal(
      (await inspectMedia(result.path)).hasAudio,
      true
    );
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  }
});
