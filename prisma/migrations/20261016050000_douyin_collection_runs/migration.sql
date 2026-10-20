CREATE TABLE "DouyinCollectionRunRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "awemeId" TEXT NOT NULL,
  "parentCid" TEXT,
  "requestKey" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "leaseOwner" TEXT,
  "leaseExpiresAt" DATETIME,
  "runJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DouyinCollectionRunRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DouyinCollectionRunRecord_projectId_requestKey_key" ON "DouyinCollectionRunRecord"("projectId", "requestKey");
CREATE INDEX "DouyinCollectionRunRecord_projectId_createdAt_idx" ON "DouyinCollectionRunRecord"("projectId", "createdAt");
