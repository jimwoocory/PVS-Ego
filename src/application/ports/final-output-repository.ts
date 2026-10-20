import type { RenderConfig } from "../../domain/schemas.js";

export type FinalAssemblyStatus = "READY" | "ACCEPTED" | "STALE";

export type FinalAssembly = {
  id: string;
  projectId: string;
  productionPlanHash: string;
  selectedClipIds: string[];
  inputArtifactIds: string[];
  inputArtifactHashes: string[];
  outputArtifactId: string;
  outputArtifactHash: string;
  timelineId?: string;
  timelineHash?: string;
  renderJobId?: string;
  renderConfig?: RenderConfig;
  status: FinalAssemblyStatus;
  createdAt: string;
  acceptedAt?: string;
};

export type PublishAttemptStatus =
  | "CREATED"
  | "AUTH_REQUIRED"
  | "UPLOADING"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED";

export type PublishAttempt = {
  id: string;
  projectId: string;
  finalAssemblyId: string;
  platform: "douyin";
  status: PublishAttemptStatus;
  title: string;
  description?: string;
  externalVideoId?: string;
  externalItemId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  confirmedAt?: string;
  completedAt?: string;
};

export interface FinalOutputRepository {
  createAssembly(assembly: FinalAssembly): Promise<FinalAssembly>;
  latestAssembly(projectId: string): Promise<FinalAssembly | null>;
  updateAssembly(
    id: string,
    update: Partial<Pick<FinalAssembly, "status" | "acceptedAt">>
  ): Promise<FinalAssembly>;
  markAssembliesStale(projectId: string): Promise<void>;

  createPublishAttempt(attempt: PublishAttempt): Promise<PublishAttempt>;
  updatePublishAttempt(
    id: string,
    update: Partial<
      Pick<
        PublishAttempt,
        | "status"
        | "externalVideoId"
        | "externalItemId"
        | "errorCode"
        | "errorMessage"
        | "confirmedAt"
        | "completedAt"
      >
    >
  ): Promise<PublishAttempt>;
  listPublishAttempts(projectId: string): Promise<PublishAttempt[]>;
}
