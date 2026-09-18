-- CreateEnum
CREATE TYPE "ProjectLifecycle" AS ENUM ('planned', 'scaffolded', 'building', 'deployed', 'parked', 'scrapped');

-- CreateEnum
CREATE TYPE "PhaseStatus" AS ENUM ('planned', 'active', 'complete', 'parked');

-- CreateEnum
CREATE TYPE "Size" AS ENUM ('XS', 'S', 'M', 'L', 'XL');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'blocked', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('M', 'S', 'C', 'W');

-- CreateEnum
CREATE TYPE "EarsPattern" AS ENUM ('ubiquitous', 'state', 'event', 'unwanted', 'optional', 'complex', 'unparsed');

-- CreateEnum
CREATE TYPE "AdrStatus" AS ENUM ('proposed', 'accepted', 'superseded', 'rejected');

-- CreateEnum
CREATE TYPE "AdrRelationKind" AS ENUM ('extends', 'supersedes', 'superseded_by');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('open', 'fired', 'closed');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('architecture', 'data_model', 'api_contract', 'ux_flows', 'research', 'discovery', 'phase_plan', 'test_strategy', 'feature_ideas', 'overview', 'runbook');

-- CreateEnum
CREATE TYPE "AuditKind" AS ENUM ('code_review', 'design', 'feature', 'api');

-- CreateEnum
CREATE TYPE "AuditStatus" AS ENUM ('running', 'complete', 'abandoned');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateEnum
CREATE TYPE "Verified" AS ENUM ('confirmed', 'plausible');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('open', 'fixed', 'skipped', 'wont_fix');

