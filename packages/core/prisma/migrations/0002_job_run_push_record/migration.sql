-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "lastPushedSha" TEXT,
ADD COLUMN     "workBranch" TEXT;
