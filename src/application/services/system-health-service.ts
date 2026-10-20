import "../../isolation/require-isolation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AiSettingsService } from "./ai-settings-service.js";
import type { ProductFlowService } from "./product-flow.js";
import type { PublishBridgeService } from "./publish-bridge-service.js";
import type { VideoProvider } from "../ports/video-provider.js";
import type {
  HealthCheckItem,
  HealthReport,
  HealthSeverity
} from "../../domain/health.js";

const execFileAsync = promisify(execFile);

type HealthServiceDependencies = {
  aiSettings: Pick<AiSettingsService, "listProviders" | "getSystemPreference">;
  productFlow: Pick<ProductFlowService, "listProjects" | "getProject">;
  provider: VideoProvider;
  publishBridge: Pick<PublishBridgeService, "providerStatus">;
  databasePing: () => Promise<void>;
  ffmpegPath?: string;
  ffprobePath?: string;
  browserResearchUrl?: string;
  dreaminaRegistry?: () => Promise<unknown>;
  hermesFallbackAvailable?: () => Promise<boolean>;
};

function severityRank(value: HealthSeverity): number {
  return value === "BLOCKED"
    ? 4
    : value === "UNKNOWN"
      ? 3
      : value === "WARN"
        ? 2
        : 1;
}

function overallSeverity(items: HealthCheckItem[]): HealthSeverity {
  return (
    [...items].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity)
    )[0]?.severity ?? "UNKNOWN"
  );
}

async function commandVersion(
  executable: string,
  label: string,
  checkedAt: string
): Promise<HealthCheckItem> {
  try {
    const result = await execFileAsync(executable, ["-version"], {
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 512 * 1024
    });
    const firstLine = String(result.stdout || result.stderr || "")
      .split(/\r?\n/)
      .find((line) => line.trim()) ?? "版本信息可读取";
    return {
      id: `media:${label.toLowerCase()}`,
      group: "MEDIA",
      title: label,
      severity: "READY",
      summary: `${label} 可用`,
      detail: firstLine.trim(),
      checkedAt,
      actions: [],
      technical: {
        executable
      }
    };
  } catch (error) {
    return {
      id: `media:${label.toLowerCase()}`,
      group: "MEDIA",
      title: label,
      severity: "BLOCKED",
      summary: `${label} 不可用`,
      detail:
        error instanceof Error
          ? error.message
          : String(error),
      checkedAt,
      actions: [],
      technical: {
        executable
      }
    };
  }
}

export class SystemHealthService {
  constructor(private readonly deps: HealthServiceDependencies) {}

  async check(projectIdInput?: string): Promise<HealthReport> {
    const checkedAt = new Date().toISOString();
    const projects = await this.deps.productFlow.listProjects();
    const selectedProject =
      (projectIdInput
        ? await this.deps.productFlow.getProject(projectIdInput)
        : projects[0]) ?? undefined;
    const items: HealthCheckItem[] = [];

    items.push(...(await this.aiChecks(checkedAt)));
    items.push(await this.dreaminaCheck(checkedAt));
    items.push(
      await commandVersion(
        this.deps.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
        "FFmpeg",
        checkedAt
      )
    );
    items.push(
      await commandVersion(
        this.deps.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe",
        "FFprobe",
        checkedAt
      )
    );
    items.push(await this.databaseCheck(checkedAt));
    items.push(this.researchCheck(checkedAt));

    if (selectedProject) {
      items.push(
        ...(await this.publishChecks(
          selectedProject.id,
          checkedAt
        ))
      );
    } else {
      items.push({
        id: "publish:no-project",
        group: "PUBLISH",
        title: "发布 Provider",
        severity: "WARN",
        summary: "没有项目可用于检查项目级发布授权",
        detail:
          "发布 Provider 中的 OAuth / 用户授权状态与项目相关；创建项目后可检查。",
        checkedAt,
        actions: [{ label: "创建项目", href: "/projects" }]
      });
    }

    const counts: Record<HealthSeverity, number> = {
      READY: 0,
      WARN: 0,
      BLOCKED: 0,
      UNKNOWN: 0
    };
    for (const item of items) counts[item.severity] += 1;

    return {
      checkedAt,
      ...(selectedProject
        ? {
            projectId: selectedProject.id,
            projectName: selectedProject.name
          }
        : {}),
      overall: overallSeverity(items),
      counts,
      items
    };
  }

