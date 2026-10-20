-- P0-06: Persist read-only Douyin comments and replies in PVS.

CREATE TABLE "DouyinCommentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "awemeId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "uid" TEXT,
    "secUid" TEXT,
    "nickname" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "diggCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "platformCreatedAt" DATETIME,
    "parentCid" TEXT,
    "avatarUrl" TEXT,
    "sentiment" TEXT,
    "priority" TEXT,
    "syncedAt" DATETIME NOT NULL,
    "rawJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DouyinCommentRecord_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DouyinCommentRecord_bindingId_fkey"
      FOREIGN KEY ("bindingId") REFERENCES "DouyinWorkBindingRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DouyinCommentRecord_awemeId_cid_key"
ON "DouyinCommentRecord"("awemeId", "cid");

CREATE INDEX "DouyinCommentRecord_projectId_awemeId_platformCreatedAt_idx"
ON "DouyinCommentRecord"("projectId", "awemeId", "platformCreatedAt");

CREATE INDEX "DouyinCommentRecord_bindingId_platformCreatedAt_idx"
ON "DouyinCommentRecord"("bindingId", "platformCreatedAt");

CREATE INDEX "DouyinCommentRecord_parentCid_idx"
ON "DouyinCommentRecord"("parentCid");

CREATE INDEX "DouyinCommentRecord_contentHash_idx"
ON "DouyinCommentRecord"("contentHash");
