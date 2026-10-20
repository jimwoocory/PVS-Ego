/** Read-only, bounded-scope gate for optional Douyin competitor research.
 * Does not load a creator's works, publishing account, or linked projects.
 * A successful Bridge heartbeat alone is not proof of a signed-in research account.
 */
import type { DouyinOpsRuntime, DouyinOpsStatus } from "../ports/douyin-ops-runtime.js";
import { DouyinOpsRuntimeError } from "../ports/douyin-ops-runtime.js";

export type DouyinResearchReadiness = {
  ready: boolean;
  status: DouyinOpsStatus;
  message: string;
  checkedAt: string;
};

const publicMessages: Record<string, string> = {
  ENGINE_UNAVAILABLE: "本机抖音研究运行组件暂不可用，请检查本地服务。",
  BRIDGE_OFFLINE: "本机抖音 Bridge 未连接，请检查本地服务。",
  BRIDGE_AUTH_FAILED: "抖音 Bridge 本地授权校验未通过，请重新检查连接。",
  SITE_OFFLINE: "Bridge 已运行，但专用抖音网页尚未注册。",
  CLIENT_SCRIPT_OUTDATED: "抖音网页连接脚本版本不匹配，请检查组件更新。",
  AUTH_REQUIRED: "抖音研究账号需要在专用网页登录。",
  LOGIN_REQUIRED: "抖音研究账号需要在专用网页登录。",
  RISK_CONTROL: "抖音平台要求人工处理验证，暂不能搜索竞品视频。",
  PROVIDER_ERROR: "暂不能核实研究账号与连接状态；不代表账号已退出。",
  PROTOCOL_ERROR: "抖音研究连接返回异常数据，请稍后重新检测。",
  UNKNOWN: "尚不能确认抖音研究连接状态，请稍后重新检测。"
};

function unavailable(code: string): DouyinResearchReadiness {
  const status = code in publicMessages ? code : "UNKNOWN";
  return {
    ready: false,
    status,
    message: publicMessages[status]!,
    checkedAt: new Date().toISOString()
  };
}

/** Only invokes the existing read-only probe and identity operations. */
export async function checkDouyinResearchReadiness(
  runtime: Pick<DouyinOpsRuntime, "probe" | "identity">
): Promise<DouyinResearchReadiness> {
  try {
    const probe = await runtime.probe();
    if (!probe.ok || !probe.ready || probe.status !== "READY") {
      return unavailable(probe.status === "READY" ? "PROVIDER_ERROR" : probe.status);
    }
    // Read-only identity confirms research login without inspecting the separate
    // browser publishing account or querying /my/listMyWorks.
    const identity = await runtime.identity();
    if (![identity.uid, identity.secUid, identity.uniqueId]
      .some(value => typeof value === "string" && value.trim().length > 0)) {
      return unavailable("AUTH_REQUIRED");
    }
    return {
      ready: true,
      status: "READY",
      message: "抖音研究连接与账号均已确认，可尝试搜索；结果仍以实际平台返回为准。",
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return unavailable(
      error instanceof DouyinOpsRuntimeError ? error.code : "PROVIDER_ERROR"
    );
  }
}
