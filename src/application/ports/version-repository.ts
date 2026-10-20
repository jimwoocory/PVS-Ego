export interface VersionRepository {
  markStale(projectId: string, entityTypes: readonly string[]): Promise<number>;
}