  private async aiChecks(checkedAt: string): Promise<HealthCheckItem[]> {
    const [providers, preference] = await Promise.all([
      this.deps.aiSettings.listProviders(),
      this.deps.aiSettings.getSystemPreference()
    ]);
    if (!providers.length) {
      const fallbackAvailable = await this.deps.hermesFallbackAvailable?.().catch(() => false) ?? false;
      return [
        {
          id: fallbackAvailable ? "ai:hermes-fallback" : "ai:none",
          group: "AI",
          title: "大模型 Provider",
          severity: fallbackAvailable ? "WARN" : "BLOCKED",
          summary: fallbackAvailable ? "当前使用本机 Hermes 模型配置" : "尚未配置可用的大模型运行环境",
          detail: fallbackAvailable
            ? "未设置独立 Provider，项目沿用本机 Hermes 配置。命令可启动；实际模型连接与任务输出仍以执行回执为准。"
            : "未设置独立 Provider，且未确认本机 Hermes 可启动。请检查模型配置或安装状态。",
          checkedAt,
          actions: [{ label: "打开大模型设置", href: "/settings/ai" }]
        }
      ];
    }

    return providers.map((provider): HealthCheckItem => {
      let severity: HealthSeverity = "READY";
      let summary = "Provider 已连接";
      if (!provider.enabled) {
        severity = "WARN";
        summary = "Provider 已停用";
      } else if (!provider.hasSecret) {
        severity = "BLOCKED";
        summary = "Provider 缺少 API Key";
      } else if (provider.connectionStatus === "FAILED") {
        severity = "BLOCKED";
        summary = "Provider 最近连接测试失败";
      } else if (provider.connectionStatus === "UNTESTED") {
        severity = "WARN";
        summary = "Provider 尚未完成连接测试";
      } else if (provider.connectionStatus === "UNCONFIGURED") {
        severity = "BLOCKED";
        summary = "Provider 配置不完整";
      }

      const isSystemDefault =
        preference.defaultProviderId === provider.id;
      return {
        id: `ai:${provider.id}`,
        group: "AI",
        title: provider.name,
        severity,
        summary,
        detail: [
          isSystemDefault ? "系统默认 Provider" : "",
          provider.defaultModelId
            ? `默认模型：${provider.defaultModelId}`
            : `已登记模型：${provider.models.length}`
        ]
          .filter(Boolean)
          .join(" · "),
        checkedAt,
        actions: [{ label: "打开大模型设置", href: "/settings/ai" }],
        technical: {
          providerId: provider.id,
          baseUrl: provider.baseUrl,
          enabled: provider.enabled,
          hasSecret: provider.hasSecret,
          connectionStatus: provider.connectionStatus,
          modelCount: provider.models.length,
          ...(provider.lastTestedAt
            ? { lastTestedAt: provider.lastTestedAt }
            : {})
        }
      };
    });
  }

  private async dreaminaCheck(
    checkedAt: string
  ): Promise<HealthCheckItem> {
    try {
      const probe = await this.deps.provider.probe();
      if (probe.code !== "READY") {
        const summary =
          probe.code === "DREAMINA_NOT_FOUND"
            ? "Dreamina CLI 未找到"
            : "Dreamina CLI 身份尚未验证";
        return {
          id: "dreamina:provider",
          group: "DREAMINA",
          title: "Dreamina / Seedance",
          severity: "BLOCKED",
          summary,
          detail:
            "视频生成依赖经过验证的 Dreamina CLI；此检查不会提交生成任务。",
          checkedAt,
          actions: [{ label: "打开视频生成", href: "/agent" }],
          technical: {
            code: probe.code,
            capabilityFingerprint: probe.capabilityFingerprint
          }
        };
      }

      const account = await this.deps.provider.accountStatus();
      if (account.status !== "AUTHENTICATED") {
        return {
          id: "dreamina:provider",
          group: "DREAMINA",
          title: "Dreamina / Seedance",
          severity: "BLOCKED",
          summary:
            account.status === "NOT_AUTHENTICATED"
              ? "Dreamina CLI 已安装，但尚未登录"
              : "Dreamina 登录状态无法确认",
          detail:
            "CLI 能力已识别，但当前不能确认可进行视频生成。此检查不会消耗积分。",
          checkedAt,
          actions: [{ label: "打开视频生成", href: "/agent" }],
          technical: {
            code: probe.code,
            cliVersion: probe.cliVersion,
            supportedModelCount: probe.supportedModels.length,
            accountStatus: account.status,
            capabilityFingerprint: probe.capabilityFingerprint
          }
        };
      }

      if (this.deps.dreaminaRegistry) {
        try { await this.deps.dreaminaRegistry(); }
        catch (error) {
          return { id: "dreamina:provider", group: "DREAMINA", title: "Dreamina / Seedance", severity: "BLOCKED",
            summary: "命令行工具已连接，但动态生成能力尚不可用",
            detail: error instanceof Error ? error.message : "无法核验当前模型和参数",
            checkedAt, actions: [{label:"查看生成能力与修复说明",href:"/agent"}],
            technical: {code:"DYNAMIC_CAPABILITY_UNAVAILABLE",cliVersion:probe.cliVersion} };
        }
      }
      return {
        id: "dreamina:provider",
        group: "DREAMINA",
        title: "Dreamina / Seedance",
        severity: "READY",
        summary: "Dreamina CLI 可用且已登录",
        detail:
          `CLI ${probe.cliVersion} · 可用模型 ${probe.supportedModels.length} 个`,
        checkedAt,
        actions: [{ label: "打开视频生成", href: "/agent" }],
        technical: {
          executablePath: probe.executablePath,
          executableSha256: probe.executableSha256,
          cliVersion: probe.cliVersion,
          accountStatus: account.status,
          ...(account.availableCredits !== undefined
            ? { availableCredits: account.availableCredits }
            : {}),
          capabilityFingerprint: probe.capabilityFingerprint
        }
      };
    } catch (error) {
      return {
        id: "dreamina:provider",
        group: "DREAMINA",
        title: "Dreamina / Seedance",
        severity: "UNKNOWN",
        summary: "Dreamina 诊断执行失败",
        detail:
          error instanceof Error ? error.message : String(error),
        checkedAt,
        actions: [{ label: "打开视频生成", href: "/agent" }]
      };
    }
  }

