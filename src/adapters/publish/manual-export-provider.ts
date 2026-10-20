import type {
  PublishHandoffInput,
  PublishHandoffResult,
  PublishProvider,
  PublishProviderProbe
} from "../../application/ports/publish-provider.js";

export class ManualExportProvider implements PublishProvider {
  readonly type = "MANUAL_EXPORT" as const;
  readonly displayName = "下载 MP4 / 手动发布";
  readonly mode = "MANUAL" as const;

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      supportsTrustedFinalConfirmation: false,
      requiresMobileDevice: false,
      complianceNotice:
        "永久兜底路径：下载最终 MP4 后由用户自行在抖音完成上传与发布。"
    };
  }

  async prepareHandoff(
    input: PublishHandoffInput
  ): Promise<PublishHandoffResult> {
    return {
      launchUrl: input.videoUrl,
      handoffReference: input.packageId,
      instruction: "下载最终 MP4，并在抖音中手动上传发布。",
      awaitingUserAction: true
    };
  }
}
