-- CreateTable
CREATE TABLE "ReferenceVideoProfileRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "videoArtifactId" TEXT NOT NULL,
    "videoArtifactHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReferenceVideoProfileRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ReferenceVideoProfileRecord_projectId_status_version_idx" ON "ReferenceVideoProfileRecord"("projectId", "status", "version");

-- CreateIndex
CREATE INDEX "ReferenceVideoProfileRecord_videoArtifactId_idx" ON "ReferenceVideoProfileRecord"("videoArtifactId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceVideoProfileRecord_projectId_version_key" ON "ReferenceVideoProfileRecord"("projectId", "version");
