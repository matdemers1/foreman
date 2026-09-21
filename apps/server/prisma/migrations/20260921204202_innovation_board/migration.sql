-- The innovation-fund board (FRM-ADR-016): roles, invites, scoring, discussion and a funded
-- amount, so a second deployment of this codebase can run a board that several people use.
--
-- Additive. Nothing reads any of it unless `FOREMAN_MODE=board`, so an instance that applies this
-- and runs the previous image is unchanged, and the solo instance stays a solo instance.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'reviewer', 'submitter');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EntityType" ADD VALUE 'idea_score';
ALTER TYPE "EntityType" ADD VALUE 'idea_comment';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


-- `BEFORE 'parked'`, not appended. Postgres orders an enum by its position in the type, and
-- `order by status` is what puts untriaged submissions at the top of the board. Appended, these
-- two would sort after `converted` and a funded idea would rank below a rejected one.
ALTER TYPE "ProjectIdeaStatus" ADD VALUE 'shortlisted' BEFORE 'parked';
ALTER TYPE "ProjectIdeaStatus" ADD VALUE 'funded' BEFORE 'parked';

-- AlterTable
ALTER TABLE "project_idea" ADD COLUMN     "funded_amount_cents" INTEGER,
ADD COLUMN     "submitted_by_id" UUID;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'submitter';

-- Everyone who already had an account had unrestricted access, because there was nothing to
-- restrict: `requireAuth` checked only that a session existed. Defaulting them to `submitter`
-- would not be tightening security, it would be locking the operator out of their own instance.
-- New accounts still default to the least privilege; this promotes only what predates roles.
UPDATE "user" SET "role" = 'admin';

-- CreateTable
CREATE TABLE "idea_score" (
    "id" UUID NOT NULL,
    "project_idea_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "impact" INTEGER NOT NULL,
    "effort" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idea_score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_comment" (
    "id" UUID NOT NULL,
    "project_idea_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "idea_comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "invited_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idea_score_project_idea_id_idx" ON "idea_score"("project_idea_id");

-- CreateIndex
CREATE UNIQUE INDEX "idea_score_project_idea_id_user_id_key" ON "idea_score"("project_idea_id", "user_id");

-- CreateIndex
CREATE INDEX "idea_comment_project_idea_id_internal_idx" ON "idea_comment"("project_idea_id", "internal");

-- CreateIndex
CREATE UNIQUE INDEX "invite_user_id_key" ON "invite"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_token_hash_key" ON "invite"("token_hash");

-- CreateIndex
CREATE INDEX "invite_expires_at_idx" ON "invite"("expires_at");

-- CreateIndex
CREATE INDEX "project_idea_submitted_by_id_idx" ON "project_idea"("submitted_by_id");

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- AddForeignKey
ALTER TABLE "project_idea" ADD CONSTRAINT "project_idea_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_score" ADD CONSTRAINT "idea_score_project_idea_id_fkey" FOREIGN KEY ("project_idea_id") REFERENCES "project_idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_score" ADD CONSTRAINT "idea_score_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_comment" ADD CONSTRAINT "idea_comment_project_idea_id_fkey" FOREIGN KEY ("project_idea_id") REFERENCES "project_idea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idea_comment" ADD CONSTRAINT "idea_comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite" ADD CONSTRAINT "invite_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
