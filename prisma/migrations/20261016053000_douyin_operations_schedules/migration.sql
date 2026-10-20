CREATE TABLE "DouyinOperationsScheduleRecord" (
  "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL, "status" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "nextAt" DATETIME NOT NULL, "leaseOwner" TEXT, "leaseExpiresAt" DATETIME,
  "dataJson" TEXT NOT NULL, "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DouyinOperationsScheduleRecord_projectId_requestKey_key" ON "DouyinOperationsScheduleRecord"("projectId", "requestKey");
CREATE INDEX "DouyinOperationsScheduleRecord_status_nextAt_idx" ON "DouyinOperationsScheduleRecord"("status", "nextAt");
