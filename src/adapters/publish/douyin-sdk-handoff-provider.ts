import type {
  PublishHandoffInput,
  PublishHandoffResult,
  PublishProvider,
  PublishProviderProbe
} from "../../application/ports/publish-provider.js";
import { DomainValidationError } from "../../domain/validation.js";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export class DouyinSdkHandoffProvider implements PublishProvider {
  readonly type = "DOUYIN_SDK_HANDOFF" as const;
  readonly displayName = "抖音 Open SDK 唤起发布";
  readonly mode = "HANDOFF" as const;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    if (env("PVS_DOUYIN_SDK_HANDOFF_ENABLED") !== "1") {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "DISABLED",
        reason: "管理员尚未启用抖音 SDK 手机交接发布。",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true,
        complianceNotice:
          "需要正式移动应用、抖音开放平台投稿能力及相应 SDK 权限；唤起成功不等于发布成功。"
      };
    }
    const clientKey = env("DOUYIN_MOBILE_CLIENT_KEY");
    const scheme = env("PVS_MOBILE_COMPANION_SCHEME");
    if (!clientKey || !scheme) {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "NOT_CONFIGURED",
        reason:
          "抖音 SDK 手机交接尚未完成应用密钥和手机辅助端配置。",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true
      };
    }
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: true,
      complianceNotice:
        "仅表示手机辅助端可以接收成片；最终发布仍需由用户在抖音应用内完成。"
    };
  }

  async prepareHandoff(
    input: PublishHandoffInput
  ): Promise<PublishHandoffResult> {
    const probe = await this.probe(input.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        "抖音 SDK 手机交接尚不可用：" + (probe.reason ?? probe.code)
      );
    }
    const configuredScheme = env("PVS_MOBILE_COMPANION_SCHEME")!;
    const scheme = configuredScheme
      .replace(/:\/\/.*$/, "")
      .replace(/:$/, "");
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
      throw new DomainValidationError(
        "手机辅助端协议配置无效"
      );
    }
    const query = new URLSearchParams({
      package_id: input.packageId,
      bridge_url: input.bridgeUrl
    });
    const launchUrl = scheme + "://publish?" + query.toString();
    return {
      launchUrl,
      handoffReference: input.packageId,
      instruction:
        "在手机辅助端打开发布任务，领取成片并调用抖音 SDK。",
      awaitingUserAction: true
    };
  }
}
