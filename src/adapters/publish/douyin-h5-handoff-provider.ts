import "../../isolation/require-isolation.js";
import { createHash, randomBytes } from "node:crypto";
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

type CachedSecret = {
  value: string;
  expiresAt: number;
};

export class DouyinH5HandoffProvider implements PublishProvider {
  readonly type = "DOUYIN_H5_HANDOFF" as const;
  readonly displayName = "抖音 H5 扫码投稿";
  readonly mode = "HANDOFF" as const;

  private clientToken?: CachedSecret;
  private openTicket?: CachedSecret;

  private config(): { clientKey: string; clientSecret: string } | null {
    const clientKey = env("DOUYIN_H5_CLIENT_KEY");
    const clientSecret = env("DOUYIN_H5_CLIENT_SECRET");
    return clientKey && clientSecret ? { clientKey, clientSecret } : null;
  }

  private async getClientToken(): Promise<string> {
    if (
      this.clientToken &&
      this.clientToken.expiresAt > Date.now() + 60_000
    ) {
      return this.clientToken.value;
    }
    const config = this.config();
    if (!config) {
      throw new DomainValidationError("抖音 H5 投稿的应用配置缺失");
    }
    const response = await fetch("https://open.douyin.com/oauth/client_token/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        client_key: config.clientKey,
        client_secret: config.clientSecret
      })
    });
    const json = (await response.json()) as {
      data?: {
        access_token?: string;
        expires_in?: number | string;
        error_code?: number | string;
        description?: string;
      };
      message?: string;
    };
    const data = json.data;
    if (
      !response.ok ||
      !data?.access_token ||
      Number(data.error_code ?? 0) !== 0
    ) {
      throw new Error(
        "Douyin H5 client_token failed: " +
          (data?.description ?? json.message ?? response.status)
      );
    }
    const expiresIn = Number(data.expires_in ?? 7200);
    this.clientToken = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
    };
    return data.access_token;
  }

  private async getOpenTicket(): Promise<string> {
    if (this.openTicket && this.openTicket.expiresAt > Date.now() + 60_000) {
      return this.openTicket.value;
    }
    const token = await this.getClientToken();
    const response = await fetch("https://open.douyin.com/open/getticket/", {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "access-token": token
      }
    });
    const json = (await response.json()) as {
      data?: {
        ticket?: string;
        expires_in?: number | string;
        error_code?: number | string;
        description?: string;
      };
      message?: string;
    };
    const data = json.data;
    if (
      !response.ok ||
      !data?.ticket ||
      Number(data.error_code ?? 0) !== 0
    ) {
      throw new Error(
        "Douyin H5 open_ticket failed: " +
          (data?.description ?? json.message ?? response.status)
      );
    }
    const expiresIn = Number(data.expires_in ?? 7200);
    this.openTicket = {
      value: data.ticket,
      expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
    };
    return data.ticket;
  }

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    if (env("PVS_DOUYIN_H5_HANDOFF_ENABLED") !== "1") {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "DISABLED",
        reason: "管理员尚未启用抖音 H5 投稿。",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true,
        complianceNotice:
          "H5 投稿需要开放平台投稿能力/H5 场景权限；扫码进入抖音后仍由用户完成编辑和最终发布。"
      };
    }
    if (env("PVS_DOUYIN_H5_CAPABILITY_APPROVED") !== "1") {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "DISABLED",
        reason: "尚未确认抖音开放平台 H5 投稿能力已审核通过。",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true
      };
    }
    if (!this.config()) {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "NOT_CONFIGURED",
        reason:
          "抖音 H5 投稿尚未完成应用密钥配置。",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true
      };
    }
    try {
      await this.getOpenTicket();
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "READY",
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true,
        complianceNotice:
          "H5 投稿仅代表把内容交给抖音编辑/发布页；没有可信回执前不会标记已发布。"
      };
    } catch (error) {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "AUTH_REQUIRED",
        reason: error instanceof Error ? error.message : String(error),
        supportsTrustedFinalConfirmation: false,
        requiresMobileDevice: true
      };
    }
  }

  async prepareHandoff(
    input: PublishHandoffInput
  ): Promise<PublishHandoffResult> {
    const probe = await this.probe(input.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        "抖音 H5 扫码投稿尚不可用：" + (probe.reason ?? probe.code)
      );
    }
    const video = new URL(input.videoUrl);
    const allowHttp = env("PVS_DOUYIN_H5_ALLOW_HTTP") === "1";
    if (
      !allowHttp &&
      (video.protocol !== "https:" ||
        video.hostname === "127.0.0.1" ||
        video.hostname === "localhost")
    ) {
      throw new DomainValidationError(
        "Douyin H5 video_path must be a publicly reachable HTTPS URL"
      );
    }

    const config = this.config()!;
    const ticket = await this.getOpenTicket();
    const nonce = randomBytes(12).toString("hex");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signParams: Array<[string, string]> = [
      ["nonce_str", nonce],
      ["ticket", ticket],
      ["timestamp", timestamp]
    ];
    const signText = signParams
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => key + "=" + value)
      .join("&");
    const signature = createHash("md5")
      .update(signText, "utf8")
      .digest("hex");

    const url = new URL("snssdk1128://openplatform/share");
    url.searchParams.set("share_type", "h5");
    url.searchParams.set("client_key", config.clientKey);
    url.searchParams.set("nonce_str", nonce);
    url.searchParams.set("timestamp", timestamp);
    url.searchParams.set("signature", signature);
    url.searchParams.set("state", input.packageId);
    url.searchParams.set("video_path", input.videoUrl);
    url.searchParams.set("share_to_publish", "1");
    url.searchParams.set("title", input.title);

    return {
      launchUrl: url.toString(),
      handoffReference: input.packageId,
      instruction:
        "请使用抖音 App 扫码或在手机端打开该链接，进入抖音编辑/发布页后由用户完成发布。",
      awaitingUserAction: true
    };
  }
}
