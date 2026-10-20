import type {
  PublishPackage,
  PublishPreference,
  PublishProviderType,
  PublishReceipt
} from "../../domain/publish.js";

export type PublishPackageUpdate = Partial<
  Pick<
    PublishPackage,
    | "status"
    | "sessionTokenHash"
    | "sessionExpiresAt"
    | "mediaTokenHash"
    | "mediaExpiresAt"
    | "handoffReference"
    | "errorCode"
    | "errorMessage"
    | "claimedAt"
    | "tokenConsumedAt"
    | "handoffStartedAt"
    | "completedAt"
    | "publishedConfirmedAt"
  >
>;

export interface PublishRepository {
  getPreference(projectId: string): Promise<PublishPreference | null>;
  setPreference(
    projectId: string,
    providerType: PublishProviderType,
    updatedAt: string
  ): Promise<PublishPreference>;

  createPackage(input: PublishPackage): Promise<PublishPackage>;
  findPackageById(id: string): Promise<PublishPackage | null>;
  latestPackage(projectId: string): Promise<PublishPackage | null>;
  listPackages(projectId: string): Promise<PublishPackage[]>;
  updatePackage(id: string, update: PublishPackageUpdate): Promise<PublishPackage>;
  /** Atomically consume a fresh direct-publish package. Never reclaim an in-flight/unknown submission. */
  claimDirectPublish(input: {
    id: string;
    projectId: string;
    now: string;
    preparedCheckpointId?:string;
  }): Promise<PublishPackage | null>;
  claimPackage(input: {
    id: string;
    tokenHash: string;
    sessionTokenHash: string;
    sessionExpiresAt: string;
    now: string;
  }): Promise<PublishPackage | null>;
  authorizeSession(input: {
    id: string;
    sessionTokenHash: string;
    now: string;
  }): Promise<PublishPackage | null>;
  authorizeMedia(input: {
    id: string;
    mediaTokenHash: string;
    now: string;
  }): Promise<PublishPackage | null>;
  expirePackages(now: string): Promise<number>;

  createReceipt(input: PublishReceipt): Promise<PublishReceipt>;
  listReceipts(projectId: string): Promise<PublishReceipt[]>;
  listReceiptsForPackage(packageId: string): Promise<PublishReceipt[]>;
}
