-- Additive research candidate / review / confirmed set storage. No user record is removed.
CREATE TABLE "ResearchMediaCandidateRecord" (
 "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "runId" TEXT NOT NULL,
 "captureKey" TEXT NOT NULL, "contentHash" TEXT NOT NULL, "dataJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
 FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT,
 FOREIGN KEY ("runId") REFERENCES "ResearchRunRecord"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ResearchMediaCandidateRecord_capture_key" ON "ResearchMediaCandidateRecord"("projectId","captureKey");
CREATE INDEX "ResearchMediaCandidateRecord_project" ON "ResearchMediaCandidateRecord"("projectId","createdAt");
CREATE TABLE "CreativeReferenceSetRecord" (
 "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "version" INTEGER NOT NULL,
 "contentHash" TEXT NOT NULL, "dataJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
 FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "CreativeReferenceSetRecord_version" ON "CreativeReferenceSetRecord"("projectId","version");
CREATE TABLE "ReferencePoolHead" (
 "projectId" TEXT NOT NULL PRIMARY KEY, "revision" INTEGER NOT NULL DEFAULT 0, "setId" TEXT,
 FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT,
 FOREIGN KEY ("setId") REFERENCES "CreativeReferenceSetRecord"("id") ON DELETE RESTRICT
);
CREATE TABLE "ReferenceReviewRecord" (
 "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "dataJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL,
 FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "ReferenceReviewRecord_revision" ON "ReferenceReviewRecord"("projectId","revision");
