-- P1-01: AI-derived Douyin comment classification history.

ALTER TABLE "DouyinCommentRecord" ADD COLUMN "category" TEXT;

CREATE TABLE "DouyinCommentClassificationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "sourceContentHash" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "rationale" TEXT,
    "runtimeId" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "providerId" TEXT,
    "modelId" TEXT,
    "executionId" TEXT,
    "configVersion" INTEGER,
    "classifiedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DouyinCommentClassificationRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinCommentClassificationRecord_commentId_fkey"
      FOREIGN KEY ("commentId") REFERENCES "DouyinCommentRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DouyinCommentClassificationRecord_projectId_awemeId_classifiedAt_idx"
ON "DouyinCommentClassificationRecord"("projectId", "awemeId", "classifiedAt");

CREATE INDEX "DouyinCommentClassificationRecord_commentId_classifiedAt_idx"
ON "DouyinCommentClassificationRecord"("commentId", "classifiedAt");

CREATE INDEX "DouyinCommentClassificationRecord_cid_classifiedAt_idx"
ON "DouyinCommentClassificationRecord"("cid", "classifiedAt");

CREATE INDEX "DouyinCommentClassificationRecord_sourceContentHash_idx"
ON "DouyinCommentClassificationRecord"("sourceContentHash");
