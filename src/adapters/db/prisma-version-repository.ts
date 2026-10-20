import type { PrismaClient } from "@prisma/client";
import type { VersionRepository } from "../../application/ports/version-repository.js";

export class PrismaVersionRepository implements VersionRepository {
  constructor(private readonly db: PrismaClient) {}

  async markStale(projectId: string, entityTypes: readonly string[]): Promise<number> {
    if (!entityTypes.length) return 0;
    const result = await this.db.versionedEntity.updateMany({
      where: {
        projectId,
        entityType: { in: [...entityTypes] },
        status: { not: "STALE" }
      },
      data: { status: "STALE" }
    });
    return result.count;
  }
}
