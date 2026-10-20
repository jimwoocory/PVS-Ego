-- P1-04: persist evidence-grounded Douyin post-publish retrospectives.

CREATE TABLE "DouyinInsightRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "productTruthHash" TEXT NOT NULL,
    "metricSnapshotIdsJson" TEXT NOT NULL,
    "commentIdsJson" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "strengthsJson" TEXT NOT NULL,
    "weaknessesJson" TEXT NOT NULL,
    "audienceQuestionsJson" TEXT NOT NULL,
    "nextCreativeActionsJson" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "providerId" TEXT,
    "modelId" TEXT,
    "executionId" TEXT,
    "configVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DouyinInsightRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinInsightRecord_bindingId_fkey"
      FOREIGN KEY ("bindingId") REFERENCES "DouyinWorkBindingRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DouyinInsightRecord_projectId_awemeId_createdAt_idx"
ON "DouyinInsightRecord"("projectId", "awemeId", "createdAt");

CREATE INDEX "DouyinInsightRecord_bindingId_createdAt_idx"
ON "DouyinInsightRecord"("bindingId", "createdAt");

CREATE INDEX "DouyinInsightRecord_evidenceHash_idx"
ON "DouyinInsightRecord"("evidenceHash");
