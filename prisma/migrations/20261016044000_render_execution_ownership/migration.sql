CREATE TABLE "RenderExecutionRecord" (
  "renderJobId" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "ownerToken" TEXT NOT NULL,
  "ownerPid" INTEGER NOT NULL,
  "childPid" INTEGER,
  "phase" TEXT NOT NULL,
  "startedAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  "dataJson" TEXT NOT NULL
);
CREATE INDEX "RenderExecutionRecord_projectId_phase_idx" ON "RenderExecutionRecord"("projectId", "phase");
