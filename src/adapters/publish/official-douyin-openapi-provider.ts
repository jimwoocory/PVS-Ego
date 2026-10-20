import "../../isolation/require-isolation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DouyinPublishProbe,
  DouyinPublishProvider,
  DouyinPublishResult
} from "../../application/ports/douyin-publish-provider.js";
import { DomainValidationError } from "../../domain/validation.js";
import { PublishSubmissionUnknownError } from "../../application/ports/publish-provider.js";

type TokenRecord = {
  projectId: string;
  accessToken: string;
  refreshToken?: string;
  openId: string;
  scope: string;
  expiresAt: string;
  refreshExpiresAt?: string;
};

type PendingOAuth = {
  projectId: string;
  state: string;
  createdAt: string;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function safeStateName(state: string): string {
  if (!/^[a-f0-9-]{20,}$/i.test(state)) {
    throw new DomainValidationError("Invalid OAuth state");
  }
  return state;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export class OfficialDouyinOpenApiProvider implements DouyinPublishProvider {
  private readonly root: string;

  constructor(root = path.resolve(process.cwd(), ".runtime-secrets", "douyin")) {
    this.root = root;
  }

  private config():
    | { clientKey: string; clientSecret: string; redirectUri: string }
    | null {
    const clientKey = env("DOUYIN_CLIENT_KEY");
    const clientSecret = env("DOUYIN_CLIENT_SECRET");
    const redirectUri = env("DOUYIN_REDIRECT_URI");
    return clientKey && clientSecret && redirectUri
      ? { clientKey, clientSecret, redirectUri }
      : null;
  }

  private tokenPath(projectId: string): string {
    return path.join(this.root, "tokens", `${projectId}.json`);
  }

  private statePath(state: string): string {
    return path.join(this.root, "oauth-state", `${safeStateName(state)}.json`);
  }

  private async token(projectId: string): Promise<TokenRecord | null> {
    return readJson<TokenRecord>(this.tokenPath(projectId));
  }

  async probe(projectId: string): Promise<DouyinPublishProbe> {
    if (!this.config()) {
      return {
        code: "NOT_CONFIGURED",
        reason:
          "需要完成抖音开放平台应用密钥与回调地址配置，并申请视频发布权限。"
      };
    }
    const token = await this.token(projectId);
    if (!token) {
      return {
        code: "AUTH_REQUIRED",
        reason: "尚未完成该项目的抖音 OAuth 用户授权。"
      };
    }
    if (Date.parse(token.expiresAt) <= Date.now() + 60_000) {
      return {
        code: "AUTH_REQUIRED",
        reason: "抖音 access_token 已过期，需要重新授权。"
      };
    }
    const scopes = token.scope.split(",").map((item) => item.trim());
    if (!scopes.includes("video.create")) {
      return {
        code: "AUTH_REQUIRED",
        reason: "当前授权未包含 video.create，需要重新授权。"
      };
    }
    return { code: "READY", openId: token.openId, scope: token.scope };
  }

  async beginOAuth(projectId: string): Promise<{ authorizationUrl: string }> {
    const config = this.config();
    if (!config) {
      throw new DomainValidationError(
        "Douyin OpenAPI is not configured: DOUYIN_CLIENT_KEY, DOUYIN_CLIENT_SECRET and DOUYIN_REDIRECT_URI are required"
      );
    }
    const state = randomUUID();
    const pending: PendingOAuth = {
      projectId,
      state,
      createdAt: new Date().toISOString()
    };
    const stateFile = this.statePath(state);
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(pending, null, 2), {
      encoding: "utf8",
      flag: "wx"
    });

    const url = new URL("https://open.douyin.com/platform/oauth/connect/");
    url.searchParams.set("client_key", config.clientKey);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "video.create");
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString() };
  }

  async completeOAuth(input: {
    code: string;
    state: string;
  }): Promise<{ projectId: string }> {
    const config = this.config();
    if (!config) {
      throw new DomainValidationError("Douyin OpenAPI is not configured");
    }
    const stateFile = this.statePath(input.state);
    const pending = await readJson<PendingOAuth>(stateFile);
    if (!pending || pending.state !== input.state) {
      throw new DomainValidationError("OAuth state was not found or does not match");
    }
    if (Date.now() - Date.parse(pending.createdAt) > 15 * 60 * 1000) {
      await fs.rm(stateFile, { force: true });
      throw new DomainValidationError("OAuth state expired; start authorization again");
    }

    const body = new URLSearchParams({
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      code: input.code,
      grant_type: "authorization_code"
    });
    const response = await fetch("https://open.douyin.com/oauth/access_token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const json = (await response.json()) as {
      data?: {
        error_code?: number | string;
        description?: string;
        access_token?: string;
        refresh_token?: string;
        open_id?: string;
        scope?: string;
        expires_in?: number | string;
        refresh_expires_in?: number | string;
      };
      message?: string;
    };
    const data = json.data;
    if (
      !response.ok ||
      !data ||
      Number(data.error_code ?? 0) !== 0 ||
      !data.access_token ||
      !data.open_id
    ) {
      throw new Error(
        `Douyin OAuth token exchange failed: ${data?.description ?? json.message ?? response.status}`
      );
    }

    const now = Date.now();
    const expiresIn = Number(data.expires_in ?? 86400);
    const refreshExpiresIn = Number(data.refresh_expires_in ?? 0);
    const record: TokenRecord = {
      projectId: pending.projectId,
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      openId: data.open_id,
      scope: data.scope ?? "",
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      ...(refreshExpiresIn > 0
        ? {
            refreshExpiresAt: new Date(
              now + refreshExpiresIn * 1000
            ).toISOString()
          }
        : {})
    };
    const tokenFile = this.tokenPath(pending.projectId);
    await fs.mkdir(path.dirname(tokenFile), { recursive: true });
    await fs.writeFile(tokenFile, JSON.stringify(record, null, 2), "utf8");
    await fs.rm(stateFile, { force: true });
    return { projectId: pending.projectId };
  }

  async publish(input: {
    projectId: string;
    videoPath: string;
    title: string;
    description?: string;
    expectedAccountId?: string;
  }): Promise<DouyinPublishResult> {
    const probe = await this.probe(input.projectId);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        `抖音发布尚不可用：${probe.reason}`
      );
    }
    const token = await this.token(input.projectId);
    if (!token) throw new DomainValidationError("Douyin authorization missing");
    if (input.expectedAccountId !== undefined && input.expectedAccountId.trim() !== token.openId) {
      throw new DomainValidationError("抖音授权账号已变更，请刷新账号状态并重新确认发布");
    }

    const bytes = await fs.readFile(input.videoPath);
    if (bytes.byteLength > 128 * 1024 * 1024) {
      throw new DomainValidationError(
        "Final video exceeds 128 MB; chunked Douyin upload is required and is not enabled in this minimal publisher"
      );
    }

    const uploadUrl = new URL("https://open.douyin.com/video/upload/");
    uploadUrl.searchParams.set("open_id", token.openId);
    const form = new FormData();
    form.append(
      "video",
      new Blob([bytes], { type: "video/mp4" }),
      path.basename(input.videoPath)
    );
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "access-token": token.accessToken },
      body: form
    });
    const uploadJson = (await uploadResponse.json()) as {
      data?: {
        error_code?: number | string;
        description?: string;
        video?: { video_id?: string };
      };
    };
    const videoId = uploadJson.data?.video?.video_id;
    if (
      !uploadResponse.ok ||
      Number(uploadJson.data?.error_code ?? 0) !== 0 ||
      !videoId
    ) {
      throw new Error(
        `Douyin video upload failed: ${uploadJson.data?.description ?? uploadResponse.status}`
      );
    }

    const createUrl = new URL("https://open.douyin.com/video/create/");
    createUrl.searchParams.set("open_id", token.openId);
    const text = input.description?.trim()
      ? `${input.title.trim()}\n${input.description.trim()}`
      : input.title.trim();
    type CreateResult = {
      data?: {
        error_code?: number | string;
        description?: string;
        item_id?: string;
      };
    };
    let createResponse: Response;
    let createJson: CreateResult;
    try {
      createResponse = await fetch(createUrl, {
        method: "POST",
        headers: {
          "access-token": token.accessToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ video_id: videoId, text })
      });
      createJson = await createResponse.json() as CreateResult;
      if (!createJson || typeof createJson !== "object") {
        throw new Error("平台返回了无法识别的创建作品响应");
      }
    } catch (error) {
      throw new PublishSubmissionUnknownError(
        "抖音创建作品请求已经开始，但响应未能可靠读取；请核对平台作品，禁止重复发布。" +
        (error instanceof Error ? " " + error.message : "")
      );
    }
    const itemId = createJson.data?.item_id;
    const errorCode = createJson.data?.error_code;
    if (errorCode !== undefined && Number.isFinite(Number(errorCode)) && Number(errorCode) !== 0) {
      throw new Error(`Douyin video create rejected: ${createJson.data?.description ?? errorCode}`);
    }
    if (
      !createResponse.ok ||
      typeof itemId !== "string" || !itemId.trim()
    ) {
      throw new PublishSubmissionUnknownError(
        `抖音创建作品未返回可信作品ID，发布结果未知，禁止重复发布：${createJson.data?.description ?? createResponse.status}`
      );
    }

    return { videoId, itemId, providerAccountId: token.openId };
  }
}
