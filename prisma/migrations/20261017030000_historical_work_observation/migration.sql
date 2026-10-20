PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DouyinWorkBindingRecord" (
 "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "packageId" TEXT,
 "opsAccountUid" TEXT, "workDescription" TEXT, "publishReceiptId" TEXT, "awemeId" TEXT,
 "source" TEXT, "confidence" TEXT NOT NULL, "status" TEXT NOT NULL, "publishedAt" DATETIME,
 "boundAt" DATETIME, "externalUrl" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "DouyinWorkBindingRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DouyinWorkBindingRecord" ("id","projectId","packageId","publishReceiptId","awemeId","source","confidence","status","publishedAt","boundAt","externalUrl","createdAt","updatedAt")
 SELECT "id","projectId","packageId","publishReceiptId","awemeId","source","confidence","status","publishedAt","boundAt","externalUrl","createdAt","updatedAt" FROM "DouyinWorkBindingRecord";
DROP TABLE "DouyinWorkBindingRecord";
ALTER TABLE "new_DouyinWorkBindingRecord" RENAME TO "DouyinWorkBindingRecord";
CREATE UNIQUE INDEX "DouyinWorkBindingRecord_packageId_key" ON "DouyinWorkBindingRecord"("packageId");
CREATE UNIQUE INDEX "DouyinWorkBindingRecord_awemeId_key" ON "DouyinWorkBindingRecord"("awemeId");
CREATE INDEX "DouyinWorkBindingRecord_projectId_createdAt_idx" ON "DouyinWorkBindingRecord"("projectId","createdAt");
CREATE INDEX "DouyinWorkBindingRecord_projectId_status_idx" ON "DouyinWorkBindingRecord"("projectId","status");
CREATE INDEX "DouyinWorkBindingRecord_awemeId_idx" ON "DouyinWorkBindingRecord"("awemeId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
