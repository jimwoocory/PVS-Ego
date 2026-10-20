import type { TimelineReadiness, TimelineService } from "./timeline-service.js";

export type StepAccessBlocked = {
  allowed: false;
  reasonCode:
    | "TIMELINE_PLAN_MISSING"
    | "TIMELINE_NO_ACCEPTED_VIDEO"
    | "TIMELINE_DECISION_INCOMPLETE"
    | "FINAL_TIMELINE_MISSING"
    | "FINAL_TIMELINE_NOT_CONFIRMED";
  title: string;
  message: string;
  requiredAction: string;
  actionHref: string;
  technicalDetail?: string;
};

export type StepAccessResult =
  | {
      allowed: true;
    }
  | StepAccessBlocked;

type TimelineAccessSource = Pick<TimelineService, "readiness" | "latestTimeline">;

export async function inspectTimelineAccess(
  timeline: TimelineAccessSource,
  projectId: string
): Promise<StepAccessResult> {
  const readiness: TimelineReadiness = await timeline.readiness(projectId);
  if (readiness.allowed) return { allowed: true };
  return {
    allowed: false,
    reasonCode: readiness.reasonCode,
    title: "视频剪辑暂时不能打开",
    message: readiness.message,
    requiredAction: readiness.requiredAction,
    actionHref: readiness.actionHref,
    technicalDetail: [
      `accepted=${readiness.acceptedCount}`,
      `skipped=${readiness.skippedCount}`,
      `unresolved=${readiness.unresolvedCount}`
    ].join(" · ")
  };
}

export async function inspectFinalAccess(
  timeline: TimelineAccessSource,
  projectId: string
): Promise<StepAccessResult> {
  const readiness = await timeline.readiness(projectId);
  if (!readiness.allowed) {
    return {
      allowed: false,
      reasonCode: "FINAL_TIMELINE_MISSING",
      title: "成片还没有准备好",
      message: "当前还没有可用于最终渲染的有效剪辑方案。",
      requiredAction: readiness.requiredAction,
      actionHref: readiness.actionHref,
      technicalDetail: `${readiness.reasonCode} · accepted=${readiness.acceptedCount} · skipped=${readiness.skippedCount} · unresolved=${readiness.unresolvedCount}`
    };
  }
  const current = await timeline.latestTimeline(projectId);
  if (!readiness.existingTimeline || !current || current.status === "STALE") {
    return {
      allowed: false,
      reasonCode: "FINAL_TIMELINE_MISSING",
      title: "成片还没有准备好",
      message: "当前还没有可用于最终渲染的剪辑方案。",
      requiredAction: "先进入视频剪辑，建立并确认当前剪辑方案。",
      actionHref: `/projects/${projectId}/timeline`
    };
  }
  if (current.status !== "CONFIRMED") {
    return {
      allowed: false,
      reasonCode: "FINAL_TIMELINE_NOT_CONFIRMED",
      title: "成片还没有准备好",
      message: "当前视频剪辑方案尚未确认。",
      requiredAction: "先在视频剪辑页检查并确认当前剪辑方案。",
      actionHref: `/projects/${projectId}/timeline`,
      technicalDetail: `timeline=${current.id} · status=${current.status}`
    };
  }
  return { allowed: true };
}
