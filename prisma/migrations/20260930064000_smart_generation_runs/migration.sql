-- Additive only: existing production tables, assets and approval records are untouched.
CREATE TABLE "SmartGenerationRunRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "activeProjectKey" TEXT,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "inputHash" TEXT NOT NULL,
  "dataJson" TEXT NOT NULL,
  "leaseOwner" TEXT,
  "leasePid" INTEGER,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  CONSTRAINT "SmartGenerationRunRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SmartGenerationRunRecord_activeProjectKey_key" ON "SmartGenerationRunRecord"("activeProjectKey");
CREATE UNIQUE INDEX "SmartGenerationRunRecord_projectId_requestKey_key" ON "SmartGenerationRunRecord"("projectId", "requestKey");
CREATE INDEX "SmartGenerationRunRecord_projectId_createdAt_idx" ON "SmartGenerationRunRecord"("projectId", "createdAt");
CREATE INDEX "SmartGenerationRunRecord_status_idx" ON "SmartGenerationRunRecord"("status");
CREATE TABLE "SmartGenerationCheckpointRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "contentHash" TEXT NOT NULL,
  "dataJson" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  CONSTRAINT "SmartGenerationCheckpointRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SmartGenerationRunRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SmartGenerationCheckpointRecord_runId_revision_key" ON "SmartGenerationCheckpointRecord"("runId", "revision");
