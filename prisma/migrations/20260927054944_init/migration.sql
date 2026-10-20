-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "targetPlatform" TEXT NOT NULL DEFAULT 'douyin',
    "targetDurationMs" INTEGER NOT NULL,
    "aspectRatio" TEXT NOT NULL DEFAULT '9:16',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VersionedEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VersionedEntity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArtifactRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sha256" TEXT,
    "sizeBytes" INTEGER,
    "mimeType" TEXT,
    "integrityStatus" TEXT NOT NULL,
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowBlockerRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "relatedEntityId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "requiredUserAction" TEXT NOT NULL,
    "resumeCheckpoint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "WorkflowBlockerRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GenerationRequestRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "compiledPromptId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "providerIdentityHash" TEXT NOT NULL,
    "capabilityFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CURRENT',
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GenerationRequestRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PreflightReportRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "generationRequestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerIdentityHash" TEXT NOT NULL,
    "capabilityFingerprint" TEXT NOT NULL,
    "reportHash" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staleAt" DATETIME,
    CONSTRAINT "PreflightReportRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PreflightReportRecord_generationRequestId_fkey" FOREIGN KEY ("generationRequestId") REFERENCES "GenerationRequestRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserApprovalRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "generationRequestId" TEXT NOT NULL,
    "preflightReportId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "preflightHash" TEXT NOT NULL,
    "providerIdentityHash" TEXT NOT NULL,
    "capabilityFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "approvedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "dataJson" TEXT NOT NULL,
    CONSTRAINT "UserApprovalRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserApprovalRecord_generationRequestId_fkey" FOREIGN KEY ("generationRequestId") REFERENCES "GenerationRequestRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UserApprovalRecord_preflightReportId_fkey" FOREIGN KEY ("preflightReportId") REFERENCES "PreflightReportRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GenerationAttemptRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "generationRequestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "preflightReportId" TEXT NOT NULL,
    "userApprovalId" TEXT NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "submissionFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalTaskId" TEXT,
    "providerHandleJson" TEXT,
    "commandAttemptsJson" TEXT NOT NULL,
    "outputArtifactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "completedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    CONSTRAINT "GenerationAttemptRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GenerationAttemptRecord_generationRequestId_fkey" FOREIGN KEY ("generationRequestId") REFERENCES "GenerationRequestRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GenerationAttemptRecord_preflightReportId_fkey" FOREIGN KEY ("preflightReportId") REFERENCES "PreflightReportRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GenerationAttemptRecord_userApprovalId_fkey" FOREIGN KEY ("userApprovalId") REFERENCES "UserApprovalRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "VersionedEntity_projectId_entityType_status_idx" ON "VersionedEntity"("projectId", "entityType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VersionedEntity_projectId_entityType_entityKey_version_key" ON "VersionedEntity"("projectId", "entityType", "entityKey", "version");

-- CreateIndex
CREATE INDEX "ArtifactRecord_projectId_integrityStatus_idx" ON "ArtifactRecord"("projectId", "integrityStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactRecord_projectId_relativePath_key" ON "ArtifactRecord"("projectId", "relativePath");

-- CreateIndex
CREATE INDEX "WorkflowBlockerRecord_projectId_resolvedAt_idx" ON "WorkflowBlockerRecord"("projectId", "resolvedAt");

-- CreateIndex
CREATE INDEX "GenerationRequestRecord_projectId_clipId_status_idx" ON "GenerationRequestRecord"("projectId", "clipId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRequestRecord_projectId_requestHash_key" ON "GenerationRequestRecord"("projectId", "requestHash");

-- CreateIndex
CREATE INDEX "PreflightReportRecord_projectId_status_idx" ON "PreflightReportRecord"("projectId", "status");

-- CreateIndex
CREATE INDEX "UserApprovalRecord_projectId_status_idx" ON "UserApprovalRecord"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationAttemptRecord_userApprovalId_key" ON "GenerationAttemptRecord"("userApprovalId");

-- CreateIndex
CREATE INDEX "GenerationAttemptRecord_projectId_status_idx" ON "GenerationAttemptRecord"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationAttemptRecord_clipId_attemptNumber_key" ON "GenerationAttemptRecord"("clipId", "attemptNumber");
