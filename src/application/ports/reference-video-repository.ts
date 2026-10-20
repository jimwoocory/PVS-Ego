import type { ReferenceVideoProfile } from "../../domain/schemas.js";

export interface ReferenceVideoRepository {
  nextVersion(projectId: string): Promise<number>;
  saveProfile(profile: ReferenceVideoProfile): Promise<ReferenceVideoProfile>;
  latestActive(projectId: string): Promise<ReferenceVideoProfile | null>;
  listProfiles(projectId: string): Promise<ReferenceVideoProfile[]>;
  markActiveProfilesStale(projectId: string): Promise<void>;
}
