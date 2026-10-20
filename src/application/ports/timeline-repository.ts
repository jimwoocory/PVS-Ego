import type { RenderJob, Timeline } from "../../domain/schemas.js";
import type { RenderExecution } from "../../domain/render-execution.js";

export interface TimelineRepository {
  getRenderExecution?(renderJobId: string): Promise<RenderExecution | null>;
  claimRenderExecution?(execution: RenderExecution, previousOwnerToken?: string): Promise<boolean>;
  updateRenderExecution?(execution: RenderExecution): Promise<boolean>;
  finishRenderExecution?(renderJobId: string, ownerToken: string, result: {
    status: "SUCCEEDED" | "FAILED";
    outputArtifactId?: string;
    outputArtifactHash?: string;
    errorCode?: string;
    errorMessage?: string;
    completedAt: string;
  }): Promise<RenderJob | null>;
  installAutoTimeline?(timeline: Timeline, expected: { id: string; hash: string; status: string } | null): Promise<Timeline>;
  nextTimelineVersion(projectId: string): Promise<number>;
  saveTimeline(timeline: Timeline): Promise<Timeline>;
  findTimelineById(id: string): Promise<Timeline | null>;
  latestTimeline(projectId: string): Promise<Timeline | null>;
  markTimelinesStale(projectId: string, exceptId?: string): Promise<void>;

  createRenderJob(job: RenderJob): Promise<RenderJob>;
  updateRenderJob(
    id: string,
    update: Partial<
      Pick<
        RenderJob,
        | "status"
        | "outputArtifactId"
        | "outputArtifactHash"
        | "errorCode"
        | "errorMessage"
        | "startedAt"
        | "completedAt"
      >
    >
  ): Promise<RenderJob>;
  latestRenderJob(projectId: string): Promise<RenderJob | null>;
  listRenderJobs(projectId: string): Promise<RenderJob[]>;
}
