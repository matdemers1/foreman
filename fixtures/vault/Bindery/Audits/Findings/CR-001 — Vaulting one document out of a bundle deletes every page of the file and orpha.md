---
tags: [type/audit, audit/code-review, project/bindery, severity/critical, status/resolved]
finding_id: CR-001
lens: correctness, data
severity: Critical
confidence: High
verified: CONFIRMED
status: fixed
found_round: 1
fixed_round: 1
fixed_commit: "c0175a6"
effort: M
location: "api/vault/store.py:196-206,299-310"
related_adr: ADR-001
created: 2026-09-02
updated: 2026-09-03
---

# CR-001 — Vaulting one document out of a bundle deletes every page of the file and orphans its siblings

> [!danger] Critical · confidence High · CONFIRMED · **fixed**
> Found by the **correctness, data** lenses in round 1. Fixed in `c0175a6`.

**Location** — `api/vault/store.py:196-206,299-310`

## What was observed

`seal` selects `Page` rows with `sa.select(Page).where(Page.source_file_id == source.id)` — the whole file, not `document.page_start..page_end` — then `for page in pages: await session.delete(page)` and finally unlinks the original. `api/routers/vault.py:226 move_in` resolves the document and its source file and calls `seal` with no check that the file holds only this one live document. `api/segments.replace` routinely creates several live documents per source file (ADR-001).

## Why it matters

A 100-page scanned bundle is segmented into three documents: pages 1-40 (DD-214), 41-70, 71-100. The user vaults only the DD-214. `seal` deletes all 100 `Page` rows, purges every page render, and unlinks the original blob. The other two documents keep `vaulted_by IS NULL`, so they still appear in the archive and in `list_documents` — but they have no pages (unsearchable), no renders, and no original. Worse, `boundary.hidden_source_file_ids` now hides the whole source file, so `repository.get_source_file` returns None for them: the viewer 404s. Two documents the user never touched are silently destroyed, and the vault holds a 100-page object whose `sealed_meta` claims page_start/page_end of only the first. Unsealing restores the blob and the pages, so it is partially recoverable — but only if the owner still has the passphrase and thinks to look.

## Recommendation

In `move_in`, refuse with 409 when `len(await segments.list_segments(session, source.id)) > 1` — the same shape as `_refuse_if_busy`, with a message pointing at re-segmentation as the way to vault one part of a bundle. Until per-range vaulting exists, that is the honest boundary. Independently, scope the page select in `seal` to `document.page_start <= Page.page_number <= document.page_end` so the code cannot outrun the guard.

## Verification notes

Verified by the chair directly against `api/vault/store.py`: the page query is `Page.source_file_id == source.id`, `page_start`/`page_end` reach only `sealed_meta`, and neither `move_in` nor the sweep checks for siblings. Then verified against the live archive: **78 documents currently sit on multi-document files**, so this was reachable by an ordinary action today. No damage had occurred — no file had a vaulted document beside a live sibling, and no document had lost its pages.

## Resolution

Fixed in `c0175a6`. `store.seal` now refuses when any other live `document` sits on the same `source_file` — `_refuse_if_shared_file` in `api/vault/store.py`. Sealing only the page range was rejected as a fix: it would mean writing a new PDF of those pages, and an original is never modified or split (invariant 1). Splitting a bundle first and then vaulting a whole file is a product decision, and is listed under Decisions for the Owner. Covered by `tests/test_vault_move.py::test_it_refuses_a_document_that_shares_its_file` and `::test_a_superseded_sibling_does_not_block_it`; both fail against the pre-fix code.

- Also reported by the **data** lens as `DATA-01`

## See Also
- [[00 — Summary]]
- [[Bindery/CLAUDE|Bindery conventions and invariants]]
- [[Bindery/ADR-001 — |ADR-001]]
