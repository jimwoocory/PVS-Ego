export type RenderExecutionPhase = "PREPARING" | "STARTING" | "RUNNING" | "OUTPUT_READY" | "RECOVERING" | "COMPLETED" | "FAILED";

export type RenderExecution = {
  renderJobId: string;
  projectId: string;
  ownerToken: string;
  ownerPid: number;
  childPid?: number;
  phase: RenderExecutionPhase;
  startedAt: string;
  updatedAt: string;
  data: {
    version: 1;
    timelineId: string;
    timelineHash: string;
    productionPlanHash: string;
    stagingRelativePath: string;
    outputRelativePath: string;
    outputArtifactId: string;
    outputArtifactHash?: string;
    assemblyId: string;
    recoveredFromToken?: string;
  };
};

export type RenderRecoveryResult = {
  projectId: string;
  renderJobId: string;
  outcome: "RECOVERED" | "RETRYABLE" | "LIVE_OWNER" | "OWNER_UNKNOWN" | "LEASE_CHANGED";
  message: string;
};
