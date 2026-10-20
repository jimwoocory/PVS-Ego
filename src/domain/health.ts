export type HealthSeverity = "READY" | "WARN" | "BLOCKED" | "UNKNOWN";

export type HealthAction = {
  label: string;
  href: string;
};

export type HealthCheckItem = {
  id: string;
  group:
    | "AI"
    | "DREAMINA"
    | "MEDIA"
    | "DATABASE"
    | "RESEARCH"
    | "PUBLISH";
  title: string;
  severity: HealthSeverity;
  summary: string;
  detail?: string;
  checkedAt: string;
  actions: HealthAction[];
  technical?: Record<string, string | number | boolean>;
};

export type HealthReport = {
  checkedAt: string;
  projectId?: string;
  projectName?: string;
  overall: HealthSeverity;
  counts: Record<HealthSeverity, number>;
  items: HealthCheckItem[];
};
