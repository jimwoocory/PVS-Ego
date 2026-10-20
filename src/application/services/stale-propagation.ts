import type { VersionRepository } from "../ports/version-repository.js";
import { invalidationMatrix, type InvalidationSource } from "../../domain/validation.js";

export async function propagateStale(
  repository: VersionRepository,
  projectId: string,
  source: InvalidationSource
): Promise<number> {
  return repository.markStale(projectId, invalidationMatrix[source]);
}
