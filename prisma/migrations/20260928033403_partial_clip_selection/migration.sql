-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReviewDecisionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "clipHash" TEXT NOT NULL,
    "generationAttemptId" TEXT,
    "outputArtifactId" TEXT,
    "outputArtifactHash" TEXT,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decidedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewDecisionRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ReviewDecisionRecord" ("clipHash", "clipId", "createdAt", "decidedAt", "decision", "generationAttemptId", "id", "note", "outputArtifactHash", "outputArtifactId", "projectId") SELECT "clipHash", "clipId", "createdAt", "decidedAt", "decision", "generationAttemptId", "id", "note", "outputArtifactHash", "outputArtifactId", "projectId" FROM "ReviewDecisionRecord";
DROP TABLE "ReviewDecisionRecord";
ALTER TABLE "new_ReviewDecisionRecord" RENAME TO "ReviewDecisionRecord";
CREATE INDEX "ReviewDecisionRecord_projectId_clipId_decidedAt_idx" ON "ReviewDecisionRecord"("projectId", "clipId", "decidedAt");
CREATE INDEX "ReviewDecisionRecord_generationAttemptId_idx" ON "ReviewDecisionRecord"("generationAttemptId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
