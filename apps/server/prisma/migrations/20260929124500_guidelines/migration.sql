-- Guidelines: standing decisions that apply to every project (FRM-REQ-186).
--
-- Additive, and reachable by nothing until the routes land. Like `project_idea`, a guideline
-- belongs to no project, so its human ID is drawn from a sequence rather than a project counter —
-- `nextval` never hands back a number twice, which is the contract a human ID needs (ADR-008).

-- CreateEnum
CREATE TYPE "GuidelineStatus" AS ENUM ('active', 'retired');

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'guideline';

-- CreateTable
CREATE TABLE "guideline" (
    "id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT,
    "guidance" TEXT,
    "status" "GuidelineStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "guideline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guideline_human_id_key" ON "guideline"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "guideline_seq_key" ON "guideline"("seq");

-- CreateIndex
CREATE INDEX "guideline_status_idx" ON "guideline"("status");

-- The allocator for `human_id`. Owned by the column so a drop of the table takes it too.
CREATE SEQUENCE "guideline_seq" AS integer START WITH 1 OWNED BY "guideline"."seq";
