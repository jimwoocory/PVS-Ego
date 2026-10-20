-- CreateTable
CREATE TABLE "TimelineRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "productionPlanHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    CONSTRAINT "TimelineRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RenderJobRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "timelineId" TEXT NOT NULL,
    "timelineHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputArtifactIdsJson" TEXT NOT NULL,
    "inputArtifactHashesJson" TEXT NOT NULL,
    "renderConfigJson" TEXT NOT NULL,
    "outputArtifactId" TEXT,
    "outputArtifactHash" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "RenderJobRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TimelineRecord_projectId_version_key" ON "TimelineRecord"("projectId", "version");

-- CreateIndex
CREATE INDEX "TimelineRecord_projectId_status_version_idx" ON "TimelineRecord"("projectId", "status", "version");

-- CreateIndex
CREATE INDEX "TimelineRecord_projectId_createdAt_idx" ON "TimelineRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "TimelineRecord_contentHash_idx" ON "TimelineRecord"("contentHash");

-- CreateIndex
CREATE INDEX "RenderJobRecord_projectId_createdAt_idx" ON "RenderJobRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderJobRecord_projectId_status_idx" ON "RenderJobRecord"("projectId", "status");

-- CreateIndex
CREATE INDEX "RenderJobRecord_timelineId_timelineHash_idx" ON "RenderJobRecord"("timelineId", "timelineHash");
