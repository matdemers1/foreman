---
aliases: [Bindery Risks, Bindery Risk Register]
tags: [type/planning, project/bindery, status/active]
project: bindery
created: 2026-08-27
updated: 2026-08-29
---

# Bindery — Risk Register

> [!abstract] How to read this
> Each risk carries a **tripwire** — a named, observable condition that, if hit, forces a re-plan rather than a shrug. A risk without a tripwire is just anxiety.

> [!danger] The three that matter most
> **R-02 (miscalibrated auto-filing)** is the kill criterion made concrete. **R-01 (OCR quality on old military scans)** invalidates the classification design if it fails. **R-03 (backlog review flood)** is the most likely abandonment point.

> [!danger] R-08 has fired — 2026-08-29
> Tripwire: *"more than 15% of tags used exactly once after 1,000 classified documents."* Actual at **542** documents: **68.1%** — 476 tags of 699. Document types 166 of 277; correspondents 80 of 122. It fired early and hard.
>
> The cause was not model drift. `_full_taxonomy`, the candidate fallback, reads `.order_by(name).limit(25)`: with 277 types the model is shown the first 25 **alphabetically**, a list ending at *"Business Plan / Product Concept"*. `Utility Bill`, `Resume` and `Training Presentation` are never offered, so they cannot be reused, so the model invents — and each invention shrinks the alphabetical window further. A `LIMIT` truncates rather than errors, so nothing said a word.
>
> Prescribed response was "tighten the prompt and run a merge pass". The prompt was not the problem; **T-9.1** fixed the ranking and **T-9.2** extended the unify pass to types and tags.

> [!question] The tripwire measured the wrong thing — re-based 2026-08-29 (T-9.4)
> After the merge pass ran to convergence — 80 document types collapsed, including *fifteen* spellings of one squadron patch — the singleton rate had barely moved: 66.1% of tags, 59.9% of types, 64.8% of correspondents. The obvious conclusion would be that the merge pass failed.
>
> It did not. Counting instead how many entries still have a **trigram-similar sibling**, the honest measure of drift:
>
> | | used exactly once | has a similar sibling |
> |---|---:|---:|
> | Tags | 430 / 651 (66.1%) | 115 / 651 (**17.7%**) |
> | Document types | 118 / 197 (59.9%) | 17 / 197 (**8.6%**) |
> | Correspondents | 79 / 122 (64.8%) | 18 / 122 (**14.8%**) |
>
> Most singletons are not duplicates. They are one-off labels in a genuinely heterogeneous archive — college assignments, service records, 3D-printing photographs, condo statements, game assets — where `prusa-i3` applying to two documents is *correct*, not drift.
>
> "Used exactly once" was written in planning as a proxy for near-duplication, on the assumption of a thousand documents of household paperwork. It is a bad proxy for this archive and would have kept firing no matter how much merging was done. The tripwire is now the thing it was always trying to approximate. The singleton rate is still worth watching as context — a sudden jump means something changed — but it is not the alarm.

> [!warning] R-01 was never measured, and Phases 3–8.5 were built through its gate
> The tripwire — *word accuracy below 90% at the end of Phase 1* — required a figure that `tests/corpus/` never had the fixtures to produce. The scorer exists and the test skips loudly rather than passing on synthetic pages, which is the right failure; it just never got resolved. **T-9.5** closes it. The archive plainly works, so the risk did not materialise, but the number that was supposed to authorise proceeding still does not exist.

---

