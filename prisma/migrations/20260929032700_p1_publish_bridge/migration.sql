-- CreateTable
CREATE TABLE "PublishPreferenceRecord" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "providerType" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PublishPreferenceRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublishPackageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "finalAssemblyId" TEXT NOT NULL,
    "finalArtifactId" TEXT NOT NULL,
    "finalArtifactHash" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "titleDraft" TEXT NOT NULL,
    "descriptionDraft" TEXT,
    "coverArtifactId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "singleUseTokenHash" TEXT NOT NULL,
    "tokenConsumedAt" DATETIME,
    "sessionTokenHash" TEXT,
    "sessionExpiresAt" DATETIME,
    "mediaTokenHash" TEXT,
    "mediaExpiresAt" DATETIME,
    "status" TEXT NOT NULL,
    "handoffReference" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL,
    "claimedAt" DATETIME,
    "handoffStartedAt" DATETIME,
    "completedAt" DATETIME,
    "publishedConfirmedAt" DATETIME,
    CONSTRAINT "PublishPackageRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublishReceiptRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trusted" BOOLEAN NOT NULL,
    "externalReference" TEXT,
    "evidenceHash" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL,
    CONSTRAINT "PublishReceiptRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PublishReceiptRecord_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "PublishPackageRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PublishPackageRecord_projectId_createdAt_idx" ON "PublishPackageRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishPackageRecord_projectId_status_idx" ON "PublishPackageRecord"("projectId", "status");

-- CreateIndex
CREATE INDEX "PublishPackageRecord_expiresAt_idx" ON "PublishPackageRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "PublishPackageRecord_singleUseTokenHash_idx" ON "PublishPackageRecord"("singleUseTokenHash");

-- CreateIndex
CREATE INDEX "PublishReceiptRecord_projectId_createdAt_idx" ON "PublishReceiptRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishReceiptRecord_packageId_createdAt_idx" ON "PublishReceiptRecord"("packageId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishReceiptRecord_kind_trusted_idx" ON "PublishReceiptRecord"("kind", "trusted");
