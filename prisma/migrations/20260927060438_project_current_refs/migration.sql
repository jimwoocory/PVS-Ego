-- AlterTable
ALTER TABLE "Project" ADD COLUMN "currentCreativeBatchHash" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentCreativeBatchId" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentCreativeBatchVersion" INTEGER;
ALTER TABLE "Project" ADD COLUMN "currentProductTruthHash" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentProductTruthId" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentProductTruthVersion" INTEGER;
ALTER TABLE "Project" ADD COLUMN "currentProductionPlanHash" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentProductionPlanId" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentProductionPlanVersion" INTEGER;
ALTER TABLE "Project" ADD COLUMN "currentScriptHash" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentScriptId" TEXT;
ALTER TABLE "Project" ADD COLUMN "currentScriptVersion" INTEGER;
ALTER TABLE "Project" ADD COLUMN "selectedCreativeId" TEXT;
