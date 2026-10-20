-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentTaskRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL DEFAULT 'dreamina-cli',
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
INSERT INTO "new_AgentTaskRecord" ("acceptedAt", "aspectRatio", "createdAt", "durationMs", "generationAttemptId", "generationRequestId", "id", "materialsJson", "model", "outputArtifactId", "planJson", "projectId", "requestText", "requestedMethod", "selectedOperation", "status", "updatedAt", "videoResolution") SELECT "acceptedAt", "aspectRatio", "createdAt", "durationMs", "generationAttemptId", "generationRequestId", "id", "materialsJson", "model", "outputArtifactId", "planJson", "projectId", "requestText", "requestedMethod", "selectedOperation", "status", "updatedAt", "videoResolution" FROM "AgentTaskRecord";
DROP TABLE "AgentTaskRecord";
ALTER TABLE "new_AgentTaskRecord" RENAME TO "AgentTaskRecord";
CREATE INDEX "AgentTaskRecord_projectId_createdAt_idx" ON "AgentTaskRecord"("projectId", "createdAt");
CREATE INDEX "AgentTaskRecord_projectId_status_idx" ON "AgentTaskRecord"("projectId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
