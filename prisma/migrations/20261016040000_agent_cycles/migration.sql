CREATE TABLE "AgentCycleRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "dataJson" TEXT NOT NULL,
  "leaseOwner" TEXT,
  "leasePid" INTEGER,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  CONSTRAINT "AgentCycleRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentCycleRecord_projectId_requestKey_key" ON "AgentCycleRecord"("projectId", "requestKey");
CREATE INDEX "AgentCycleRecord_status_updatedAt_idx" ON "AgentCycleRecord"("status", "updatedAt");
