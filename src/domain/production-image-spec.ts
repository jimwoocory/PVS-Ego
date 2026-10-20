/** Shared by submission, request hashing and quotation; never change just for a quote. */
export const PRODUCTION_IMAGE_PROFILE = {
  provider: "domestic-jimeng-image-cli", model: "5.0", resolution: "2k", count: 1
} as const;
export function productionImageRatio(kind: string): string {
  if (kind === "CHARACTER") return "3:4";
  if (kind === "SET" || kind === "STYLE") return "16:9";
  return "1:1";
}