  private async databaseCheck(
    checkedAt: string
  ): Promise<HealthCheckItem> {
    try {
      await this.deps.databasePing();
      return {
        id: "database:sqlite",
        group: "DATABASE",
        title: "项目数据库",
        severity: "READY",
        summary: "SQLite / Prisma 可读写连接正常",
        checkedAt,
        actions: []
      };
    } catch (error) {
      return {
        id: "database:sqlite",
        group: "DATABASE",
        title: "项目数据库",
        severity: "BLOCKED",
        summary: "数据库连接失败",
        detail:
          error instanceof Error ? error.message : String(error),
        checkedAt,
        actions: []
      };
    }
  }

  private researchCheck(
    checkedAt: string
  ): HealthCheckItem {
    const endpoint =
      this.deps.browserResearchUrl ??
      process.env.PVS_BROWSER_RESEARCH_URL?.trim() ??
      "";
    if (endpoint) {
      return {
        id: "research:browser",
        group: "RESEARCH",
        title: "联网研究 Provider",
        severity: "READY",
        summary: "外部浏览器 Research Provider 已配置",
        detail:
          "深度研究可优先使用外部浏览器；公开搜索仍作为 fallback。",
        checkedAt,
        actions: [{ label: "打开联网研究", href: "/projects" }],
        technical: {
          externalBrowserConfigured: true,
          publicSearchFallback: true
        }
      };
    }
    return {
      id: "research:browser",
      group: "RESEARCH",
      title: "联网研究 Provider",
      severity: "WARN",
      summary: "外部浏览器 Research Provider 未配置",
      detail:
        "公开搜索 fallback 仍可用；需要登录、验证码或平台内搜索时无法自动接管浏览器。",
      checkedAt,
      actions: [{ label: "打开联网研究", href: "/projects" }],
      technical: {
        externalBrowserConfigured: false,
        publicSearchFallback: true
      }
    };
  }

  private async publishChecks(
    projectId: string,
    checkedAt: string
  ): Promise<HealthCheckItem[]> {
    try {
      const status = await this.deps.publishBridge.providerStatus(projectId);
      return status.probes.map((probe) => {
        const severity: HealthSeverity =
          probe.code === "READY"
            ? "READY"
            : probe.code === "DISABLED" ||
                probe.code === "NOT_CONFIGURED" ||
                probe.code === "AUTH_REQUIRED"
              ? "WARN"
              : "BLOCKED";
        return {
          id: `publish:${probe.providerType}`,
          group: "PUBLISH",
          title: probe.displayName,
          severity,
          summary:
            probe.code === "READY"
              ? "Provider 可用"
              : probe.reason ?? `Provider 状态：${probe.code}`,
          detail:
            probe.code === "AUTH_REQUIRED"
              ? "发布授权与当前项目相关，需要用户完成平台授权。"
              : probe.complianceNotice,
          checkedAt,
          actions: [
            {
              label: "打开发布中心",
              href: `/projects/${projectId}/final`
            }
          ],
          technical: {
            providerType: probe.providerType,
            mode: probe.mode,
            code: probe.code,
            requiresMobileDevice: probe.requiresMobileDevice,
            supportsTrustedFinalConfirmation:
              probe.supportsTrustedFinalConfirmation
          }
        } satisfies HealthCheckItem;
      });
    } catch (error) {
      return [
        {
          id: "publish:probe-error",
          group: "PUBLISH",
          title: "发布 Provider",
          severity: "UNKNOWN",
          summary: "发布 Provider 诊断失败",
          detail:
            error instanceof Error
              ? error.message
              : String(error),
          checkedAt,
          actions: [
            {
              label: "打开发布中心",
              href: `/projects/${projectId}/final`
            }
          ]
        }
      ];
    }
  }
}
