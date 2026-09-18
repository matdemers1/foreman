# Foreman

A plan-vs-reality ledger for the [D3 Cloud](https://d3cloud.io) ecosystem.

Foreman holds the structured state of every project — requirements, phases, tasks, architecture decisions, audit findings and documents — and exposes it through two surfaces designed as equal peers:

- a **React console** for reading and steering, and
- an **MCP server**, so an AI coding agent can query and update project state from inside a session.

It answers questions a folder of markdown cannot: *where are we on this project, what should I work on next, what's still open across everything I own, and is the plan still true?*

## Why

Its predecessor was an Obsidian vault of 534 markdown files. The problem was never markdown — it was that **one project accounted for 39% of the files** while four had none, the largest dataset (127 audit findings) was the most deeply buried, and **no question could be asked across projects**.

Two traceability chains were already being maintained by hand in YAML frontmatter:

```
Requirement ──> Task ──> Commit ──> Check run
Finding ──> File:line ──> Fix commit ──> ADR
```

Foreman makes them first-class, linked and queryable.

## What it does

**Plan vs reality** — live coverage holes (a Must with no task, a task with no requirement), commit→task attribution, phase exit gates, stale-work detection.
**Cross-project** — portfolio dashboard, ADR search, lifecycle as data, tech inventory.
**Findings** — a cross-project open-findings inbox, fix→CI verification, and recurring-finding detection that proposes a defect class found in one project as a check against the others.
**Agent-facing** — a session brief in a few hundred tokens, write-back so state stays current as work lands, confirmation before anything irreversible, and documents fetched per section rather than whole.

## What it deliberately is not

Not a team task tracker. No sprints, velocity, story points or burndown. No time tracking. No assignees, comments or notifications. No due dates or Gantt charts. No freeform wiki. No public or client-facing views. No general issue tracking — it reads GitHub, it doesn't replace it.

And **the server never calls a language model.** Claude is Foreman's user, not its dependency.

## Stack

Node 22 · TypeScript strict · Express · Prisma · PostgreSQL 16 · React 19 + Vite 7 + `@d3cloud/ui` · MCP spec 2026-07-28 · pnpm workspaces · Docker Compose.

Authentication is **dual** — app-native credentials *and* "Sign in with D3 Auth" (OIDC) — so the app stays runnable by anyone who clones it, not only inside one deployment.

## Status

**Planned, not yet implemented.** 152 requirements, 11 phases, 112 tasks. Planning lives in `../D3 Cloud Vault/Foreman/`; start with `Scope of Work.md`.

## Getting started

Nothing to run yet — Phase 0 creates the working stack. Once it exists:

```bash
pnpm install
pnpm dev:up
pnpm seed:example
```

## License

Private. Not currently licensed for redistribution.
