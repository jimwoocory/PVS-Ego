-- P1-02: Persist AI-generated Douyin reply drafts locally in PVS.

CREATE TABLE "DouyinReplyDraftRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "sourceContentHash" TEXT NOT NULL,
    "classificationId" TEXT,
    "productTruthHash" TEXT NOT NULL,
    "usedFactIdsJson" TEXT NOT NULL,
    "generatedText" TEXT NOT NULL,
    "currentText" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "providerId" TEXT,
    "modelId" TEXT,
    "executionId" TEXT,
    "configVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DouyinReplyDraftRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinReplyDraftRecord_commentId_fkey"
      FOREIGN KEY ("commentId") REFERENCES "DouyinCommentRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DouyinReplyDraftRecord_projectId_awemeId_createdAt_idx"
ON "DouyinReplyDraftRecord"("projectId", "awemeId", "createdAt");

CREATE INDEX "DouyinReplyDraftRecord_commentId_createdAt_idx"
ON "DouyinReplyDraftRecord"("commentId", "createdAt");

CREATE INDEX "DouyinReplyDraftRecord_cid_createdAt_idx"
ON "DouyinReplyDraftRecord"("cid", "createdAt");

CREATE INDEX "DouyinReplyDraftRecord_sourceContentHash_idx"
ON "DouyinReplyDraftRecord"("sourceContentHash");

CREATE INDEX "DouyinReplyDraftRecord_productTruthHash_idx"
ON "DouyinReplyDraftRecord"("productTruthHash");
