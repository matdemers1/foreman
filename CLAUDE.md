# CLAUDE.md — Foreman

Plan-vs-reality ledger for the D3 Cloud ecosystem. Replaces the Obsidian vault as the source of truth for structured project state — requirements, phases, tasks, ADRs, audit findings, documents — behind two equal-peer surfaces: a React console and an **MCP server**. Read this file, then the vault, before writing code.

## Where the plan lives
All planning is in `../D3 Cloud Vault/Foreman/`.
- **Scope of Work.md** — phases P0–P10, every task with `FRM-REQ` ids; check tasks off as they land.
- **Requirements Register.md** — `FRM-REQ-001`…`FRM-REQ-152` in EARS notation, the traceability spine.
- **Architecture.md**, **Data Model.md**, **API Contract.md**, **UX Flows & Screen Inventory.md**, **Glossary.md**.
- **ADR-001** Node/Express/Prisma over Python/FastAPI · **ADR-002** a small verb surface over a large graph · **ADR-003** local stdio shim, not a remote MCP server · **ADR-004** dual login as a permanent ecosystem pattern · **ADR-005** attribution is declared, not inferred · **ADR-006** five registers are views, not documents · **ADR-007** database backup as the only escape hatch · **ADR-008** project-prefixed human IDs · **ADR-009** one cutover, not a migration window.
- **Risk Register.md**, **Test Strategy.md**, **Phase Plans/** — open the phase plan before starting a phase.
Start a session with `/start-development foreman`.

## Stack (locked)
Node 22 (ESM, TypeScript strict) · Express · Prisma + PostgreSQL 16 · React 19 + Vite 7 + `@d3cloud/ui` (console served as statics by the server) · MCP TypeScript SDK, spec **2026-07-28** · `argon2` · `otpauth` · `@d3cloud/auth-client` · Vitest · Playwright · pnpm 10 workspaces.

## Layout
```
apps/server            Express API, Prisma schema + migrations, dual auth, webhook receiver,
                       CLI (import, backup, reconcile, issue-token, seed-example)
apps/web               React console, served as statics by the server
apps/worker            job-queue drain: ingest, attribution, scans, reconcile, backup
packages/shared        domain types + generated API client + EARS parser — the single
                       source of truth for every entity shape
packages/mcp           @d3cloud/foreman-mcp — publishable stdio shim
fixtures/vault         real vault files copied in, for golden importer tests
docs/runbooks          deploy, backup-restore, github-app-setup, import
```

## Commands (once scaffolded per Phase 0)
```bash
pnpm install
pnpm dev:up                # writes .env if missing, builds, migrates, seeds the example project
pnpm seed:example          # disposable project exercising every entity and enum
pnpm dev:down
pnpm lint && pnpm typecheck && pnpm test          # what CI runs first
DATABASE_URL=postgresql://foreman:foreman@127.0.0.1:5432/foreman_test pnpm --filter foreman-server test:integration
pnpm e2e
pnpm import -- --dry-run --path "../D3 Cloud Vault"   # never without --dry-run until P10
```

## Non-negotiables
- **`packages/shared` is the single source of truth.** Every entity declared once; API validation, console types and **MCP tool schemas are generated from it**. A contract test asserts the MCP schemas match (`FRM-REQ-081`).
- **An unconfirmed attribution is never truth.** No coverage, status, brief or drift calculation may read a `commit_task` row with `confirmed = false`. A file-path coincidence must never mark work complete. Never-regress test #1.
- **The importer never silently drops a file.** Every source file appears in the reconciliation report as mapped, partial or unmapped, with a reason. Silence is the failure mode. Never-regress test #2.
- **The server never calls an LLM.** No AI SDK in any `package.json`. Claude is Foreman's *user*, via MCP — not its dependency. A test enforces this (`FRM-REQ-013`).
- **At most 12 MCP tools**, and total tool-definition size stays inside its token budget — both asserted by contract tests. Long content goes through **resources** (`foreman://<code>/architecture#deployment`), never tool output.
- **Dual login, both paths always.** App-native (Argon2id + pepper + TOTP) *and* D3 Auth OIDC. Identities link by `(iss, sub)`, **never by email**. One e2e test asserts the password path still works with the issuer unreachable.
- **`phase.number` is `numeric`** (Bindery shipped a Phase 8.5) and **`phase.sort_order` is independent of it** (Bindery built 0–8.5, 9–11, 13–16, with P12 still ahead).
- **`requirement.phase_id` is nullable** — an unassigned requirement is the backlog.
- **`human_id` is immutable once assigned**, project-prefixed and globally unique. Renumbering breaks every citation in every document body.
- **EARS lint warns, never blocks.** A non-conforming requirement is stored with a warning.
- **Every mutation writes an `audit_event`** — MCP writes and importer writes included — and every mutation is undoable. Soft delete only. Logs never contain tokens, secrets or password material.
- **Irreversible or regressive MCP writes ask first**, via the 2026-07-28 MRTR `input_required` round-trip. Forward progress does not.
- **No host ports.** Cloudflare Tunnel only.
- **No time estimates** anywhere — T-shirt sizes and dependency order only.
- **No Co-Authored-By** or AI attribution in commits.

## Anti-features — do not build these
No sprints, velocity, story points or burndown · no time tracking · **no freeform wiki or note-taking** (the guardrail that stops Foreman decaying back into the vault) · no multi-user collaboration, comments, assignees or notifications · no public, client-facing or shareable views · no general issue or bug tracking · no due dates, Gantt or scheduling · no drag-and-drop as the primary interface · no pull-request ingestion · no server-side LLM call · no Redis.

Each of these is recorded as a requirement asserting its **absence**, so it cannot quietly arrive: `FRM-REQ-013`, `030`, `041`, `099`, `125`, `135`.

## Cross-repo work
| Repo | What | Phase |
|---|---|---|
| `d3-design-system` | `Table`/`DataGrid` in `@d3cloud/ui` → v1.2 | P0 (T-0.9) |
| `d3-auth` | register Foreman as an OIDC client | P0 (T-0.8) |
| `.claude/skills/` | rewrite all five vault-writing skills | P10 only |

## Conventions
- Update the vault SOW as tasks land; write an ADR for any deviation from the plan.
- `d3-check-usage` runs on the console: tokens only, no raw hex, no shadows.
- Development runs against the **disposable example project**. The real corpus is imported once, in P10, and not before.
