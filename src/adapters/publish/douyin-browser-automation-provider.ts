import type {
  PublishDirectInput,
  PublishDirectResult,
  PublishProvider,
  PublishProviderProbe
} from "../../application/ports/publish-provider.js";
import { PublishSubmissionUnknownError } from "../../application/ports/publish-provider.js";
import type { DouyinBrowserPublishResult, DouyinBrowserPublisherRuntime } from "../../application/ports/douyin-browser-publisher-runtime.js";
import { DomainValidationError } from "../../domain/validation.js";
import { douyinAwemeIdFromUrl } from "../../domain/publish.js";
import {hashValue} from "../../domain/hashing.js";

export function extractBrowserTopics(description: string | undefined): {
  description: string;
  tags: string[];
} {
  if (!description?.trim()) {
    return { description: "", tags: [] };
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  const cleaned = description.replace(
    /(^|\s)#([^\s#]+)/g,
    (match, prefix: string, raw: string) => {
      const tag = raw.trim().replace(/[，。！？、,.!?;；:：]+$/u, "");
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
      return prefix;
    }
  );
  return {
    description: cleaned.replace(/[ 	]{2,}/g, " ").trim(),
    tags
  };
}

export class DouyinBrowserAutomationProvider implements PublishProvider {
  readonly type = "DOUYIN_BROWSER_AUTOMATION" as const;
  readonly displayName = "抖音浏览器辅助发布（人机协作）";
  readonly mode = "DIRECT" as const;

  constructor(
    private readonly runtime: DouyinBrowserPublisherRuntime
  ) {}

  async probe(_projectId: string): Promise<PublishProviderProbe> {
    return this.probeAccount();
  }

  private async probeAccount(pinnedAccountKey?: string): Promise<PublishProviderProbe> {
    const engine = await this.runtime.probe();
    if (!engine.ok || engine.status !== "READY") {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "UNAVAILABLE",
        reason:
          engine.message ??
          "抖音浏览器发布引擎当前不可用。",
        supportsTrustedFinalConfirmation: true,
        requiresMobileDevice: false,
        complianceNotice:
          "通过已登录的抖音创作者中心完成上传；仍需遵守抖音平台规则与账号权限。"
      };
    }

    const accountKey = pinnedAccountKey ?? await this.runtime.resolveAccountName();
    const account = await this.runtime.check(accountKey);
    if (!account.valid) {
      return {
        providerType: this.type,
        displayName: this.displayName,
        mode: this.mode,
        code: "AUTH_REQUIRED",
        reason:
          account.message ??
          "抖音账号尚未登录或登录状态已经失效。",
        ...(account.displayName
          ? { accountDisplayName: account.displayName }
          : {}),
        ...(account.platformUserId
          ? { platformUserId: account.platformUserId }
          : {}),
        supportsTrustedFinalConfirmation: true,
        requiresMobileDevice: false,
        complianceNotice:
          "点击“登录抖音”后会打开浏览器，由用户扫码完成登录；Cookie 仅保存在本机运行时秘密目录。"
      };
    }

    return {
      providerType: this.type,
      displayName: this.displayName,
      mode: this.mode,
      code: "READY",
      ...(account.displayName
        ? { accountDisplayName: account.displayName }
        : {}),
      ...(account.platformUserId
        ? { platformUserId: account.platformUserId }
        : {}),
      supportsTrustedFinalConfirmation: true,
      requiresMobileDevice: false,
      complianceNotice:
        "通过本机创作者中心辅助发布；平台可能要求验证码或人工接管，不承诺免验证。仅本次明确确认后才能提交；只有作品管理页核实本次作品才标记已发布，结果未知时不重提。"
    };
  }

  async directPublish(
    input: PublishDirectInput
  ): Promise<PublishDirectResult> {
    // Resolve the mutable active-account pointer exactly once. Check and publish the same profile.
    const accountKey = input.browserPreparedSession?.binding.accountKey ?? await this.runtime.resolveAccountName();
    if(input.browserPreparedSession&&(!this.runtime.staged||this.runtime.staged.identity!==input.browserPreparedSession.scope.runtimeId))throw new DomainValidationError("原分阶段浏览器运行时已失效；禁止切换引擎重发");
    const probe = await this.probeAccount(accountKey);
    if (probe.code !== "READY") {
      throw new DomainValidationError(
        "抖音浏览器辅助发布尚不可用：" +
          (probe.reason ?? probe.code)
      );
    }

    if (!probe.platformUserId?.trim() || (input.expectedAccountId !== undefined &&
        input.expectedAccountId.trim() !== probe.platformUserId.trim())) {
      throw new DomainValidationError("无法确认本次发布账号，或账号已变更；请刷新账号状态并重新确认");
    }
    const copy = extractBrowserTopics(input.description);
    let result: DouyinBrowserPublishResult;
    try {
      if(input.browserPreparedSession){
        const {binding,scope}=input.browserPreparedSession,snapshot=await this.runtime.staged!.inspect(binding);
        if(!snapshot.connected||snapshot.control!=="AGENT"||snapshot.challenge!=="NONE"||!snapshot.uploadComplete||hashValue(snapshot.binding)!==hashValue(binding)||snapshot.account.type!==scope.account.type||snapshot.account.id!==scope.account.id||snapshot.videoSha256!==scope.videoSha256||snapshot.title!==scope.title||snapshot.description!==scope.description||hashValue(snapshot.tags)!==hashValue(scope.tags)||snapshot.declaration!==scope.declaration||Date.parse(scope.expiresAt)<=Date.now())throw new DomainValidationError("提交前原页面、账号、媒体、文案或许可已改变，停止，不重传或重提");
      }
      result = input.browserPreparedSession
      ? await this.runtime.staged!.submit(input.browserPreparedSession.binding,input.browserPreparedSession.scope)
      : await this.runtime.publish(
      {
        videoPath: input.videoPath,
        title: input.title,
        description: copy.description,
        tags: copy.tags,
        headed:
          process.env.PVS_DOUYIN_BROWSER_HEADED?.trim() !== "0",
        declaration: "内容由AI生成"
      },
      accountKey
      );
    } catch (error) {
      // A bridge timeout/process failure may happen after clicking publish. Never classify it as safe to resubmit.
      throw new PublishSubmissionUnknownError(
        "抖音发布执行中断，无法确认平台是否已接受本次作品；请人工核对，禁止自动重试。" +
        (error instanceof Error ? " " + error.message : "")
      );
    }

    if (!result.ok) {
      // The runtime contract has no proven 'before submit' rejection flag; generic ERROR is ambiguous.
      throw new PublishSubmissionUnknownError(
        result.message ??
          result.verificationMessage ??
          "抖音浏览器返回失败，但无法确认是否已经提交；请人工核对，禁止自动重试",
        result.externalReference || result.currentUrl || undefined
      );
    }

    const externalReference =
      result.externalReference?.trim() ||
      result.currentUrl?.trim() ||
      "";

    if (result.account !== accountKey) {
      throw new PublishSubmissionUnknownError(
        "发布运行时返回的账号与本次锁定账号不一致，请人工核对平台作品，禁止自动重试",
        externalReference || undefined
      );
    }

    if (!result.verified || result.status !== "PUBLISHED_CONFIRMED") {
      throw new PublishSubmissionUnknownError(
        result.verificationMessage ||
          "抖音已经接受发布动作，但暂时无法在作品管理页确认本次作品。请先人工核对，禁止自动重试。",
        externalReference || undefined
      );
    }

    if (!externalReference) {
      throw new PublishSubmissionUnknownError(
        "抖音作品已在管理页确认，但缺少可审计的平台引用。请人工核对，禁止自动重试。"
      );
    }
    if (!result.videoId?.trim() && !douyinAwemeIdFromUrl(externalReference)) {
      throw new PublishSubmissionUnknownError(
        "平台返回成功但缺少可信作品标识，请人工核对平台作品，禁止自动重试", externalReference
      );
    }

    return {
      trusted: true,
      externalReference,
      platformIdentity: {
        ...(probe.platformUserId ? { providerAccountId: probe.platformUserId,
          providerAccountIdType: "DOUYIN_UNIQUE_ID" as const } : {}),
        ...(result.videoId?.trim() ? { videoId: result.videoId.trim() } : {}),
        ...(douyinAwemeIdFromUrl(externalReference) ? {
          externalUrl: externalReference, verifiedAwemeId: douyinAwemeIdFromUrl(externalReference)!
        } : {})
      },
      ...(result.videoId?.trim()
        ? { videoId: result.videoId.trim() }
        : {})
    };
  }
}
