import { randomUUID } from "node:crypto";
import type { ProviderProbeResult } from "../ports/video-provider.js";
import type { WorkflowBlocker } from "../../domain/schemas.js";

export function blockerFromProviderProbe(
  projectId: string,
  probe: ProviderProbeResult,
  now = new Date()
): WorkflowBlocker | null {
  if (probe.code === "READY") return null;
  if (probe.code === "DREAMINA_NOT_FOUND") {
    return {
      id: randomUUID(),
      projectId,
      scope: "PROVIDER",
      reasonCode: "DREAMINA_NOT_FOUND",
      message: "未发现国内官方 dreamina CLI。",
      requiredUserAction: "安装并验证国内官方 dreamina CLI 后重新检测。",
      resumeCheckpoint: "provider.probe",
      createdAt: now.toISOString()
    };
  }
  return {
    id: randomUUID(),
    projectId,
    scope: "PROVIDER",
    reasonCode: "PROVIDER_IDENTITY_UNVERIFIED",
    message: "发现 dreamina 可执行文件，但尚未完成官方身份验证。",
    requiredUserAction: "核验官方来源、发布者、版本、签名或 sha256 与官方登录来源。",
    resumeCheckpoint: "provider.identity.verify",
    createdAt: now.toISOString()
  };
}
