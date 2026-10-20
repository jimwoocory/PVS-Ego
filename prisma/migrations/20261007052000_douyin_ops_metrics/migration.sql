-- P0-05: Persist Douyin work bindings and immutable metric snapshots in PVS.

CREATE TABLE "DouyinWorkBindingRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "publishReceiptId" TEXT,
    "awemeId" TEXT,
    "source" TEXT,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "publishedAt" DATETIME,
    "boundAt" DATETIME,
    "externalUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DouyinWorkBindingRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DouyinMetricSnapshotRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "captureKey" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "plays" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "shares" INTEGER NOT NULL,
    "collects" INTEGER,
    "durationMs" INTEGER,
    "rawJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DouyinMetricSnapshotRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinMetricSnapshotRecord_bindingId_fkey"
      FOREIGN KEY ("bindingId") REFERENCES "DouyinWorkBindingRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DouyinWorkBindingRecord_packageId_key"
ON "DouyinWorkBindingRecord"("packageId");

CREATE UNIQUE INDEX "DouyinWorkBindingRecord_awemeId_key"
ON "DouyinWorkBindingRecord"("awemeId");

CREATE INDEX "DouyinWorkBindingRecord_projectId_createdAt_idx"
ON "DouyinWorkBindingRecord"("projectId", "createdAt");

CREATE INDEX "DouyinWorkBindingRecord_projectId_status_idx"
ON "DouyinWorkBindingRecord"("projectId", "status");

CREATE INDEX "DouyinWorkBindingRecord_awemeId_idx"
ON "DouyinWorkBindingRecord"("awemeId");

CREATE UNIQUE INDEX "DouyinMetricSnapshotRecord_projectId_captureKey_key"
ON "DouyinMetricSnapshotRecord"("projectId", "captureKey");

CREATE INDEX "DouyinMetricSnapshotRecord_projectId_awemeId_capturedAt_idx"
ON "DouyinMetricSnapshotRecord"("projectId", "awemeId", "capturedAt");

CREATE INDEX "DouyinMetricSnapshotRecord_bindingId_capturedAt_idx"
ON "DouyinMetricSnapshotRecord"("bindingId", "capturedAt");

CREATE INDEX "DouyinMetricSnapshotRecord_contentHash_idx"
ON "DouyinMetricSnapshotRecord"("contentHash");
