-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL_SUMMARY');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('QUEUED', 'PREPARING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkspaceKind" AS ENUM ('CHAT', 'JOB');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('CREATING', 'READY', 'BUSY', 'STOPPING', 'DESTROYED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('QUEUED', 'PREPARING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "SecretKey" AS ENUM ('GITHUB_PAT', 'OPENAI_API_KEY');

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ChatStatus" NOT NULL DEFAULT 'ACTIVE',
    "repoUrl" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "workBranch" TEXT,
    "lastPushedSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "turnId" TEXT,
    "seq" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Turn" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "status" "TurnStatus" NOT NULL DEFAULT 'QUEUED',
    "model" TEXT NOT NULL,
    "queueJobId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "kind" "WorkspaceKind" NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'CREATING',
    "chatId" TEXT,
    "runnerKind" TEXT NOT NULL,
    "runnerRef" TEXT,
    "image" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "prompt" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "status" "JobRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "JobRunTrigger" NOT NULL,
    "model" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCallLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "turnId" TEXT,
    "jobRunId" TEXT,
    "callId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "resultHead" TEXT,
    "resultBytes" INTEGER,
    "exitCode" INTEGER,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "ToolCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Secret" (
    "key" "SecretKey" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "last4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Chat_status_updatedAt_idx" ON "Chat"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_chatId_seq_key" ON "Message"("chatId", "seq");

-- CreateIndex
CREATE INDEX "Turn_chatId_queuedAt_idx" ON "Turn"("chatId", "queuedAt");

-- CreateIndex
CREATE INDEX "Turn_status_idx" ON "Turn"("status");

-- CreateIndex
CREATE INDEX "Workspace_status_lastActiveAt_idx" ON "Workspace"("status", "lastActiveAt");

-- CreateIndex
CREATE INDEX "Workspace_chatId_idx" ON "Workspace"("chatId");

-- CreateIndex
CREATE INDEX "ScheduledJob_enabled_nextRunAt_idx" ON "ScheduledJob"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_workspaceId_key" ON "JobRun"("workspaceId");

-- CreateIndex
CREATE INDEX "JobRun_jobId_queuedAt_idx" ON "JobRun"("jobId", "queuedAt");

-- CreateIndex
CREATE INDEX "ToolCallLog_turnId_seq_idx" ON "ToolCallLog"("turnId", "seq");

-- CreateIndex
CREATE INDEX "ToolCallLog_jobRunId_seq_idx" ON "ToolCallLog"("jobRunId", "seq");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Turn" ADD CONSTRAINT "Turn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ScheduledJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCallLog" ADD CONSTRAINT "ToolCallLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCallLog" ADD CONSTRAINT "ToolCallLog_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCallLog" ADD CONSTRAINT "ToolCallLog_jobRunId_fkey" FOREIGN KEY ("jobRunId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariant: at most one live workspace per chat (hand-written; Prisma cannot express partial indexes).
CREATE UNIQUE INDEX "Workspace_one_live_per_chat" ON "Workspace"("chatId") WHERE status IN ('CREATING','READY','BUSY','STOPPING') AND "chatId" IS NOT NULL;
