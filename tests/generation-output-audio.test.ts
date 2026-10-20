import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { ArtifactRepository } from "../src/application/ports/artifact-repository.js";
import type { ProviderAuditRepository } from "../src/application/ports/provider-audit-repository.js";
import type { VideoProvider } from "../src/application/ports/video-provider.js";
import type { GenerationAttempt } from "../src/domain/schemas.js";
import { makeAttempt, makeRequest } from "./fixtures.js";

test("downloaded Seedance result is rejected when native audio was required but no audio track exists", async () => {
  const projectsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pvs-native-audio-gate-")
  );
  const request = {
    ...makeRequest(),
    id: "request-native-audio",
    projectId: "project-1",
    generateAudio: true
  };
  let attempt: GenerationAttempt = {
    ...makeAttempt(),
    id: "attempt-native-audio",
    generationRequestId: request.id,
    status: "SUCCEEDED",
    providerHandle: { externalTaskId: "task-native-audio" },
    commandAttempts: []
  };
  let downloadCalls = 0;
  let mediaChecks = 0;

  const generation = {
    async getGenerationRequest(id: string) {
      return id === request.id ? structuredClone(request) : null;
    }
  } as unknown as GenerationRepository;

  const workflow = {
    async getGenerationAttempt(id: string) {
      return id === attempt.id ? structuredClone(attempt) : null;
    },
    async updateGenerationAttemptStatus(
      id: string,
      update: Partial<GenerationAttempt> & Pick<GenerationAttempt, "status">
    ) {
      if (id !== attempt.id) throw new Error("unexpected attempt");
      attempt = {
        ...attempt,
        ...structuredClone(update)
      };
      return structuredClone(attempt);
    }
  } as unknown as WorkflowRepository;

  const providerAudit = {
    async createCommandAttempt(input: unknown) {
      return input;
    },
    async updateCommandAttempt(_id: string, update: unknown) {
      return update;
    }
  } as unknown as ProviderAuditRepository;

  const provider = {
    id: "domestic-jimeng-cli" as const,
    async download(_handle: unknown, outputPath: string) {
      downloadCalls += 1;
      return {
        path: outputPath,
        sha256: "a".repeat(64),
        sizeBytes: 0
      };
    }
  } as unknown as VideoProvider;

  try {
    const service = new GenerationExecutionService(
      generation,
      workflow,
      {} as ArtifactRepository,
      providerAudit,
      provider,
      projectsRoot,
      undefined,
      undefined,
      async () => {
        mediaChecks += 1;
        return {
          durationMs: 8000,
          width: 720,
          height: 1280,
          hasVideo: true,
          hasAudio: false
        };
      }
    );

    const result = await service.downloadAttempt(attempt.id);
    assert.equal(downloadCalls, 1);
    assert.equal(mediaChecks, 1);
    assert.equal(result.status, "FAILED");
    assert.equal(result.errorCode, "OUTPUT_AUDIO_MISSING");
    assert.match(result.errorMessage ?? "", /没有音轨/);
    assert.equal(result.outputArtifactId, undefined);
  } finally {
    await fs.rm(projectsRoot, { recursive: true, force: true });
  }
});