-- CreateEnum
CREATE TYPE "CheckConclusion" AS ENUM ('success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'stale');

-- CreateEnum
CREATE TYPE "AttributionSource" AS ENUM ('declared', 'message', 'file_overlap');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('mapped', 'partial', 'unmapped');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ReferenceKind" AS ENUM ('cites', 'satisfies', 'violates', 'relates', 'supersedes');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('project', 'repo', 'phase', 'requirement', 'task', 'adr', 'decision', 'risk', 'term', 'document', 'document_section', 'audit', 'finding', 'commit', 'check_run', 'release', 'deployment', 'tech_item', 'user', 'api_token', 'job');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'update', 'delete', 'restore', 'undo');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('user', 'mcp', 'importer', 'webhook', 'system');

-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('password', 'oidc');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('invited', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "ThrottleScope" AS ENUM ('account', 'ip');

-- CreateTable
CREATE TABLE "project" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "lifecycle" "ProjectLifecycle" NOT NULL DEFAULT 'planned',
    "pitch" TEXT,
    "vault_path" TEXT,
    "id_counters" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "github_id" BIGINT,
    "backfilled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "number" DECIMAL(6,2) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "human_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT,
    "status" "PhaseStatus" NOT NULL DEFAULT 'planned',
    "exit_demo" TEXT,
    "size" "Size",
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "phase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_dependency" (
    "phase_id" UUID NOT NULL,
    "depends_on_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_dependency_pkey" PRIMARY KEY ("phase_id","depends_on_id")
);

-- CreateTable
CREATE TABLE "requirement" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "statement" TEXT NOT NULL,
    "ears_pattern" "EarsPattern" NOT NULL DEFAULT 'unparsed',
    "ears_lint_ok" BOOLEAN NOT NULL DEFAULT false,
    "ears_lint_note" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'M',
    "source" TEXT,
    "acceptance_test" TEXT,
    "phase_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID,
    "human_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "blocked_reason" TEXT,
    "size" "Size",
    "done_when" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "id_synthesized" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_file" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "path" TEXT NOT NULL,

    CONSTRAINT "task_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_requirement" (
    "task_id" UUID NOT NULL,
    "requirement_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_requirement_pkey" PRIMARY KEY ("task_id","requirement_id")
);

-- CreateTable
CREATE TABLE "adr" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AdrStatus" NOT NULL DEFAULT 'proposed',
    "decision_abstract" TEXT,
    "context_md" TEXT,
    "decision_md" TEXT,
    "consequences_md" TEXT,
    "rejected_md" TEXT,
    "decided_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "adr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adr_relation" (
    "adr_id" UUID NOT NULL,
    "related_adr_id" UUID NOT NULL,
    "kind" "AdrRelationKind" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adr_relation_pkey" PRIMARY KEY ("adr_id","related_adr_id","kind")
);

-- CreateTable
CREATE TABLE "decision" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "rationale" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "superseded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID,
    "human_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "likelihood" "RiskLevel" NOT NULL DEFAULT 'medium',
    "impact" "RiskLevel" NOT NULL DEFAULT 'medium',
    "mitigation" TEXT,
    "tripwire" TEXT,
    "status" "RiskStatus" NOT NULL DEFAULT 'open',
    "fired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "risk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "term" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID,
    "kind" "DocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "source_path" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_section" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "document_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_revision" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL DEFAULT 'user',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "human_id" TEXT NOT NULL,
    "kind" "AuditKind" NOT NULL,
    "scope" TEXT,
    "run_date" DATE NOT NULL,
    "verdict" TEXT,
    "rounds" INTEGER NOT NULL DEFAULT 1,
    "status" "AuditStatus" NOT NULL DEFAULT 'running',
    "vault_path" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "audit_id" UUID,
    "human_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lenses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "severity" "Severity" NOT NULL,
    "confidence" TEXT,
    "verified" "Verified",
    "status" "FindingStatus" NOT NULL DEFAULT 'open',
    "found_round" INTEGER,
    "fixed_round" INTEGER,
    "fixed_commit_sha" TEXT,
    "effort" TEXT,
    "location_path" TEXT,
    "location_lines" TEXT,
    "observed_md" TEXT,
    "recommendation_md" TEXT,
    "requirement_id" UUID,
    "adr_id" UUID,
    "phase_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commit" (
    "id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "author_email" TEXT,
    "committed_at" TIMESTAMPTZ(6) NOT NULL,
    "additions" INTEGER,
    "deletions" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commit_file" (
    "id" UUID NOT NULL,
    "commit_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "additions" INTEGER,
    "deletions" INTEGER,

    CONSTRAINT "commit_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commit_task" (
    "commit_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "source" "AttributionSource" NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by" TEXT,
    "rejected_at" TIMESTAMPTZ(6),
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commit_task_pkey" PRIMARY KEY ("commit_id","task_id")
);

-- CreateTable
CREATE TABLE "check_run" (
    "id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conclusion" "CheckConclusion",
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "details_url" TEXT,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release" (
    "id" UUID NOT NULL,
    "repo_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "name" TEXT,
    "body_md" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "prerelease" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "image_sha" TEXT NOT NULL,
    "schema_revision" TEXT,
    "deployed_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_item" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "version" TEXT,
    "role" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "tech_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference" (
    "id" UUID NOT NULL,
    "from_type" "EntityType" NOT NULL,
    "from_id" UUID NOT NULL,
    "to_type" "EntityType" NOT NULL,
    "to_id" UUID NOT NULL,
    "kind" "ReferenceKind" NOT NULL DEFAULT 'cites',
    "cited_as" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_kind" "ActorKind" NOT NULL DEFAULT 'user',
    "action" "AuditAction" NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_human_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "undone_at" TIMESTAMPTZ(6),
    "undone_by_event_id" UUID,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_record" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "source_path" TEXT NOT NULL,
    "entity_type" "EntityType",
    "entity_id" UUID,
    "status" "ImportStatus" NOT NULL,
    "note" TEXT,
    "source_bytes" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'invited',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totp_secret" TEXT,
    "totp_confirmed_at" TIMESTAMPTZ(6),
    "totp_last_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "iss" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "claims" JSONB,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" "AuthMethod" NOT NULL,
    "id_token_sub" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_throttle" (
    "scope" "ThrottleScope" NOT NULL,
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "next_allowed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_failure_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "lease_until" TIMESTAMPTZ(6),
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stage" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "job_stage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_code_key" ON "project"("code");

-- CreateIndex
CREATE UNIQUE INDEX "project_slug_key" ON "project"("slug");

-- CreateIndex
CREATE INDEX "project_lifecycle_idx" ON "project"("lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "repo_full_name_key" ON "repo"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "repo_github_id_key" ON "repo"("github_id");

-- CreateIndex
CREATE INDEX "repo_project_id_idx" ON "repo"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_human_id_key" ON "phase"("human_id");

-- CreateIndex
CREATE INDEX "phase_project_id_sort_order_idx" ON "phase"("project_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "phase_project_id_number_key" ON "phase"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_human_id_key" ON "requirement"("human_id");

-- CreateIndex
CREATE INDEX "requirement_project_id_priority_idx" ON "requirement"("project_id", "priority");

-- CreateIndex
CREATE INDEX "requirement_phase_id_idx" ON "requirement"("phase_id");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_project_id_seq_key" ON "requirement"("project_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "task_human_id_key" ON "task"("human_id");

-- CreateIndex
CREATE INDEX "task_project_id_status_idx" ON "task"("project_id", "status");

-- CreateIndex
CREATE INDEX "task_phase_id_sort_order_idx" ON "task"("phase_id", "sort_order");

-- CreateIndex
CREATE INDEX "task_file_path_idx" ON "task_file"("path");

-- CreateIndex
CREATE UNIQUE INDEX "task_file_task_id_path_key" ON "task_file"("task_id", "path");

-- CreateIndex
CREATE INDEX "task_requirement_requirement_id_idx" ON "task_requirement"("requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "adr_human_id_key" ON "adr"("human_id");

-- CreateIndex
CREATE INDEX "adr_project_id_status_idx" ON "adr"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "adr_project_id_number_key" ON "adr"("project_id", "number");

-- CreateIndex
CREATE INDEX "adr_relation_related_adr_id_idx" ON "adr_relation"("related_adr_id");

-- CreateIndex
CREATE UNIQUE INDEX "decision_human_id_key" ON "decision"("human_id");

-- CreateIndex
CREATE INDEX "decision_project_id_idx" ON "decision"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_human_id_key" ON "risk"("human_id");

-- CreateIndex
CREATE INDEX "risk_project_id_status_idx" ON "risk"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "term_project_id_term_key" ON "term"("project_id", "term");

-- CreateIndex
CREATE INDEX "document_project_id_kind_idx" ON "document"("project_id", "kind");

-- CreateIndex
CREATE INDEX "document_section_document_id_sort_order_idx" ON "document_section"("document_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "document_section_document_id_key_key" ON "document_section"("document_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "document_revision_document_id_revision_no_key" ON "document_revision"("document_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "audit_human_id_key" ON "audit"("human_id");

-- CreateIndex
CREATE INDEX "audit_project_id_kind_idx" ON "audit"("project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "finding_human_id_key" ON "finding"("human_id");

-- CreateIndex
CREATE INDEX "finding_project_id_status_idx" ON "finding"("project_id", "status");

-- CreateIndex
CREATE INDEX "finding_severity_status_idx" ON "finding"("severity", "status");

-- CreateIndex
CREATE INDEX "finding_audit_id_idx" ON "finding"("audit_id");

-- CreateIndex
CREATE INDEX "commit_repo_id_committed_at_idx" ON "commit"("repo_id", "committed_at");

-- CreateIndex
CREATE UNIQUE INDEX "commit_repo_id_sha_key" ON "commit"("repo_id", "sha");

-- CreateIndex
CREATE INDEX "commit_file_path_idx" ON "commit_file"("path");

-- CreateIndex
CREATE UNIQUE INDEX "commit_file_commit_id_path_key" ON "commit_file"("commit_id", "path");

-- CreateIndex
CREATE INDEX "commit_task_task_id_confirmed_idx" ON "commit_task"("task_id", "confirmed");

-- CreateIndex
CREATE INDEX "commit_task_confirmed_idx" ON "commit_task"("confirmed");

-- CreateIndex
CREATE INDEX "check_run_repo_id_completed_at_idx" ON "check_run"("repo_id", "completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_run_repo_id_commit_sha_name_key" ON "check_run"("repo_id", "commit_sha", "name");

-- CreateIndex
CREATE UNIQUE INDEX "release_repo_id_tag_key" ON "release"("repo_id", "tag");

-- CreateIndex
CREATE INDEX "deployment_project_id_deployed_at_idx" ON "deployment"("project_id", "deployed_at");

-- CreateIndex
CREATE INDEX "tech_item_name_idx" ON "tech_item"("name");

-- CreateIndex
CREATE UNIQUE INDEX "tech_item_project_id_name_key" ON "tech_item"("project_id", "name");

-- CreateIndex
CREATE INDEX "reference_to_type_to_id_idx" ON "reference"("to_type", "to_id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_from_type_from_id_to_type_to_id_kind_key" ON "reference"("from_type", "from_id", "to_type", "to_id", "kind");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_event_created_at_idx" ON "audit_event"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_token_token_hash_key" ON "api_token"("token_hash");

-- CreateIndex
CREATE INDEX "api_token_revoked_at_idx" ON "api_token"("revoked_at");

-- CreateIndex
CREATE INDEX "import_record_job_id_status_idx" ON "import_record"("job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "import_record_job_id_source_path_key" ON "import_record"("job_id", "source_path");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "identity_user_id_idx" ON "identity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_iss_sub_key" ON "identity"("iss", "sub");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_expires_at_idx" ON "session"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_idempotency_key_key" ON "job"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_status_available_at_idx" ON "job"("status", "available_at");

-- CreateIndex
CREATE INDEX "job_kind_status_idx" ON "job"("kind", "status");

-- CreateIndex
CREATE INDEX "job_stage_job_id_sort_order_idx" ON "job_stage"("job_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "job_stage_job_id_name_key" ON "job_stage"("job_id", "name");

-- AddForeignKey
ALTER TABLE "repo" ADD CONSTRAINT "repo_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase" ADD CONSTRAINT "phase_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_dependency" ADD CONSTRAINT "phase_dependency_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_dependency" ADD CONSTRAINT "phase_dependency_depends_on_id_fkey" FOREIGN KEY ("depends_on_id") REFERENCES "phase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_file" ADD CONSTRAINT "task_file_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requirement" ADD CONSTRAINT "task_requirement_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_requirement" ADD CONSTRAINT "task_requirement_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adr" ADD CONSTRAINT "adr_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adr_relation" ADD CONSTRAINT "adr_relation_adr_id_fkey" FOREIGN KEY ("adr_id") REFERENCES "adr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adr_relation" ADD CONSTRAINT "adr_relation_related_adr_id_fkey" FOREIGN KEY ("related_adr_id") REFERENCES "adr"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision" ADD CONSTRAINT "decision_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk" ADD CONSTRAINT "risk_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk" ADD CONSTRAINT "risk_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_section" ADD CONSTRAINT "document_section_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit" ADD CONSTRAINT "audit_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "audit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_adr_id_fkey" FOREIGN KEY ("adr_id") REFERENCES "adr"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "phase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit" ADD CONSTRAINT "commit_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_file" ADD CONSTRAINT "commit_file_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_task" ADD CONSTRAINT "commit_task_commit_id_fkey" FOREIGN KEY ("commit_id") REFERENCES "commit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commit_task" ADD CONSTRAINT "commit_task_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_run" ADD CONSTRAINT "check_run_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release" ADD CONSTRAINT "release_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tech_item" ADD CONSTRAINT "tech_item_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_record" ADD CONSTRAINT "import_record_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity" ADD CONSTRAINT "identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage" ADD CONSTRAINT "job_stage_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
