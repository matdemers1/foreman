---
aliases:
  - Bindery ADR-002
tags: [type/adr, project/bindery, status/active, tech/postgres, tech/python]
project: bindery
adr: 2
decision-status: accepted
created: 2026-08-27
updated: 2026-08-27
---

# ADR-002 — Postgres Job Queue with Replayable Pipeline Stages

> [!abstract] Decision
> The pipeline runs on a **Postgres-backed job queue** using `SELECT … FOR UPDATE SKIP LOCKED` — no Redis, no broker. **Every stage persists its output artifact and is independently replayable**, keyed on `(source_file_id, stage, prompt_version)`.

## Context

- Volume is 200–500 documents/month with jobs measured in seconds to minutes. Durability and visibility matter far more than throughput.
- Host is a single ZimaOS box: 16 GB RAM, AMD Ryzen, 16 TB. Every additional container costs RAM that OCR wants.
- Reprocessing is the fastest-scaling cost line in the [[Bindery/Research Notes#Cost Model|cost model]] — a full re-classification of 5,000 documents is ~$80 on Opus 5, and OCR is the slow, CPU-expensive stage.
- Prompts, OCR settings, and segmentation heuristics will all be tuned repeatedly over the system's life.
- Precedent: Someday Vault chose Postgres-backed scheduling over Redis for the same reasons.

## Decision

1. **Queue in Postgres.** `job` table consumed with `SKIP LOCKED`; exponential backoff; permanent failures land in a visible dead-letter state, never silently dropped.
2. **The `job` table is the observability surface.** "What is stuck and why" is a SQL query, and the in-app health panel reads it directly.
3. **Nine stages, each persisting its artifact** under `/data/derived/<sha256>/`: ingest · normalize (OCR) · page · segment · embed · classify · rules · file · mirror.
4. **Every stage is individually re-runnable** against its stored input. Re-classify without re-OCR. Re-segment without re-ingest. Re-render without anything.
5. **`prompt_version` is recorded per classification**, making "reprocess everything still on v2" a targeted query rather than an all-or-nothing re-run.
6. Worker concurrency: **3–4 OCR slots**, sized to the host.

## Consequences

- ✅ One fewer container, no broker to operate, no split-brain between job state and application state.
- ✅ Model and OCR improvement become **incremental and affordable** for the life of the project. This is the single highest-value architectural decision in the plan.
- ✅ Crash recovery is free — an interrupted job's lock expires and it is retried.
- ✅ Debugging months later is possible: the exact input the model saw is on disk.
- ⚠️ Meaningful disk consumption for derived artifacts (page renders dominate). Acceptable against 16 TB, and the mirror tree and renders are both regenerable if space is ever wanted back.
- ⚠️ Postgres queue polling adds load to the same database serving search. At this volume it is negligible; at 100× it would need revisiting.
- ❌ Rejected: **Celery + Redis** — mature and battle-tested, but its throughput is irrelevant here and it adds Redis plus Celery's own operational surface.
- ❌ Rejected: **arq** — lighter than Celery but still needs Redis, and job state would live outside Postgres, so "show me every stuck document" would span two stores.

## See Also
- [[Bindery/Architecture|Architecture]] · [[Bindery/Data Model|Data Model]] · [[Bindery/ADR-003 — Claude Behind an Adapter with an ID-Constrained Taxonomy Contract|ADR-003]]
