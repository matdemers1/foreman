-- AlterTable
ALTER TABLE "commit" ADD COLUMN     "orphaned_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "commit_repo_id_orphaned_at_idx" ON "commit"("repo_id", "orphaned_at");
