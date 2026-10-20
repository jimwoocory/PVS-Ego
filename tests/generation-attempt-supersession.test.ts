import test from "node:test";
import assert from "node:assert/strict";
import { GenerationExecutionService } from "../src/application/services/generation-execution.js";
import type { WorkflowRepository } from "../src/application/ports/workflow-repository.js";
import type { GenerationRepository } from "../src/application/ports/generation-repository.js";
import type { ArtifactRepository } from "../src/application/ports/artifact-repository.js";
import type { ProviderAuditRepository } from "../src/application/ports/provider-audit-repository.js";
import type { VideoProvider } from "../src/application/ports/video-provider.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { makeAttempt } from "./fixtures.js";

test("superseded CREATED attempt cannot be submitted", async () => {
  const oldAttempt = makeAttempt();
  const newerAttempt = {
    ...makeAttempt(),
    id: "attempt-2",
    attemptNumber: 2
  };
  const workflow = {
    async getGenerationAttempt(id: string) {
      return id === oldAttempt.id ? oldAttempt : newerAttempt;
    },
    async listGenerationAttempts() {
      return [oldAttempt, newerAttempt];
    }
  } as unknown as WorkflowRepository;
  const execution = new GenerationExecutionService(
    {} as GenerationRepository,
    workflow,
    {} as ArtifactRepository,
    {} as ProviderAuditRepository,
    {} as VideoProvider,
    "."
  );

  await assert.rejects(
    execution.submitAttempt(oldAttempt.id),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /已被更新的尝试替代/.test(error.message)
  );
});
