-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AiProviderConfigRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "defaultModelId" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 180000,
    "maxRetries" INTEGER NOT NULL DEFAULT 1,
    "hasSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AiProviderConfigRecord" ("baseUrl", "configVersion", "createdAt", "defaultModelId", "enabled", "hasSecret", "id", "name", "updatedAt") SELECT "baseUrl", "configVersion", "createdAt", "defaultModelId", "enabled", "hasSecret", "id", "name", "updatedAt" FROM "AiProviderConfigRecord";
DROP TABLE "AiProviderConfigRecord";
ALTER TABLE "new_AiProviderConfigRecord" RENAME TO "AiProviderConfigRecord";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
