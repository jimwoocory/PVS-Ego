import type { PublishPackage, PublishReceipt } from "../../domain/publish.js";

/**
 * A signed handoff, manual export, project.status=PUBLISHED, or a stale
 * publishing package is NOT a trusted Douyin publication confirmation.
 */
export function hasTrustedDouyinPublication(input: {
  projectId: string;
  finalAssemblyId: string | undefined;
  finalArtifactId: string | undefined;
  finalArtifactHash: string | undefined;
  finalArtifactReady: boolean;
  packages: readonly Pick<PublishPackage, "id" | "projectId" | "finalAssemblyId" |
    "finalArtifactId" | "finalArtifactHash" | "providerType" | "status" | "publishedConfirmedAt">[];
  receipts: readonly Pick<PublishReceipt, "projectId" | "packageId" | "providerType" |
    "kind" | "trusted">[];
}): boolean {
  const {projectId,finalAssemblyId,finalArtifactId,finalArtifactHash,finalArtifactReady,packages,receipts}=input;
  if (!finalArtifactReady || !finalAssemblyId || !finalArtifactId || !finalArtifactHash) return false;
  return packages.some(pkg =>
    pkg.projectId === projectId &&
    pkg.finalAssemblyId === finalAssemblyId &&
    pkg.finalArtifactId === finalArtifactId &&
    pkg.finalArtifactHash === finalArtifactHash &&
    pkg.providerType.startsWith("DOUYIN_") &&
    pkg.status === "PUBLISHED_CONFIRMED" &&
    Boolean(pkg.publishedConfirmedAt) &&
    receipts.some(receipt =>
      receipt.projectId === projectId &&
      receipt.packageId === pkg.id &&
      receipt.providerType === pkg.providerType &&
      receipt.kind === "PUBLISHED_CONFIRMED" &&
      receipt.trusted === true
    )
  );
}
