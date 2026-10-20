import type { GenerationRequest } from "../../domain/schemas.js";

export type GeneratedMediaSpecFinding = {
  status: "PASS" | "RATIO_MISMATCH" | "RATIO_UNVERIFIED" | "NOT_APPLICABLE";
  requestedRatio: string;
  observedRatio?: string;
  detail: string;
};

/**
 * Inspect the actual downloaded MP4 instead of trusting text prompt or
 * provider parameters. Applicable to the explicitly versioned new route.
 * Preserve the user's paid video on failure; block automated acceptance.
 */
export function assessGeneratedMediaAspectRatio(
  request: Pick<GenerationRequest, "aspectRatio" | "imageBindings">,
  media: { width?: number; height?: number }
): GeneratedMediaSpecFinding {
  if (!request.imageBindings?.length || request.aspectRatio === "AUTO") {
    return {
      status: "NOT_APPLICABLE", requestedRatio: request.aspectRatio,
      detail: "旧请求或未指定严格比例，不改变历史审片行为。"
    };
  }
  return assessMediaRatio(request.aspectRatio,media);
}

/** Ratio comparison for read-only transition QC, without a synthetic request. */
export function assessMediaRatio(
  requestedRatio: string,
  media: { width?: number; height?: number }
): GeneratedMediaSpecFinding {
  const [widthPart, heightPart] = requestedRatio.split(":").map(Number);
  if (!widthPart || !heightPart || !Number.isFinite(widthPart / heightPart)) {
    return { status: "RATIO_UNVERIFIED", requestedRatio,
      detail: "当前请求的画幅格式无法校验。" };
  }
  if (!media.width || !media.height) {
    return { status: "RATIO_UNVERIFIED", requestedRatio,
      detail: "生成视频缺少可验证的宽高信息，禁止自动采用。" };
  }
  const desired = widthPart / heightPart;
  const actual = media.width / media.height;
  const diff = Math.abs(actual - desired) / desired;
  const observedRatio = media.width + ":" + media.height;
  return diff <= 0.02
    ? { status: "PASS", requestedRatio, observedRatio,
        detail: "真实输出宽高与本轮项目画幅匹配。" }
    : { status: "RATIO_MISMATCH", requestedRatio, observedRatio,
        detail: `要求${requestedRatio}，实际${media.width}×${media.height}；已保留视频供人工查看，不允许自动采用。` };
}
