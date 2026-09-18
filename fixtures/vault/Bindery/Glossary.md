---
aliases:
  - Bindery Glossary
  - Bindery Vocabulary
tags:
  - type/architecture
  - project/bindery
  - status/active
project: bindery
created: 2026-08-27
updated: 2026-09-02
---

# Bindery — Glossary

> [!abstract] Why this exists
> Shared vocabulary prevents the most expensive kind of bug: two people (or one person across two months) meaning different things by "document."

| Term | Definition |
|---|---|
| **Source File** | The immutable original bytes as ingested, addressed by SHA-256. Never modified, never moved, never renamed. |
| **Page** | One page of a source file. **The unit of search.** Has its own OCR text, its own `tsvector` row, its own render and word boxes. |
| **Document** | The logical unit a person thinks about — "my DD-214." Concretely: a **page range over a source file**. There is no separate segment entity; the range *is* the segment. |
| **Bundle** | A source file containing more than one logical document. A 100-page military service record producing thirty documents. |
| **Segmentation** | Determining where one document ends and the next begins inside a bundle. Heuristics propose, Claude confirms, a human can always correct. |
| **Correspondent** | Who sent it. A first-class entity with aliases and merge, so OCR variations of the same company resolve to one record. |
| **Asset** | A thing you own that documents are *about* — this car, this house, this policy, this account. Answers "what is it about" where Correspondent answers "who sent it." |
| **Known Form** | A document type with a deterministic fingerprint — DD-214, W-2, deed, title. **Matched, not guessed.** A registry hit is a fact. |
| **Library** | The access boundary. Every document belongs to exactly one. Personal libraries plus a shared household library. |
| **Vital Record** | The irreplaceable tier. Pinned access, forced redundancy, included in the one-click encrypted emergency export. |
| **Tag** | A free-form label. The classifier strongly prefers reusing existing tags over inventing new ones — enforced by schema, not by asking nicely. |
| **Candidate Taxonomy** | The ranked set of existing tags, types, and correspondents passed into a classification prompt, derived from the document's nearest embedding neighbours. |
| **Provenance** | The record of *what* set a field, *why*, and *from which page*. Every AI-written value carries it. |
| **Why-panel** | The UI surface that shows a field's provenance — the source snippet and page that justified it. |
| **Auto-file gate** | The pure function over **structural** signals — a known-form match, a rule firing, taxonomy resolved entirely from `existing_ids`, a date quoted from a labelled field — that decides whether a classification files itself or enters the review queue. `worker/classify/gate.py`, `decide(GateInputs) -> GateResult`, a threshold over weights. **It never reads the model's self-reported confidence** (invariant 5, R-02): LLM confidence is poorly calibrated, and gating on it is the kill criterion for this project. Confidence is stored and displayed only. Formerly listed here as "Confidence gate", which named the one input the gate is forbidden to have. |
| **Gate signal** | One structural fact the gate weighs: `known_form_match`, `rule_fired`, `all_tags_existing`, `correspondent_existing`, `document_type_existing`, `date_is_labelled`. All are stored, so `gate.replay()` can re-derive any past decision — which is what makes recalibrating after the fact possible, and why `decide()` may hold no clock, no randomness and no database read. |
| **Review Queue** | Keyboard-driven single-document triage: page preview on the left, editable AI suggestions on the right. |
| **Rule** | A deterministic override that runs alongside the classifier and always wins. The escape hatch when the model is stubbornly wrong. |
| **Prompt Version** | The identifier of the prompt that produced a classification. Makes targeted reprocessing a query instead of a full re-run. |
| **Smart Shelf** | A saved search that behaves like a persistent, self-updating collection. |
| **Packet** | A shelf with an export button. "Everything for my 2026 return." "My VA claim packet." |
| **Mirror Tree** | The regenerated hardlink directory tree under `/data/library/`. Human-browsable, disposable, rebuilt on demand. Never the source of truth. |
| **Go-Bag** | The one-click encrypted archive of all Vital Records, for a safe or a family member. |
| **Auditable Automation** | The governing design principle: automate by default; make every automated decision cheap to inspect and one click to reverse. |
| **`field_provenance`** | Provenance of **evidence**. Hangs off a classification and records the page and snippet behind an AI-written value — what the Why-panel shows. |
| **`field_source`** | Provenance of **authority**. Per field, per document: who last set this title, date or correspondent, and therefore whether AI review may overwrite it. Distinct from `field_provenance`, and the pair most easily confused: a document can carry excellent *evidence* for a value a person has since overruled. Rows are released (`released_at`), never deleted. Phase 17. |
| **Declined** | An input the pipeline correctly **refused** — a 10×5 pixel image is not a page; a dynamic XFA form is readable by nothing but Acrobat. Terminal like `dead_letter` and deliberately not a failure, so it must never light the failure badge ([[Bindery/ADR-011 — A Declined File Is Not a Failure\|ADR-011]]). "Failed" means Bindery could not do a thing it should have been able to do. |
| **Vault object** | The ciphertext of a vaulted document on disk: 1 MiB AES-GCM chunks, each bound by associated data to the document, its position and the file's shape ([[Bindery/ADR-013 — Chunked Vault Objects\|ADR-013]]). Named `secrets.token_hex(32)` and **not** content-addressed, because a content address is an existence oracle. Lives outside `blobs/`, which is why backup, offsite, export and the restore drill each needed their own path for it. |
| **Superseded** | How this archive retires a row instead of deleting it: `superseded_at IS NULL` is live, everything else is history. Segments, `document_tag.removed_at` and `field_source.released_at` all use the shape. It is what makes undo a flag flip, and it is invariant 3 in practice — nothing is ever automatically deleted. |

## See Also

- [[Bindery/Data Model|Data Model]]
- [[Bindery/Architecture|Architecture]]