| ID | Risk | Impact | Likelihood | Mitigation | Tripwire |
|---|---|:---:|:---:|---|---|
| **R-01** | OCR quality on the existing military/VA/house scans is poor enough that text is unreliable | 🔴 High — invalidates classification design and degrades search | Medium | Phase 1 ships OCR + search with **no AI**, specifically so real quality is measured before anything is built on it. Preprocessing (deskew, despeckle, contrast) available; PaddleOCR documented as escalation | **Golden corpus word accuracy below 90% on the real bundles at the end of Phase 1** → re-plan the OCR stage before starting Phase 3 |
| **R-02** | Confidence gating is miscalibrated; documents auto-file incorrectly and trust erodes | 🔴 High — **this is the stated kill criterion** | Medium | Gate on **structural signals** (known-form match, all tags from `existing_ids`, pre-existing correspondent, explicitly-labeled date, rule fired) rather than the model's self-reported number. Why-panel + undo make errors cheap. Threshold calibrated against the golden corpus | **More than 1 in 20 auto-filed documents found wrong during any month** → tighten the gate and re-calibrate |
| **R-03** | Backlog import floods the review queue; triage becomes the new mess and the project is abandoned | 🔴 High | **High** | Backlog items are flagged and **never enter the daily review queue** — separate triage surface, lower auto-file bar (they were already unfindable; anything is an improvement). Two-pass import with human taxonomy curation between passes. Bulk edit with dry-run | **Backlog triage queue still above 500 items two weeks after import** → raise auto-file aggressiveness and lean on search |
| **R-04** | Cloudflare terminates TLS and can technically observe medical and identity documents in transit | 🟠 Medium | Low | **Accepted, documented risk** ([[Bindery/ADR-006 — Cloudflare Tunnel and Access for Ingress\|ADR-006]]). App-level JWT regardless. Reversal paths: tailnet-only, or client-side encryption for the sensitive tier | **Any change in sensitivity posture, or a decision to productize** → revisit ADR-006 |
| **R-05** | Brother MFC-L2820DW negotiates SMBv1 only; modern Samba refuses it | 🟡 Low | Medium | **Scan-to-FTP** into the same watched directory is a documented fallback. Named spike in Phase 1 | Spike fails → FTP adapter, no re-plan needed |
| **R-06** | LLM-confirmed segmentation cost balloons across a large bundle-heavy backlog | 🟠 Medium | Medium | Heuristics filter first so the model only sees ambiguous candidates. Batch API halves cost. **Cost measured on a 200-page sample before the full run** | **Measured cost per page on the sample implies more than $150 for the full backlog** → fall back to heuristics-only plus manual correction |
| **R-07** | Claude API pricing, terms, or model availability changes unfavourably | 🟠 Medium | Medium | `AIProvider` adapter; `prompt_version` per classification; nothing about retrieval depends on the API | **Cost per document doubles, or terms change regarding data use** → evaluate local/hybrid inference |
| **R-08** 🚨 | Taxonomy drifts despite the `existing_ids` design; hundreds of near-duplicate tags | 🟠 Medium | **FIRED 2026-08-29, cause fixed, tripwire re-based** | ID-constrained contract, candidates ranked by use rather than truncated alphabetically (T-9.1), unify pass over all three taxonomies (T-9.2), merge with retroactive apply and undo | **More than 15% of live entries share a trigram-similar sibling** → run a merge pass. *Superseded the original "used exactly once" tripwire — see below* |
| **R-09** | Single host, single disk pool. Hardware failure or fire destroys the archive | 🔴 High — irreplaceable data | Low | 3-2-1 with an offsite encrypted copy. **Restore drill is an acceptance-tested task, not a checkbox.** Integrity check job detects bit rot before backups replicate it. **Copies 1 and 2 shipped in Phase 6; copy 3 was a function signature — `encrypt_for_offsite()` wrote ciphertext to a local path and stopped. Phase 13 ([[Bindery/ADR-010 — Offsite Replication to S3\|ADR-010]]) builds the leg that leaves the building.** Not closed until the S3 restore drill passes | **Any restore drill that fails, or any integrity check finding a hash mismatch** → stop feature work until resolved. **Replication older than 48 hours** → treat as a fired risk, not a warning |
| **R-10** | Bad migration corrupts or destroys documents | 🔴 High | Low | Staging compose stack mirroring production; manual, deliberate deploys; Alembic applied explicitly, never on boot; backup verified immediately before any migration | **Any migration requiring a restore** → mandatory post-mortem and process change |
| **R-11** | Scope creep into general file storage dissolves the pipeline's coherence | 🟠 Medium | Medium | Boundary declared: **documents are first-class; other files are attachments or blobs that bypass the pipeline.** Crossing it requires a new ADR | **Any request to OCR/classify a non-document file type** → write the ADR or decline |
| **R-12** | Solo-maintainer abandonment mid-build | 🟠 Medium | Medium | **Phase 1 is independently valuable and solves the stated pain with no AI.** Full export works without Bindery at every phase. Each phase ends in a working, demoable system | **Two consecutive months with no commits** → reassess scope down to what's already shipped |
| **R-13** | Neighbour-based candidate taxonomy is useless on a cold archive | 🟡 Low | High (certain) | **Resolved by design** — two-pass backlog import with human curation between passes; full tag list used as the fallback while the archive is small | Resolved; monitor only |
| **R-14** | Overlapping or duplicate page ranges over one source file corrupt the document model | 🟠 Medium | Medium | Exclusion constraint on `(source_file_id, page range)`; all documents from one source file constrained to one library | Constraint violation in production → data-integrity investigation |
| **R-16** | The login page, newly internet-facing, is brute-forced or credential-stuffed | 🔴 High — one reused password reaches another family's medical records | Medium | [[Bindery/ADR-008 — App-Native Authentication as the Front Door\|ADR-008]] names seven controls that ship **before** the Access policies come off: rate limiting, bounded lockout, non-enumerable failures, password policy against a local list, audited attempts, CSP, verified cutover. TOTP available but **optional by operator decision** | **Any successful login from an IP with prior failures**, or lockouts on an account the owner did not trigger → make TOTP mandatory |
| **R-17** | An admin read path is added "just to help" and becomes the norm | 🟠 Medium — dissolves the one promise that makes this shareable | Medium | [[Bindery/ADR-009 — Strict Per-Account Isolation\|ADR-009]]: no admin branch in `visible_library_ids`, asserted by the permission suite on every read path. The support cost is accepted explicitly, and the sanctioned escape is a **user-initiated** time-boxed grant (T-12.5) | **Any PR adding an admin bypass to a read path** → refuse, or write the ADR that supersedes ADR-009 |
| **R-18** | A guest's bulk import fills the disk pool and stalls the archive for everyone | 🟠 Medium | Medium | Per-account quota set at invite time (REQ-141), enforced at upload with the limit and current usage named in the refusal; per-account storage in the admin panel (REQ-142) so it is visible before it is a problem | **Pool above 80%**, or any upload refused for quota → raise deliberately or prune |
| **R-19** | Documentation screenshots rot; the guides describe an application that no longer exists | 🟡 Low — but corrosive, because wrong docs are worse than none | **High** if manual | Screenshots are captured by driving the real app in CI and a stale one **fails the build** (REQ-149); a route without a doc page fails the build (REQ-150). This is the whole reason for the harness in T-11.2 | **Any screenshot regenerated by hand** → the harness is broken; fix it rather than working around it |
| **R-20** | Support becomes impossible under strict isolation and the operator quietly stops offering it | 🟠 Medium | Medium | Diagnosis is designed to work on metadata: job state, stage, error class, structural signals, storage. T-12.5's user-initiated grant exists for the cases that genuinely need eyes on a document | **Three support requests that could not be resolved from metadata** → build T-12.5 |
| **R-21** | An S3 lifecycle rule without a prefix filter silently expires the blob prefix — deleting the archive itself | 🔴 **Critical — silent, total, and Bindery cannot notice it** | Low | Every lifecycle rule carries a prefix filter; the only unfiltered rule permitted is `AbortIncompleteMultipartUpload`, which expires nothing that exists. A guard test (REQ-166) reads the deployed configuration and fails on any unfiltered expiry. Versioning is on, so a mistaken expiry leaves a noncurrent version until *its* rule fires | **Any lifecycle rule added outside the runbook**, or the guard test failing → treat the bucket as untrusted until re-verified |
| **R-22** | The ~349 document-ish files sitting un-ingested in the inbox have no offsite copy, and none in the local backup either | 🟠 Medium | **Present today** | Deliberate: `backup.sh` copies `blobs/`, and ADR-010 excludes the 13 GB inbox (6.5 GB of it Minecraft). Ingesting them is the fix, and the gap is the pressure to do it. Named rather than papered over | **Any file older than 90 days in the inbox and not ingested** → ingest it or move it out of the watched tree |
| **R-23** | The KMS key is disabled or scheduled for deletion, rendering every object in the bucket permanently unreadable | 🔴 High — unrecoverable by design, no support path | Low | The Bindery credential is explicitly denied `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:PutKeyPolicy` and `kms:CreateGrant`. Automatic rotation is on, so old backing keys are retained and old objects stay readable. Deletion waiting period set to **30 days**, the maximum. CloudWatch alarm on `ScheduleKeyDeletion`. Copies 1 and 2 are unaffected — this is precisely why there are three | **Any `ScheduleKeyDeletion` or `DisableKey` event on `alias/bindery-offsite`** → cancel immediately and audit who issued it |
| **R-24** | A vaulted document is lost: the passphrase is forgotten, or the encryption is wrong and the plaintext has already been deleted | 🔴 **Critical — irreversible by design, no support path** | Low | Verify-then-delete: the ciphertext must decrypt byte-identically to the original before anything is removed, asserted by deliberately corrupting it. Recovery codes generated at setup and shown once, reusing the Phase 10 pattern. The restore drill grows a vault case (T-16.12). The UI says "there is no recovery" at setup, in those words | **Any vault decryption failure, ever** → stop and treat as data loss until proven otherwise |
| **R-25** | The vault leaks while locked — through search snippets, hit counts, facets, the palette or the archive browser rather than through the document endpoint | 🔴 High — the whole feature is the promise it does not | Medium | The text leaves `page.text_tsv` entirely rather than being filtered out of it; scoping lives at the repository layer beside `visible_library_ids`; the leak suite is extended **before** the feature exists so it is written against a locked vault rather than around one | **Any vaulted content reachable while locked** → the feature is off until fixed |
| **R-15** | Cloudflare Access blocks programmatic API access (scoped tokens, future iOS app) | 🟡 Low | High (certain) | **Known, named task** — Access service tokens or an `/api/` bypass policy configured deliberately during Phase 0 | Resolved by design; verify in the Phase 0 exit demo |

