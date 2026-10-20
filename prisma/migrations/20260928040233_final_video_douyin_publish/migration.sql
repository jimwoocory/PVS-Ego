-- CreateTable
CREATE TABLE "FinalAssemblyRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "productionPlanHash" TEXT NOT NULL,
    "selectedClipIdsJson" TEXT NOT NULL,
    "inputArtifactIdsJson" TEXT NOT NULL,
    "inputArtifactHashesJson" TEXT NOT NULL,
    "outputArtifactId" TEXT NOT NULL,
    "outputArtifactHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    CONSTRAINT "FinalAssemblyRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublishAttemptRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "finalAssemblyId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "externalVideoId" TEXT,
    "externalItemId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "PublishAttemptRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FinalAssemblyRecord_projectId_createdAt_idx" ON "FinalAssemblyRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "FinalAssemblyRecord_projectId_status_idx" ON "FinalAssemblyRecord"("projectId", "status");

-- CreateIndex
CREATE INDEX "PublishAttemptRecord_projectId_createdAt_idx" ON "PublishAttemptRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishAttemptRecord_projectId_status_idx" ON "PublishAttemptRecord"("projectId", "status");
