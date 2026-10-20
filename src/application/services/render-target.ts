import { renderConfigSchema, type RenderConfig } from "../../domain/schemas.js";
import { DomainValidationError } from "../../domain/validation.js";

/** The short edge follows the selected resolution; preserve the selected ratio with even H.264 dimensions. */
export function resolveRenderTarget(ratio: string, resolution: string, source?: { width?: number; height?: number }): RenderConfig {
  const shortEdge = ({ "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 } as Record<string, number>)[resolution.toLowerCase()];
  if (!shortEdge) throw new DomainValidationError("无法确定当前分辨率的成片尺寸，请明确选择受支持的输出分辨率");
  const values = ratio === "AUTO" ? [source?.width, source?.height] : ratio.split(":").map(Number);
  const [w, h] = values;
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new DomainValidationError("自动画幅需要可读取的实际视频尺寸，不能默认为竖屏");
  }
  const scale = shortEdge / Math.min(w, h);
  const width = Math.max(2, Math.round(w * scale / 2) * 2), height = Math.max(2, Math.round(h * scale / 2) * 2);
  if (width > 8192 || height > 8192) throw new DomainValidationError("输出画幅过大，请调整分辨率或比例");
  return renderConfigSchema.parse({ width, height });
}
