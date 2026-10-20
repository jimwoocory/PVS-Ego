-- P1-03: local draft editing with optimistic concurrency and immutable revisions.

ALTER TABLE "DouyinReplyDraftRecord" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "DouyinReplyDraftRevisionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeText" TEXT NOT NULL,
    "afterText" TEXT NOT NULL,
    "beforeStatus" TEXT NOT NULL,
    "afterStatus" TEXT NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "resultingRevision" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DouyinReplyDraftRevisionRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinReplyDraftRevisionRecord_draftId_fkey"
      FOREIGN KEY ("draftId") REFERENCES "DouyinReplyDraftRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DouyinReplyDraftRevisionRecord_projectId_draftId_createdAt_idx"
ON "DouyinReplyDraftRevisionRecord"("projectId", "draftId", "createdAt");

CREATE INDEX "DouyinReplyDraftRevisionRecord_commentId_createdAt_idx"
ON "DouyinReplyDraftRevisionRecord"("commentId", "createdAt");
