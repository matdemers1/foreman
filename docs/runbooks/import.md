# Importing the vault

ADR-009: **one cutover, not a migration window.** The real corpus is imported once, in Phase 10,
and not before — development runs against the disposable `EXMP` project. Every run before then is a
dry run against a copy.

## The safe default

```bash
cd apps/server && pnpm run import -- --path "../../../D3 Cloud Vault"
```

`--dry-run` is not a flag: **not writing is the default**, and writing requires `--write`. The flag
that protects the vault should not be one you have to remember.

| Flag | What it does |
|---|---|
| `--path <dir>` | The vault root. Required. |
| `--only A,B` | Import only these project folders. A project inside `Personal Projects/` is named by its own folder — `--only Subtitler`. |
| `--write` | Actually write. Without it, nothing is created or changed. |
| `--json out.json` | The whole report, including every citation rewritten. |

## Reading the report

The report's contract is that **every file is accounted for** — mapped, partial, or unmapped with a
reason — and the totals equal the input count exactly. Silence is the failure mode: a file that
vanishes between the vault and the database is the one thing this exists to make impossible.

```
535 files: 513 mapped, 22 partial, 0 unmapped
every file is accounted for (535 of 535)
```

- **mapped** — read, and everything it holds was understood.
- **partial** — read, and something was not. The reason says what: "no headings to split into
  sections", "rows parsed, but none had a term and a definition column".
- **unmapped** — read, and **nothing** was found in it. An empty file, in practice.

If that last line ever says `MISSING`, stop: files are being dropped, and the report is the only
place that shows it.

**A file can map and a project still be wrong.** The report counts files, and d3cloud.io's scope of
work read without complaint into 199 tasks, no phases and no requirements — every row `mapped`. So a
project with more than 50 tasks and neither a phase nor a requirement is named at the top:

```
WARNINGS (1) — every file below may say mapped; the shape does not
  DI       d3cloud.io: 199 tasks, but 0 phases and 0 requirements — …
```

and its scope of work is `partial` rather than `mapped`. Do not `--write` a project with a warning.

## How a scope of work is read

- **Phases** are `## Phase N — Name` (or `Phase N: Name`; a `### Phase N` counts too). Each phase's
  `Objective` callout and `Size` are read onto the phase.
- **Subheadings** — `### Deliverables`, `### Tasks`, or a bold label on its own line
  (`**Deliverables**`) — divide a phase; they are not phases.
- **Deliverables become the phase's exit demo**, not tasks: they restate what the tasks produce, so
  importing both counts the work twice and leaves a task no commit will ever be attributed to. A
  phase with deliverables and *no* task list keeps them as its tasks, because then they are the only
  record of its work. `**Deliverables & Tasks**` is one list and stays tasks.
- **A bare bold checkbox with indented children** (`- [ ] **Repo setup**`) is a group, not a task.
  Its name prefixes each child's title — `Repo setup — Initial commit`.

## Requirements without a register

A project with no `Requirements Register.md` gets its requirements from the **MoSCoW scope** in its
`Discovery & Requirements.md`: a tier column (`| **Must** | … |`, `| 🟥 **Must** | … |`,
`| **Must Have** | … |`), a tier heading over a table or list (`### Must Have — …`), or a tier
callout over checkboxes (`> [!todo] Must Have`). IDs are assigned in the order written
(`DI-REQ-001`…), and `source` says `MoSCoW` plus the author's own label (`M10`, `F3`) where there is
one. Won't-haves import as priority `W`.

## Project codes are immutable

A code is embedded in every human ID in the project and cannot be changed afterwards (ADR-008). The
importer holds a map of the codes the ecosystem already uses — `BND`, `AUTH`, `CW` — because
deriving from folder names gave `BIND`, `DA` and `CLEA`, and importing under a derived code is a
cutover that cannot be corrected.

Any code the importer had to derive is flagged in the report:

```
  SNT      Some New Thing (4 files)   ← code DERIVED, not from the known map — check before writing
```

Add it to `KNOWN_CODES` in `src/import/run.ts` before writing, or live with it forever.

## Citations are rewritten

`REQ-021` in a Bindery document becomes `BND-REQ-021`. Every substitution is logged with its file
and line, because a false positive corrupts prose permanently and a missed one merely fails to
resolve. The rewriter will not touch an already-prefixed ID, anything inside a code span or fence, a
URL, a file path, or **a `[[wiki link]]`** — rewriting a link's target points it at a file that does
not exist.

Review with `--json` before the write that matters.

## Synthesized task IDs

Twelve scopes of work in the corpus have no task IDs at all. Those tasks get an ID synthesized from
their phase and position, and the row is **flagged** `id_synthesized` so it is never mistaken for
one somebody chose and cited. Completion state is preserved either way. A synthesized ID never
takes a number an authored ID in the same file already has.

```
Bindery   207 tasks, 0 synthesized      — every task carries an authored ID
Clearwhen  63 tasks, 63 synthesized     — free text; its 21 deliverables are phase exit demos
```

## Running it twice

Every write is an upsert on a natural key, so a second run updates rather than duplicating. That is
a property of how it writes, not a check bolted on: there is no "have I already imported this?"
question for it to get wrong.
