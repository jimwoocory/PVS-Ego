-- CreateTable
CREATE TABLE "AiProviderConfigRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "defaultModelId" TEXT,
    "hasSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiModelRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL,
    "discoveredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiModelRecord_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProviderConfigRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiSystemPreferenceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "defaultProviderId" TEXT,
    "defaultModelId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProjectAiPreferenceRecord" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "defaultProviderId" TEXT,
    "defaultModelId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectAiPreferenceRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StepModelOverrideRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StepModelOverrideRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiExecutionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "outputHash" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "AiExecutionRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AiModelRecord_providerId_enabled_idx" ON "AiModelRecord"("providerId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelRecord_providerId_modelId_key" ON "AiModelRecord"("providerId", "modelId");

-- CreateIndex
CREATE INDEX "StepModelOverrideRecord_projectId_idx" ON "StepModelOverrideRecord"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "StepModelOverrideRecord_projectId_step_key" ON "StepModelOverrideRecord"("projectId", "step");

-- CreateIndex
CREATE INDEX "AiExecutionRecord_projectId_step_createdAt_idx" ON "AiExecutionRecord"("projectId", "step", "createdAt");

-- CreateIndex
CREATE INDEX "AiExecutionRecord_providerId_modelId_idx" ON "AiExecutionRecord"("providerId", "modelId");
