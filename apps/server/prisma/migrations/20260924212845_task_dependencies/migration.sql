-- Task dependencies (FRM-P-11, FRM-REQ-179, FRM-REQ-180).
--
-- Phases could depend on phases from the first migration; tasks could only be sorted. The brief's
-- "next tasks" therefore meant "not blocked, in sort order", which offered a task beside the one it
-- needs. Additive: no existing task gains an edge, so every brief reads exactly as it did before.
--
-- A task depending on itself is refused here as well as in the domain layer, for the same reason
-- the idea canvas range-checks `excitement`: the API is not the only writer. Cycles and
-- cross-project edges need a walk, so those stay in the domain layer, which names the path.

-- AlterEnum
ALTER TYPE "ReferenceKind" ADD VALUE 'depends_on';

-- CreateTable
CREATE TABLE "task_dependency" (
    "task_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_dependency_pkey" PRIMARY KEY ("task_id","depends_on_id")
);

-- CreateIndex
CREATE INDEX "task_dependency_depends_on_id_idx" ON "task_dependency"("depends_on_id");

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A task cannot wait on itself.
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_not_self" CHECK ("task_id" <> "depends_on_id");
