-- Ideas: a thing somebody might build, before it is a plan.
--
-- Additive. Nothing reads the table until the console and the MCP verbs land, so an instance that
-- applies this and runs the previous image is unchanged.
--
-- The four statuses are taken from the "Feature Ideas & Future Development" documents four
-- projects already carry, not invented: Accepted, Parked ("good ideas, deliberately not now") and
-- Rejected ("do not re-litigate these"), plus `new` for one nobody has judged.

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('new', 'accepted', 'parked', 'rejected');

-- AlterEnum
ALTER TYPE "EntityType" ADD VALUE 'idea';

-- CreateTable
CREATE TABLE "idea" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "status" "IdeaStatus" NOT NULL DEFAULT 'new',
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "idea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idea_human_id_key" ON "idea"("human_id");

-- CreateIndex
CREATE INDEX "idea_project_id_status_idx" ON "idea"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "idea_project_id_seq_key" ON "idea"("project_id", "seq");

-- AddForeignKey
ALTER TABLE "idea" ADD CONSTRAINT "idea_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
