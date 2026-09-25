-- CreateTable
CREATE TABLE "deployment_task" (
    "deployment_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_task_pkey" PRIMARY KEY ("deployment_id","task_id")
);

-- CreateIndex
CREATE INDEX "deployment_task_task_id_idx" ON "deployment_task"("task_id");

-- AddForeignKey
ALTER TABLE "deployment_task" ADD CONSTRAINT "deployment_task_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_task" ADD CONSTRAINT "deployment_task_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
