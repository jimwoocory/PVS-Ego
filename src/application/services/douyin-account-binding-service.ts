import type {
  DouyinBrowserAccountStatus,
  DouyinBrowserPublisherRuntime
} from "../ports/douyin-browser-publisher-runtime.js";
import {
  DouyinOpsRuntimeError,
  type DouyinOpsIdentity,
  type DouyinOpsProbe,
  type DouyinOpsRuntime
} from "../ports/douyin-ops-runtime.js";

export type DouyinAccountMatchStatus =
  | "MATCHED"
  | "MISMATCHED"
  | "UNKNOWN";

export type DouyinAccountMatchReason =
  | "STRONG_ID_MATCH"
  | "STRONG_ID_MISMATCH"
  | "PUBLISH_AUTH_REQUIRED"
  | "PUBLISH_RUNTIME_ERROR"
  | "PUBLISH_ID_MISSING"
  | "OPS_AUTH_REQUIRED"
  | "OPS_RUNTIME_UNAVAILABLE"
  | "OPS_RUNTIME_ERROR"
  | "OPS_ID_MISSING";

export type DouyinAccountMatchResult = {
  status: DouyinAccountMatchStatus;
  reason: DouyinAccountMatchReason;
  publish: {
    valid: boolean;
    displayName: string;
    platformUserId: string;
    runtimeStatus: string;
  };
  ops: {
    available: boolean;
    nickname: string;
    uid: string;
    secUid: string;
    uniqueId: string;
    shortId: string;
    runtimeStatus: string;
  };
  nicknameMatched: boolean;
  canAutoBindPublishedWork: boolean;
  checkedAt: string;
  message: string;
};

