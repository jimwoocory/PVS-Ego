export type TaskCenterSourceType =
  | "RESEARCH"
  | "AGENT"
  | "SMART_RUN"
  | "GENERATION"
  | "RENDER"
  | "PUBLISH";

export type TaskCenterStatus =
  | "WAITING"
  | "RUNNING"
  | "NEEDS_USER"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

export type TaskCenterPaidState =
  | "FREE"
  | "NOT_SUBMITTED"
  | "AUTHORIZED"
  | "PAID_OR_EXTERNAL"
  | "UNKNOWN";

export type TaskCenterAction = {
  label: string;
  href: string;
  kind: "OPEN" | "REVIEW" | "RESUME" | "RECONCILE";
};

export type TaskCenterItem = {
  id: string;
  projectId: string;
  projectName: string;
  sourceType: TaskCenterSourceType;
  sourceId: string;
  title: string;
  phase: string;
  status: TaskCenterStatus;
  progressText: string;
  provider?: string;
  model?: string;
  paidState: TaskCenterPaidState;
  costText?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  blocker?: {
    code?: string;
    message: string;
    requiredAction?: string;
  };
  safeActions: TaskCenterAction[];
  detailHref: string;
  technical?: {
    sourceStatus: string;
    sourceStage?: string;
    lastCommandOperation?: string;
    lastCommandAt?: string;
    errorCode?: string;
    sourceRef?: string;
  };
};