---

## Unstated Assumptions Being Taken on Faith

> [!question] Named so they are visible as risk rather than silently assumed
> - That the existing bundles are **text-bearing scans**, not photographs of photocopies with severe degradation
> - That 200–500 documents/month is a stable estimate rather than an initial burst
> - That the household will actually use it, justifying the library and ACL work
> - That the ZimaOS Docker environment imposes no CPU or memory limits that would throttle OCR workers
> - That the people invited in Phase 10 will **trust the operator with the documents but not want the operator reading them** — the assumption ADR-009 is built on, and one worth checking out loud with the first person invited
> - That five to ten accounts is the ceiling; nothing here is designed for fifty
> - That page-level retrieval genuinely solves the DD-214 problem — i.e. that the words "DD-214" or "Certificate of Release or Discharge" actually appear as recognizable OCR text on the page

## The Riskiest Single Decision

> [!danger] Building fresh instead of layering on Paperless-ngx
> Surfaced twice with evidence, reaffirmed both times. If Bindery stalls before Phase 2, the counterfactual — Paperless-ngx plus paperless-ai running in an afternoon — would have been better. **The mitigation is entirely in the phasing:** Phase 1 delivers page-level bundle retrieval, which no existing product offers, and is valuable standing alone. It is also the least reversible decision in the plan.

## See Also
- [[Bindery/Test Strategy|Test Strategy]] · [[Bindery/Architecture|Architecture]] · [[Bindery/Scope of Work|Scope of Work]]
