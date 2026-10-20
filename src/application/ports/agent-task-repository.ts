import type {
  DreaminaVideoOperation,
  GenerationProfile
} from "../../domain/schemas.js";

export type AgentMaterialType = "image" | "video" | "audio" | "logo";

export type AgentMaterial = {
  artifactId: string;
  type: AgentMaterialType;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  priority: number;
  durationMs?: number;
};

export type AgentReferenceAdaptation = {
  sourceArtifactId: string;
  sourceArtifactHash: string;
  sourceFilename: string;
  sourceDurationMs: number;
  strategy: "KEYFRAMES";
  adapterVersion: string;
  inputMediaMaxSeconds?: number;
  reasonCodes: Array<
    "PER_FILE_DURATION" | "TOTAL_MEDIA_DURATION" | "VIDEO_COUNT"
  >;
  derived: Array<{
    artifactId: string;
    artifactHash: string;
    timestampMs: number;
    frameIndex: number;
  }>;
};

export type AgentTaskStatus =
  | "DRAFT"
  | "NEEDS_MATERIAL"
  | "READY_TO_CONFIRM"
  | "APPROVED"
  | "SUBMITTED"
  | "PROCESSING"
  | "REVIEW_READY"
  | "RECONCILE_REQUIRED"
  | "ACCEPTED"
  | "FAILED";

export type AgentTaskPlan = {
  operation: DreaminaVideoOperation;
  operationLabel: string;
  reason: string;
  promptText: string;
  model: string;
  durationMs: number;
  aspectRatio: string;
  videoResolution: string;
  materialSummary: {
    images: number;
    videos: number;
    audios: number;
    logos: number;
  };
  effectiveMaterialSummary?: {
    images: number;
    videos: number;
    audios: number;
    logos: number;
  };
  referenceAdaptations?: AgentReferenceAdaptation[];
  missingRequirements: string[];
  warnings: string[];
  skillPath: string;
  skillSha256: string;
  rootHelpSha256: string;
  commandHelpSha256: string;
  capabilityCheckedAt: string;
  costEstimateStatus?: "KNOWN" | "UNKNOWN";
  availableCredits?: number;
  estimatedCredits?: number;
  estimatedCostText?: string;
  generationProfile?: GenerationProfile;
};

export type AgentTask = {
  id: string;
  projectId: string;
  skillId: "dreamina-cli";
  status: AgentTaskStatus;
  requestText: string;
  requestedMethod:
    | "AUTO"
    | DreaminaVideoOperation;
  selectedOperation?: DreaminaVideoOperation;
  model: string;
  durationMs: number;
  aspectRatio: string;
  videoResolution: string;
  nativeAudioOutputRequested: boolean;
  materials: AgentMaterial[];
  plan?: AgentTaskPlan;
  generationRequestId?: string;
  generationAttemptId?: string;
  outputArtifactId?: string;
  acceptedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentTaskUpdate = {
  status?: AgentTaskStatus;
  selectedOperation?: DreaminaVideoOperation | null;
  materials?: AgentMaterial[];
  plan?: AgentTaskPlan | null;
  generationRequestId?: string | null;
  generationAttemptId?: string | null;
  outputArtifactId?: string | null;
  acceptedAt?: string | null;
};

export interface AgentTaskRepository {
  create(task: AgentTask): Promise<AgentTask>;
  update(id: string, update: AgentTaskUpdate): Promise<AgentTask>;
  findById(id: string): Promise<AgentTask | null>;
  listByProject(projectId: string): Promise<AgentTask[]>;
}
