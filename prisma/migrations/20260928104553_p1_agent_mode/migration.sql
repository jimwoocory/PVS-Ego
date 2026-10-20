-- CreateTable
CREATE TABLE "AgentTaskRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "requestedMethod" TEXT NOT NULL,
    "selectedOperation" TEXT,
    "model" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "videoResolution" TEXT NOT NULL,
    "materialsJson" TEXT NOT NULL,
    "planJson" TEXT,
    "generationRequestId" TEXT,
    "generationAttemptId" TEXT,
    "outputArtifactId" TEXT,
    "acceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentTaskRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentTaskRecord_projectId_createdAt_idx" ON "AgentTaskRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTaskRecord_projectId_status_idx" ON "AgentTaskRecord"("projectId", "status");
