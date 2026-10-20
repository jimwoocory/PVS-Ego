-- P1-06: idempotent, explicitly confirmed single-comment reply intents.

CREATE TABLE "DouyinReplyWriteIntentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "operationFingerprint" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "externalReplyCid" TEXT,
    "accountPublishId" TEXT NOT NULL,
    "accountOpsId" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DouyinReplyWriteIntentRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinReplyWriteIntentRecord_draftId_fkey"
      FOREIGN KEY ("draftId") REFERENCES "DouyinReplyDraftRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DouyinReplyWriteIntentRecord_operationFingerprint_key"
ON "DouyinReplyWriteIntentRecord"("operationFingerprint");

CREATE INDEX "DouyinReplyWriteIntentRecord_projectId_awemeId_createdAt_idx"
ON "DouyinReplyWriteIntentRecord"("projectId", "awemeId", "createdAt");

CREATE INDEX "DouyinReplyWriteIntentRecord_draftId_createdAt_idx"
ON "DouyinReplyWriteIntentRecord"("draftId", "createdAt");

CREATE INDEX "DouyinReplyWriteIntentRecord_commentId_createdAt_idx"
ON "DouyinReplyWriteIntentRecord"("commentId", "createdAt");

CREATE INDEX "DouyinReplyWriteIntentRecord_status_idx"
ON "DouyinReplyWriteIntentRecord"("status");
