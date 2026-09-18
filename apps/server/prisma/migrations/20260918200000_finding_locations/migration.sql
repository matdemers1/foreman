-- Phase 6: the real findings corpus does not fit two flat location columns.
--
-- 28 of 127 real findings name more than one file and eleven name several ranges within one, so
-- `location_path` + `location_lines` can hold the first path and silently lose the rest. The
-- raw string is kept verbatim beside the parsed rows, because a real location carries prose that
-- no parse should discard.

ALTER TYPE "Verified" ADD VALUE IF NOT EXISTS 'unverified';
ALTER TYPE "FindingStatus" ADD VALUE IF NOT EXISTS 'deferred';

CREATE TABLE "finding_location" (
    "id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "lines" TEXT,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "changed_since_fix_at" TIMESTAMPTZ(6),
    CONSTRAINT "finding_location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "finding_location_finding_id_path_key" ON "finding_location"("finding_id", "path");
CREATE INDEX "finding_location_path_idx" ON "finding_location"("path");

ALTER TABLE "finding_location"
    ADD CONSTRAINT "finding_location_finding_id_fkey"
    FOREIGN KEY ("finding_id") REFERENCES "finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "finding" ADD COLUMN "location_raw" TEXT;

-- Carry what is already stored across rather than dropping it: a migration that loses a column's
-- contents is a migration somebody has to notice, and nobody does until the data is wanted.
UPDATE "finding"
   SET "location_raw" = CONCAT_WS(':', "location_path", "location_lines")
 WHERE "location_path" IS NOT NULL;

INSERT INTO "finding_location" ("id", "finding_id", "path", "lines", "sort_order")
SELECT gen_random_uuid(), "id", "location_path", "location_lines", 0
  FROM "finding"
 WHERE "location_path" IS NOT NULL;

ALTER TABLE "finding" DROP COLUMN "location_path";
ALTER TABLE "finding" DROP COLUMN "location_lines";
