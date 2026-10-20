-- P1-05: user-confirmed, evidence-backed Douyin creative feedback.

CREATE TABLE "DouyinCreativeFeedbackRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "insightId" TEXT NOT NULL,
    "actionIndex" INTEGER NOT NULL,
    "actionHash" TEXT NOT NULL,
    "actionText" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confirmedAt" DATETIME NOT NULL,
    "deactivatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DouyinCreativeFeedbackRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinCreativeFeedbackRecord_insightId_fkey"
      FOREIGN KEY ("insightId") REFERENCES "DouyinInsightRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DouyinCreativeFeedbackRecord_insightId_actionHash_key"
ON "DouyinCreativeFeedbackRecord"("insightId", "actionHash");

CREATE INDEX "DouyinCreativeFeedbackRecord_projectId_active_confirmedAt_idx"
ON "DouyinCreativeFeedbackRecord"("projectId", "active", "confirmedAt");

CREATE INDEX "DouyinCreativeFeedbackRecord_insightId_actionIndex_idx"
ON "DouyinCreativeFeedbackRecord"("insightId", "actionIndex");
