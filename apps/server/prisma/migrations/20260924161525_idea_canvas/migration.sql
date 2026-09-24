-- The idea canvas (FRM-ADR-017): named, prompted sections, a few structured lists, and a
-- 1–5 measure of how much you want to do it — so a project idea can grow from a line into
-- something worth converting.
--
-- Additive and nullable throughout, with empty-list defaults on the lists, so every existing idea
-- reads as an idea whose canvas has not been started — which is exactly what it is.
--
-- `excitement` is range-checked here as well as in the schema layer. The API is not the only
-- writer: the importer, a restore, and an operator in psql all reach this table, and a 7 would
-- quietly break every chart that assumes five.

-- AlterTable
ALTER TABLE "project_idea" ADD COLUMN     "approach" TEXT,
ADD COLUMN     "audience" TEXT,
ADD COLUMN     "excitement" INTEGER,
ADD COLUMN     "links" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "next_steps" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "problem" TEXT,
ADD COLUMN     "questions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "related" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "risks" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "why_now" TEXT;

-- CreateIndex
CREATE INDEX "project_idea_tags_idx" ON "project_idea" USING GIN ("tags");

ALTER TABLE "project_idea" ADD CONSTRAINT "project_idea_excitement_range"
  CHECK ("excitement" IS NULL OR ("excitement" BETWEEN 1 AND 5));
