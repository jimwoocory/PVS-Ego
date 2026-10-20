-- CreateTable
CREATE TABLE "ResearchRunRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "sourceUrlsJson" TEXT NOT NULL,
    "queriesJson" TEXT NOT NULL,
    "browserStateJson" TEXT,
    "blockerCode" TEXT,
    "blockerMessage" TEXT,
    "requiredUserAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchRunRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchEvidenceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "sourceType" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "relatedClaimsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchEvidenceRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResearchEvidenceRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRunRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ResearchBriefRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "findingsJson" TEXT NOT NULL,
    "claimsJson" TEXT NOT NULL,
    "opportunitiesJson" TEXT NOT NULL,
    "uncertaintiesJson" TEXT NOT NULL,
    "aiExecutionJson" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ResearchBriefRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ResearchBriefRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRunRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ResearchRunRecord_projectId_createdAt_idx" ON "ResearchRunRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRunRecord_projectId_status_idx" ON "ResearchRunRecord"("projectId", "status");

-- CreateIndex
CREATE INDEX "ResearchEvidenceRecord_projectId_runId_idx" ON "ResearchEvidenceRecord"("projectId", "runId");

-- CreateIndex
CREATE INDEX "ResearchEvidenceRecord_sourceUrl_idx" ON "ResearchEvidenceRecord"("sourceUrl");

-- CreateIndex
CREATE INDEX "ResearchEvidenceRecord_contentHash_idx" ON "ResearchEvidenceRecord"("contentHash");

-- CreateIndex
CREATE INDEX "ResearchBriefRecord_projectId_runId_idx" ON "ResearchBriefRecord"("projectId", "runId");

-- CreateIndex
CREATE INDEX "ResearchBriefRecord_projectId_createdAt_idx" ON "ResearchBriefRecord"("projectId", "createdAt");