type MatchInput = {
  publish: DouyinBrowserAccountStatus;
  ops: DouyinOpsIdentity;
  checkedAt?: string;
};

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizedNickname(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function publicPublishIdentity(
  publish: DouyinBrowserAccountStatus
): DouyinAccountMatchResult["publish"] {
  return {
    valid: publish.valid === true,
    displayName: trimmed(publish.displayName),
    platformUserId: trimmed(publish.platformUserId),
    runtimeStatus: trimmed(publish.status)
  };
}

function publicOpsIdentity(
  ops: Partial<DouyinOpsIdentity>,
  runtimeStatus = "READY",
  available = true
): DouyinAccountMatchResult["ops"] {
  return {
    available,
    nickname: trimmed(ops.nickname),
    uid: trimmed(ops.uid),
    secUid: trimmed(ops.secUid),
    uniqueId: trimmed(ops.uniqueId),
    shortId: trimmed(ops.shortId),
    runtimeStatus
  };
}

function nicknameMatches(
  publishName: string,
  opsName: string
): boolean {
  if (!publishName || !opsName) return false;
  return (
    normalizedNickname(publishName) ===
    normalizedNickname(opsName)
  );
}

export function matchDouyinAccounts(
  input: MatchInput
): DouyinAccountMatchResult {
  const publish = publicPublishIdentity(input.publish);
  const ops = publicOpsIdentity(input.ops);
  const nicknameMatched = nicknameMatches(
    publish.displayName,
    ops.nickname
  );
  const checkedAt =
    input.checkedAt ?? new Date().toISOString();

  if (!publish.valid) {
    return {
      status: "UNKNOWN",
      reason: "PUBLISH_AUTH_REQUIRED",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "抖音发布账号尚未处于有效登录状态，无法确认账号一致性。"
    };
  }

  if (!publish.platformUserId) {
    return {
      status: "UNKNOWN",
      reason: "PUBLISH_ID_MISSING",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "发布运行时没有返回可靠的抖音号，不能仅凭昵称判定为同一账号。"
    };
  }

  if (!ops.uniqueId) {
    return {
      status: "UNKNOWN",
      reason: "OPS_ID_MISSING",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: false,
      checkedAt,
      message:
        "抖音运营运行时没有返回可靠的抖音号，不能仅凭昵称判定为同一账号。"
    };
  }

  if (publish.platformUserId === ops.uniqueId) {
    return {
      status: "MATCHED",
      reason: "STRONG_ID_MATCH",
      publish,
      ops,
      nicknameMatched,
      canAutoBindPublishedWork: true,
      checkedAt,
      message: "发布账号与运营账号的抖音号一致。"
    };
  }

  return {
    status: "MISMATCHED",
    reason: "STRONG_ID_MISMATCH",
    publish,
    ops,
    nicknameMatched,
    canAutoBindPublishedWork: false,
    checkedAt,
    message:
      "发布账号与运营账号的抖音号不一致，已禁止自动关联发布作品。"
  };
}

function unknownResult(input: {
  reason: DouyinAccountMatchReason;
  publish?: DouyinBrowserAccountStatus;
  ops?: Partial<DouyinOpsIdentity>;
  opsAvailable?: boolean;
  opsRuntimeStatus?: string;
  message: string;
  checkedAt?: string;
}): DouyinAccountMatchResult {
  const publish = input.publish
    ? publicPublishIdentity(input.publish)
    : {
        valid: false,
        displayName: "",
        platformUserId: "",
        runtimeStatus: "FAILED"
      };
  const ops = publicOpsIdentity(
    input.ops ?? {},
    input.opsRuntimeStatus ?? "FAILED",
    input.opsAvailable ?? false
  );
  return {
    status: "UNKNOWN",
    reason: input.reason,
    publish,
    ops,
    nicknameMatched: nicknameMatches(
      publish.displayName,
      ops.nickname
    ),
    canAutoBindPublishedWork: false,
    checkedAt:
      input.checkedAt ?? new Date().toISOString(),
    message: input.message
  };
}

export class DouyinAccountBindingService {
  constructor(
    private readonly publisherRuntime: DouyinBrowserPublisherRuntime,
    private readonly opsRuntime: DouyinOpsRuntime,
    private readonly readOnlyOperations=false
  ) {}

  async inspect(opsProbe?: DouyinOpsProbe): Promise<DouyinAccountMatchResult> {
    const checkedAt = new Date().toISOString();
    if(this.readOnlyOperations){
      // A separately authorized read account does not require a publisher and
      // cannot grant publication/account matching or automatic work binding.
      try{const probe=opsProbe??await this.opsRuntime.probe();if(!probe.ready)return unknownResult({reason:"OPS_AUTH_REQUIRED",opsRuntimeStatus:probe.status,message:probe.message??"请核验运营账号",checkedAt});
        const ops=await this.opsRuntime.identity();return {...unknownResult({reason:"PUBLISH_AUTH_REQUIRED",ops,opsAvailable:true,opsRuntimeStatus:"READY",message:"运营账号已独立核验；发布账号未接入，不确认账号一致性或自动关联发布作品。",checkedAt}),publish:{valid:false,displayName:"",platformUserId:"",runtimeStatus:"DISABLED"}};
      }catch{return unknownResult({reason:"OPS_RUNTIME_ERROR",opsRuntimeStatus:"AUTH_REQUIRED",message:"运营账号未取得当前可核验结果",checkedAt});}
    }

    let publish: DouyinBrowserAccountStatus;
    try {
      const account =
        await this.publisherRuntime.resolveAccountName();
      publish = await this.publisherRuntime.check(account);
    } catch (error) {
      return unknownResult({
        reason: "PUBLISH_RUNTIME_ERROR",
        message:
          "抖音发布账号状态检查失败：" +
          (error instanceof Error
            ? error.message
            : String(error)),
        checkedAt
      });
    }

    if (!publish.valid) {
      return unknownResult({
        reason: "PUBLISH_AUTH_REQUIRED",
        publish,
        message:
          publish.message?.trim() ||
          "抖音发布账号需要重新登录。",
        checkedAt
      });
    }

    let probe;
    try {
      probe = opsProbe ?? await this.opsRuntime.probe();
    } catch (error) {
      return unknownResult({
        reason: "OPS_RUNTIME_ERROR",
        publish,
        opsAvailable: false,
        opsRuntimeStatus: "PROVIDER_ERROR",
        message:
          "抖音运营连接检查失败：" +
          (error instanceof Error
            ? error.message
            : String(error)),
        checkedAt
      });
    }

    if (!probe.ready) {
      const reason: DouyinAccountMatchReason =
        probe.status === "AUTH_REQUIRED"
          ? "OPS_AUTH_REQUIRED"
          : "OPS_RUNTIME_UNAVAILABLE";
      return unknownResult({
        reason,
        publish,
        opsAvailable: false,
        opsRuntimeStatus: probe.status,
        message:
          probe.message?.trim() ||
          (reason === "OPS_AUTH_REQUIRED"
            ? "抖音运营账号需要重新登录。"
            : "抖音运营连接当前不可用。"),
        checkedAt
      });
    }

    let ops: DouyinOpsIdentity;
    try {
      ops = await this.opsRuntime.identity();
    } catch (error) {
      if (
        error instanceof DouyinOpsRuntimeError &&
        error.code === "AUTH_REQUIRED"
      ) {
        return unknownResult({
          reason: "OPS_AUTH_REQUIRED",
          publish,
          opsAvailable: true,
          opsRuntimeStatus: "AUTH_REQUIRED",
          message: error.message,
          checkedAt
        });
      }
      return unknownResult({
        reason: "OPS_RUNTIME_ERROR",
        publish,
        opsAvailable: true,
        opsRuntimeStatus:
          error instanceof DouyinOpsRuntimeError
            ? error.code
            : "PROVIDER_ERROR",
        message:
          "抖音运营账号身份检查失败：" +
          (error instanceof Error
            ? error.message
            : String(error)),
        checkedAt
      });
    }

    return matchDouyinAccounts({
      publish,
      ops,
      checkedAt
    });
  }
}
