-- CreateTable
CREATE TABLE "ProviderIdentityRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "officialSourceUrl" TEXT,
    "publisher" TEXT,
    "packageName" TEXT,
    "executablePath" TEXT NOT NULL,
    "executableSha256" TEXT NOT NULL,
    "signatureInfo" TEXT,
    "cliVersion" TEXT NOT NULL,
    "rawVersionArtifactId" TEXT NOT NULL,
    "rawHelpArtifactId" TEXT NOT NULL,
    "officialLoginOriginsJson" TEXT NOT NULL,
    "capabilityFingerprint" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderIdentityRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderCapabilityRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerIdentityId" TEXT,
    "cliFound" BOOLEAN NOT NULL,
    "authenticated" TEXT NOT NULL,
    "supportedOperationsJson" TEXT NOT NULL,
    "supportedModelsJson" TEXT NOT NULL,
    "supportedDurationsMsJson" TEXT,
    "rawProbeArtifactId" TEXT NOT NULL,
    "capabilityFingerprint" TEXT NOT NULL,
    "probedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderCapabilityRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProviderCapabilityRecord_providerIdentityId_fkey" FOREIGN KEY ("providerIdentityId") REFERENCES "ProviderIdentityRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CommandAttemptRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "generationAttemptId" TEXT,
    "operation" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "exitCode" INTEGER,
    "signal" TEXT,
    "timedOut" BOOLEAN NOT NULL,
    "stdoutArtifactId" TEXT,
    "stderrArtifactId" TEXT,
    "redactionRulesVersion" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "errorCode" TEXT,
    "argvRedactedJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommandAttemptRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReviewDecisionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "clipHash" TEXT NOT NULL,
    "generationAttemptId" TEXT NOT NULL,
    "outputArtifactId" TEXT NOT NULL,
    "outputArtifactHash" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decidedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewDecisionRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProviderIdentityRecord_projectId_verificationStatus_idx" ON "ProviderIdentityRecord"("projectId", "verificationStatus");

-- CreateIndex
CREATE INDEX "ProviderIdentityRecord_executableSha256_idx" ON "ProviderIdentityRecord"("executableSha256");

-- CreateIndex
CREATE INDEX "ProviderCapabilityRecord_projectId_capabilityFingerprint_idx" ON "ProviderCapabilityRecord"("projectId", "capabilityFingerprint");

-- CreateIndex
CREATE INDEX "ProviderCapabilityRecord_providerIdentityId_idx" ON "ProviderCapabilityRecord"("providerIdentityId");

-- CreateIndex
CREATE INDEX "CommandAttemptRecord_projectId_operation_idx" ON "CommandAttemptRecord"("projectId", "operation");

-- CreateIndex
CREATE INDEX "CommandAttemptRecord_generationAttemptId_idx" ON "CommandAttemptRecord"("generationAttemptId");

-- CreateIndex
CREATE INDEX "ReviewDecisionRecord_projectId_clipId_decidedAt_idx" ON "ReviewDecisionRecord"("projectId", "clipId", "decidedAt");

-- CreateIndex
CREATE INDEX "ReviewDecisionRecord_generationAttemptId_idx" ON "ReviewDecisionRecord"("generationAttemptId");
