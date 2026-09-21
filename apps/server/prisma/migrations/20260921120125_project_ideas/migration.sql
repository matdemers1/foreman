-- Project ideas: something that might become a project, before it is one.
--
-- Additive, and reachable by nothing until the routes and the screen land, so an instance that
-- applies this and runs the previous image is unchanged.
--
-- The sequence at the bottom is the part Prisma does not know about. Every other human ID in
-- Foreman is counted on the project it belongs to; a project idea belongs to none, so there is no
-- row to count against and no row to lock. `nextval` is atomic, never reuses a number even when a
-- transaction rolls back, and is dumped and restored with its position intact — which is exactly
-- the contract a human ID needs (ADR-008: an ID is never reused, because every citation of it
-- would otherwise point at something else).

-- CreateEnum
CREATE TYPE "ProjectIdeaStatus" AS ENUM ('new', 'considering', 'parked', 'rejected', 'converted');

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'project_idea';

-- CreateTable
CREATE TABLE "project_idea" (
    "id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "pitch" TEXT,
    "status" "ProjectIdeaStatus" NOT NULL DEFAULT 'new',
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "project_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_idea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_idea_human_id_key" ON "project_idea"("human_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_idea_seq_key" ON "project_idea"("seq");

-- CreateIndex
CREATE INDEX "project_idea_status_idx" ON "project_idea"("status");

-- AddForeignKey
ALTER TABLE "project_idea" ADD CONSTRAINT "project_idea_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The allocator for `human_id`. Owned by the column so a drop of the table takes it too.
CREATE SEQUENCE "project_idea_seq" AS integer START WITH 1 OWNED BY "project_idea"."seq";
