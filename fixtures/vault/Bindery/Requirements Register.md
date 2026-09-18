---
aliases: [Bindery Requirements, Bindery REQ]
tags: [type/requirements, project/bindery, status/active]
project: bindery
created: 2026-08-27
updated: 2026-08-31
---

# Bindery — Requirements Register

> [!abstract] The traceability spine
> Every requirement is atomic, testable, and sourced. **Every SOW task cites the REQ IDs it satisfies, and every Must requirement appears in at least one task.** A requirement with no task is a hole; a task with no requirement is scope creep.

**Priority:** `M` Must · `S` Should · `C` Could · `W` Won't (this release)
**Source:** R# = interview round · RT = red-team finding · RN = research finding · EC = ecosystem standard

---

## A — Ingest & Source Files

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-001 | Web drag-and-drop upload accepts multiple files with per-file progress | M | R2 | 10 files dropped; all 10 appear with progress and a terminal state | 1 |
| REQ-002 | A watched folder ingests files automatically, one subdirectory per library | M | R2 | File copied to `/inbox/personal/`; appears in the system without user action | 1 |
| REQ-003 | Watched-folder ingest waits for write stability before pickup | M | RT | A file written slowly is not ingested until its size is stable across two polls | 1 |
| REQ-004 | Original bytes are stored content-addressed by SHA-256 and never modified | M | R2 | Post-ingest hash of the stored blob equals the pre-ingest hash; file mtime never changes | 1 |
| REQ-005 | Byte-identical re-uploads are detected and not stored twice | M | R7 | Same file uploaded twice → one blob, one `source_file`, user informed | 1 |
| REQ-006 | Supported input types: PDF, JPEG, PNG, TIFF, HEIC | M | R6 | Each type ingests and normalizes to PDF successfully | 1 |
| REQ-007 | Browser camera capture uploads to the same ingest endpoint | S | R2 | Photo captured on a phone browser appears in the inbox | 8 |
| REQ-008 | Ingest provenance (source, adapter, original filename, timestamp) is recorded | M | EC | Every `source_file` has a non-null `ingest_source` and metadata | 1 |
| REQ-009 | Scan-to-SMB from the Brother MFC-L2820DW reaches the watched folder | M | R2 | Physical scan lands and ingests | 1 |
| REQ-010 | Scan-to-FTP fallback is available if SMB negotiation fails | S | RN | FTP-delivered file ingests identically | 1 |

## B — OCR & Normalization

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-011 | Every source file is normalized to a searchable PDF with a hidden text layer | M | RN | Output PDF contains selectable text positioned over the original image | 1 |
| REQ-012 | The original image resolution is preserved during normalization | M | RN | Rendered page dimensions and DPI match the source | 1 |
| REQ-013 | Deskew and clean are applied before OCR | S | RN | A skewed fixture produces measurably better word accuracy with the option on | 1 |
| REQ-014 | Raw OCR text is written as a sidecar artifact | M | RN | `derived/<hash>/ocr.txt` exists and is non-empty for a text-bearing scan | 1 |
| REQ-015 | Word bounding boxes are persisted for highlight overlay | M | R12 | `ocr.json` contains per-word coordinates for every page | 1 |
| REQ-016 | Full-resolution page renders and thumbnails are generated per page | M | R12 | One render and one thumbnail per page exist | 1 |
| REQ-017 | Documents that already contain a text layer skip redundant OCR | S | RN | A digital-native PDF is not re-rasterized | 1 |
| REQ-018 | OCR word accuracy on the golden corpus is measured and reported | M | RT | A scored report is produced; **Phase 1 gate is ≥ 90%** | 1 |

## C — Page-Level Indexing & Search

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-019 | Every page is a separately indexed row with its own text and tsvector | M | R5 | A 100-page file produces 100 `page` rows with populated `text_tsv` | 1 |
| REQ-020 | Search returns **page-anchored** results: file, page number, snippet, thumbnail | M | R5 | Searching a phrase on page 47 returns "page 47 of \<file\>" | 1 |
| REQ-021 | Opening a result opens the viewer **on that page** | M | R5 | Click a page-47 result → viewer renders page 47 | 1 |
| REQ-022 | Matched terms are visually highlighted on the page image | M | R12 | Highlight rectangles align with the matched words | 1 |
| REQ-023 | Trigram fuzzy matching covers title, tag, correspondent, and asset names | M | RN | Searching "Hoda" matches correspondent "Honda" | 1 |
| REQ-024 | Faceted filtering by library, date range, correspondent, asset, type, form, tag, review state | M | R12 | Each facet narrows results correctly and combines with others | 1 |
| REQ-025 | Search query p95 latency is under 300 ms at 100K pages | M | R6 | Measured against a seeded index | 1 |
| REQ-026 | The viewer opens on the hit page in under 2 seconds | M | R6 | Measured cold on the target hardware | 1 |
| REQ-027 | ⌘K command palette jumps to documents, tags, correspondents, and assets in under 100 ms | S | R12 | Keystroke to results measured | 1 |
| REQ-028 | Every search and filter state is URL-addressable | S | R13 | Copying the URL and reopening restores the exact view | 1 |
| REQ-029 | Search results are always scoped to the caller's visible libraries | M | R8 | Permission suite: user B never sees user A's document in any result | 7 |
| REQ-030 | Page numbers are displayed disambiguated ("page 3 of this document, page 49 of the file") | M | RT | Verified in the viewer for a bundle segment | 2 |

## D — Bundles, Segments & Known Forms

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-031 | A document is a page range over a source file; originals are never split on disk | M | R6 | Creating 30 documents from a bundle leaves the source blob byte-identical | 2 |
| REQ-032 | Page ranges over one source file may not overlap | M | RT | Exclusion constraint rejects an overlapping insert | 2 |
| REQ-033 | All documents from one source file belong to the same library | M | RT | Constraint rejects a cross-library assignment | 2 |
| REQ-034 | Heuristic proposers detect candidate boundaries (blank page, layout shift, page-number reset, form number) | M | R10 | Each heuristic fires on its corresponding fixture | 2 |
| REQ-035 | Claude confirms or rejects each candidate boundary over a sliding page window | M | R10 | Segment boundary F1 ≥ 0.85 on the corpus | 3 |
| REQ-036 | A manual segmentation editor allows drawing, adjusting, and naming boundaries | M | R6 | A user can split a 100-page bundle by hand and save | 2 |
| REQ-037 | Segmentation is fully reversible without touching the source file | M | R6 | Undo restores the previous segment set; blob hash unchanged | 2 |
| REQ-038 | A known-form registry matches documents deterministically by fingerprint | M | R6 | A DD-214 fixture matches with 100% precision | 2 |
| REQ-039 | The registry is seeded with DD-214, DD-215, VA award/rating letters, W-2, 1099, 1098, deed, title, mortgage note, birth certificate, passport, marriage licence | M | R6 | All seed entries present and each tested against a fixture | 2 |
| REQ-040 | Known-form matches are boosted in search ranking | M | R6 | Searching "DD-214" returns the known-form match first | 2 |
| REQ-041 | Known forms may declare typed field extractors (e.g. separation date, character of service) | S | R6 | DD-214 fixture yields typed fields | 3 |
| REQ-042 | A segment can be exported as a standalone PDF without modifying the source | M | R6 | Exported PDF contains exactly the segment's pages | 2 |
| REQ-043 | Bundles appear in the mirror tree under `_bundles/` with a generated index of contents and page ranges | S | RT | Index file lists every segment with its page range | 6 |

## E — Classification & the AI Layer

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-044 | All AI calls go through an `AIProvider` adapter | M | R3/EC | Swapping the provider requires no change outside the adapter | 3 |
| REQ-045 | Classification uses `claude-opus-5` with strict structured output | M | R3 | Malformed responses fail loudly and are retried, never silently accepted | 3 |
| REQ-046 | The response separates `existing_ids` from `new_names` for tags, type, and correspondent | M | RN | Reused IDs resolve deterministically and bypass all normalization | 3 |
| REQ-047 | Candidate taxonomy is derived from the document's top ~15 embedding neighbours | M | RN | Prompt contains neighbour-derived candidates, not the full taxonomy | 3 |
| REQ-048 | Candidate taxonomy is permission-filtered before the prompt, and returned IDs re-validated after | M | RN/RT | Permission suite: no cross-library taxonomy leakage via classification | 7 |
| REQ-049 | Every AI-written field records provenance: page, snippet, confidence | M | R7 | `field_provenance` row exists for every AI-set field | 3 |
| REQ-050 | Every classification records model and `prompt_version` | M | R9 | Query returns all documents on a given prompt version | 3 |
| REQ-051 | Titles follow `Correspondent - Type - Identifier`, ≤ 12 words, account numbers masked to last 4 | S | RN | Corpus titles conform | 3 |
| REQ-052 | Date extraction prefers explicitly-labeled dates over header/footer dates | M | RN | Multi-date fixture resolves to the labeled issuance date | 3 |
| REQ-053 | Prompt caching is used; cache hit rate is monitored | S | RN | `cache_read_input_tokens` non-zero across repeated requests | 3 |
| REQ-054 | ~~Bulk and backlog classification uses the Batch API~~ **Withdrawn 2026-08-30 (T-9.9)** — built in Phase 4, never once run, and deleted rather than left looking finished. Half price, but the saving is a few pounds per household and results take 24 hours, which is a worse import experience than the real-time one it would replace | M | RN | *(was: backlog run submits batches and reconciles results by `custom_id`)* | 4 |
| REQ-055 | If the AI provider is unavailable, documents are still OCR'd, paged, and searchable | M | R14 | With the API key removed, ingest completes and the document is findable | 3 |
| REQ-056 | Classification retries with exponential backoff and never silently drops a document | M | R14 | A simulated outage resolves without human action | 3 |
| REQ-057 | Auto-file gating uses **structural signals**, not the model's self-reported confidence | M | RT | Gate decision is reproducible from stored structural facts alone | 3 |
| REQ-058 | Auto-file precision on the golden corpus is ≥ 95% | M | RT | Scored report meets the threshold | 3 |
| REQ-059 | Documents below the gate enter the review queue rather than filing | M | R2 | Low-signal fixture lands in review | 3 |
| REQ-060 | A deterministic rules engine can override classification, recorded as rule-sourced | M | R13 | A GEICO rule applies its tags and the audit shows `actor_type = rule` | 3 |
| REQ-061 | Rules support a dry-run against existing documents before being enabled | M | RT | Preview lists affected documents before commit | 3 |
| REQ-062 | Documents are embedded for neighbour retrieval, find-similar, and Q&A | M | R4 | Every classified document has a non-null embedding | 3 |

## F — Trust, Provenance & Undo

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-063 | A why-panel shows the source snippet and page for every AI-written field | M | R7 | Clicking any AI field reveals its justification | 3 |
| REQ-064 | AI-written values are visually distinguishable from human- and rule-set values | M | R7 | Verified in the viewer and review queue | 3 |
| REQ-065 | Per-field confidence is displayed in the UI, not only used at the gate | M | R7 | Confidence visible on every AI field | 3 |
| REQ-066 | Every mutation writes an append-only audit event with actor type and before/after state | M | R7/EC | Audit row exists for every write path | 3 |
| REQ-067 | Every automated action is undoable, including un-filing and un-segmenting | M | R7 | Undo restores prior state exactly; verified by audit diff | 3 |
| REQ-068 | Bulk operations are recorded as a single operation with an affected-row manifest, undoable as a unit | M | RT | A 400-document tag merge is undone in one action | 5 |
| REQ-069 | An audit log viewer allows filtering by document, actor type, and time | S | R7 | Filters return correct subsets | 6 |
| REQ-070 | Nothing fails silently — every failed document is visible in a surface a human will see | M | RT | A forced failure appears in the pipeline status screen | 1 |

## G — Organization & Entities

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-071 | Correspondent is a first-class entity with aliases | M | R4 | Three alias spellings resolve to one correspondent | 5 |
| REQ-072 | Correspondents can be merged, with a preview and full reversibility | M | R4 | Merge preview shown; undo restores both records and their links | 5 |
| REQ-073 | Asset is a first-class entity with typed attributes and a kind | M | R10 | A vehicle asset stores VIN and plate | 5 |
| REQ-074 | Documents relate to assets many-to-many | M | R10 | One document attaches to two assets | 5 |
| REQ-075 | An asset timeline shows every attached document chronologically | S | R13 | Vehicle timeline renders purchase, service, insurance, payoff in order | 5 |
| REQ-076 | Tags can be renamed and merged with retroactive application | M | R12 | Merging two tags updates all affected documents, audited and undoable | 5 |
| REQ-077 | A taxonomy health view surfaces near-duplicate tags, orphans, and usage counts | S | R12 | View flags a deliberately-seeded near-duplicate pair | 5 |
| REQ-078 | Tag provenance (ai / rule / human) is recorded on the document-tag link | M | R7 | Link rows carry a source value | 3 |
| REQ-079 | Saved searches persist as smart shelves | S | R12 | A saved query reappears and stays current as documents are added | 5 |
| REQ-080 | A shelf can be exported as a packet (organized archive of its documents) | M | R8 | Tax-year shelf exports a complete, organized bundle | 5 |
| REQ-081 | Near-duplicate detection surfaces likely rescans for review with a comparison view | S | R7 | Two scans of one document are flagged as candidates | 5 |

## H — Backlog Import

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-082 | Bulk import walks a directory tree and produces a dry-run preview before processing | M | R9 | Preview lists file count, types, duplicates, and estimated cost | 4 |
| REQ-083 | Backlog items are flagged and never enter the daily review queue | M | RT | Backlog items appear only in the backlog triage surface | 4 |
| REQ-084 | Backlog import runs in two passes with human taxonomy curation between them | M | RT | Pass one classifies a sample; curation UI is presented; pass two uses the curated taxonomy | 4 |
| REQ-085 | Backlog items use a lower auto-file bar than live intake | S | RT | Configurable, and the difference is visible in settings | 4 |
| REQ-086 | Import survives interruption and resumes without duplicating work | M | R14 | Killed mid-import and restarted; no duplicate documents | 4 |
| REQ-087 | Bulk edit supports selection, a dry-run preview of changes, apply, and a single undo | M | RT | 200 documents retagged and reverted in one action | 4 |
| REQ-088 | Segmentation cost is measured on a sample before the full backlog run | M | RT | Sample report produced with projected total cost | 4 |

## I — Storage, Tiers & Resilience

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-089 | Sensitivity and redundancy tiers exist as columns from the first migration | M | R8 | Present in the initial schema | 0 |
| REQ-090 | **Nothing is ever automatically deleted** | M | R13 | No code path performs an unattended destructive delete | 0 |
| REQ-091 | A Vital Records tier pins documents to the home screen | M | R6 | Vital documents appear without searching | 6 |
| REQ-092 | One-click encrypted export of all Vital Records (go-bag) | M | R12 | Encrypted archive produced and verified decryptable | 6 |
| REQ-093 | Full export produces originals in a folder tree, metadata as JSON, and a static HTML index usable without Bindery | M | R12 | Export opened in a browser with the stack stopped; documents navigable | 6 |
| REQ-094 | A regenerated hardlink mirror tree exists for whole files; deleting it is non-destructive | S | R2 | Tree deleted and rebuilt; no data lost | 6 |
| REQ-095 | An integrity check job rehashes every blob and reports mismatches | M | R12 | Deliberately corrupted blob is detected | 6 |
| REQ-096 | Backups follow 3-2-1 with an offsite encrypted copy | M | R11 | Backup targets configured and verified | 6 |
| REQ-097 | A restore drill restores to a clean stack and **the DD-214 is findable** | M | R11 | Executed and documented as a phase exit criterion | 6 |
| REQ-098 | A printed emergency index with QR codes to vital-record pages can be generated | C | R12 | PDF produced; QR resolves to the correct page | 9 |

### I.2 — Offsite Replication *(added 2026-08-30, [[Bindery/ADR-010 — Offsite Replication to S3|ADR-010]])*

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-158 | A single-purpose S3 bucket exists with versioning, Block Public Access, SSE-KMS under a customer-managed key, and S3 Bucket Keys enabled | M | R15 | `aws s3 rm` on a test object is **denied** for the Bindery credential | 13 |
| REQ-159 | AWS credentials, bucket, region and KMS key id are configured **in the application**, credentials encrypted at rest and masked on read | M | R15 | Keys survive a restart; the UI never renders more than the last four characters | 13 |
| REQ-160 | A connection test performs a real put/get round-trip and reports the KMS key the object was encrypted under | M | RT | A wrong key id or a missing `kms:GenerateDataKey` fails the test rather than passing it | 13 |
| REQ-161 | Blob replication is incremental and never re-uploads an object already present | M | RT | Second run ships zero objects and the bucket gains no new versions | 13 |
| REQ-162 | The database dump and a manifest replicate on the same integrity gate as the local backup | M | R11 | A failing integrity check refuses to replicate | 13 |
| REQ-163 | Replication runs daily and weekly on separate prefixes, with expiry performed by S3 lifecycle rules and never by Bindery | M | R15 | Eighth daily run leaves seven daily dumps; Bindery holds no delete permission | 13 |
| REQ-164 | The Trust screen shows the age of the last **successful** replication, per-run history, and the failure reason | M | R14 | A failed run is legible from the screen without reading host logs | 13 |
| REQ-165 | Replication older than 48 hours raises the same health alert as a stalled pipeline | M | RT | Worker stopped for 48h → alert fires; the screen does not stay green | 13 |
| REQ-166 | No lifecycle rule expires objects without a prefix filter, and none matches the blob prefix | M | RT | A bucket-wide expiry rule in a fixture **fails** the guard test | 13 |


### I.3 — Signal & Navigation *(added 2026-08-31, [[Bindery/ADR-011 — A Declined File Is Not a Failure|ADR-011]])*

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-167 | An input the pipeline correctly refuses is recorded as `declined`, a terminal state distinct from failure | M | RT | A 10×5px image lands in `declined`, not `dead_letter` | 14 |
| REQ-168 | Declined work is excluded from the health panel and from any badge, and is still listed on the Pipeline screen | M | RT | An archive whose only anomaly is declined work reports healthy | 14 |
| REQ-169 | A dead-lettered job can be acknowledged without being deleted, retried or hidden | M | R13 | Acknowledging changes only whether it is counted; the row and its error survive | 14 |
| REQ-170 | A sidebar badge counts only work a person can still act on | M | RT | With every dead letter acknowledged and no pending review, no badge is shown | 14 |
| REQ-171 | The sidebar shows at most the destinations used regularly; setup and account screens are reachable without occupying it | S | R14 | Eleven items visible; Libraries, People, Account, Settings and Guides reachable in one click from the footer | 14 |
| REQ-172 | Every route remains reachable from the shell after the reorganisation | M | RT | A test walks the route table and finds a link for each non-parameterised route | 14 |

### K.2 — The Build Gate *(added 2026-09-01)*

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-173 | No image is published unless lint, unit, integration and end-to-end tests have all passed, in that order | M | RT | A failing unit tier leaves integration, e2e and publish **skipped** | 15 |
| REQ-174 | The web app is linted and typechecked as its own gate, before any image is built | M | RT | A type error fails the lint job, not the Docker build | 15 |
| REQ-175 | End-to-end tests drive the real stack — built images, explicit migrations, seeded corpus, a browser | M | RT | The suite signs in through the login page and reads the rendered DOM | 15 |
| REQ-176 | No end-to-end test may skip silently; the fixture provides every state they assert on | M | RT | A missing fixture fails with "seed-e2e-states.py did not run", never a skip | 15 |

### I.4 — The Private Vault *(added 2026-09-01, [[Bindery/ADR-012 — The Private Vault|ADR-012]])*

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-177 | One data key, wrapped separately by a passphrase and by a PIN; per-file keys derived from it | M | R16 | Encrypt-then-decrypt returns the exact input bytes for arbitrary content | 16 |
| REQ-178 | The PIN-wrapped key is useless without a host pepper that is excluded from backup, export and offsite replication | M | RT | A database dump plus the S3 copy contains no PIN-derivable key material | 16 |
| REQ-179 | The data key exists only in api process memory while unlocked, and is dropped on timeout, sign-out and restart | M | RT | After the idle timeout the vault is locked and the key is gone | 16 |
| REQ-180 | Without an unlocked session, vaulted rows do not exist for any query, enforced at the repository layer | M | R16 | The leak sweep finds nothing vaulted through any read path | 16 |
| REQ-181 | Moving into the vault encrypts, **verifies the ciphertext decrypts byte-identically**, and only then deletes the plaintext, renders and pages | M | R13 | Deliberately corrupted ciphertext aborts the move with the original intact | 16 |
| REQ-182 | Moving out of the vault restores the original bytes and returns the document to the archive | M | R16 | The restored blob's hash equals the one recorded before vaulting | 16 |
| REQ-183 | Page text, titles and dates are encrypted at rest for vaulted items; taxonomy links are revoked, not carried | M | RT | No plaintext of a vaulted document survives in any table | 16 |
| REQ-184 | An unlocked vault is searchable at page level; the cost is measured and has a documented ceiling | M | R16 | A phrase inside a vaulted page is found unlocked and not found locked | 16 |
| REQ-185 | Documents and photos can be moved to the vault from their own screens, and search offers the vault behind the PIN | M | R16 | The action is reachable without a shell, and warns before it destroys plaintext | 16 |
| REQ-186 | Export and offsite carry vaulted ciphertext and an explicit manifest of what they cannot read | M | R12 | `make export` names the vaulted documents rather than omitting them silently | 16 |
| REQ-187 | A locked vault leaks nothing through snippets, hit counts, facets, the palette or the archive browser | M | RT | Each of those surfaces is exercised against a locked vault in the leak suite | 16 |
| REQ-188 | A person can correct a document's title, summary, date, correspondent and type, and the correction is audited and undoable | M | R7 | A wrong title is fixed from the viewer and from the review queue; undo restores it | 17 |
| REQ-189 | Tags can be added and removed on a single document, recorded as human-set and revoked rather than deleted | M | R7 | A tag added and removed by hand leaves two links, one live, one revoked | 17 |
| REQ-190 | A correspondent or document type can be created inline while editing, resolved by id and never by name | M | R2 | Creating "Fenwick Garage" from the edit form yields one new row, linked by id | 17 |
| REQ-191 | Classification never overwrites a field a human set, and reports which fields it skipped | M | R2 | A hand-set title survives a re-classification that changes the untouched fields | 17 |
| REQ-192 | Vault objects are encrypted in independently decryptable chunks so a byte range is served without decrypting the whole file; existing objects are re-sealed | M | R24 | A vaulted video seeks in the browser; a swapped or truncated chunk is refused | 18 |
| REQ-193 | Image metadata (capture date, camera, dimensions, location) is read from the file and recorded; a capture date fills the document date as source `file` | S | R12 | A photo with EXIF shows its capture date, attributed to the file, and a person's edit wins over it | 18 |
| REQ-194 | Video files are imported, probed for metadata and a poster frame, stored as one document, and never enter OCR or classification | S | R12 | An .mp4 imports, shows its duration, appears under Videos, and has no classification job | 18 |
| REQ-195 | Photos and videos are shown separately, in and out of the vault; unvaulted video streams with ranges | S | R12 | Photos · Videos tabs on the wall; Documents · Photos · Videos in the vault | 18 |
| REQ-196 | The import screen imports the inbox in one click and shows, for every run, what was imported, duplicated, skipped and failed, with reasons | M | R7 | A past run's failures are listed with their errors | 18 |
| REQ-197 | An import can be sent to the vault: each file is sealed as its pipeline finishes while the vault is open, and waits visibly when it is locked | M | R24 | Lock mid-import; the remainder shows as waiting; unlock and it completes | 18 |
| REQ-198 | Code entry is one box per character with paste, keyboard and tap navigation, and motion that respects reduced motion | S | R14 | A pasted six-digit code fills and submits; reduced motion shows a tint instead of a shake | 19 |
| REQ-199 | Password fields offer a reveal toggle, and new-password fields show strength in words as well as bars | S | R14 | Toggle changes the input type and its accessible name | 19 |
| REQ-200 | A fresh install is claimed in the browser with a setup code only the host's operator can read | M | RT | Wrong code 400; the printed code claims once; a second claim 409 | 19 |
| REQ-201 | The claiming account becomes administrator only after enrolling TOTP, and an abandoned setup resumes there | M | R14 | Sign out after claim; sign in lands on Secure; confirm; account is admin | 19 |
| REQ-202 | Every unauthenticated screen uses the entry shell and the design system's form components | S | — | No hand-rolled input in the entry screens; usage gate clean | 19 |
| REQ-203 | SSO is configured by the operator, off until configured, and the client secret is never readable back | M | R14 | `GET /api/settings` masks the secret as the AI key already is | 20 |
| REQ-204 | A D3 Auth sign-in produces an ordinary Bindery session, with the OIDC transaction bound to the browser that began it | M | RT | A callback carrying another browser's `state` is refused | 20 |
| REQ-205 | First sign-in carrying a role provisions the account, its library and its quota; an identity with no role provisions nothing | M | R14 | A grant-less identity is refused and no row is written | 20 |
| REQ-206 | Linking a D3 Auth identity is explicit; unlinking requires the local password; both are audited | M | R14 | Unlink with a wrong password is refused and audited | 20 |
| REQ-207 | A role change at the provider takes effect on the next request after renewal, with no re-login | S | R14 | Revoke `admin`, renew, and the admin screens are gone | 20 |
| REQ-208 | Back-channel logout ends the named session, is idempotent by `jti`, and survives a signing-key rotation | M | RT | The same `jti` twice is one logout and two 200s | 20 |
| REQ-209 | Every SSO affordance is absent when SSO is off and explains itself when the provider is unreachable | S | — | `off` renders no button and no mention of a provider | 20 |
| REQ-210 | Signing in with a recovery code retires the authenticator it replaced: the TOTP enrolment is cleared, the remaining codes are superseded, administrator rights are revoked until a factor is enrolled again, and the next sign-in resumes at Secure when no other administrator remains | S | R14 | A recovery sign-in leaves `totp_enabled` false, `is_admin` false and the second sign-in asking for no code | 19 |

## J — Access, Auth & Libraries

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-099 | Library is the access boundary; every document belongs to exactly one | M | R8 | Schema constraint enforced | 0 |
| REQ-100 | Users hold memberships with role owner / contributor / reader | M | R8 | Each role's permissions verified | 7 |
| REQ-101 | Every document query filters on the caller's visible library set at the repository layer | M | R8 | Permission suite passes; no call site implements its own check | 7 |
| REQ-102 | Moving a document between libraries is explicit and audited | M | R8 | Audit event recorded with before/after library | 7 |
| REQ-103 | JWT auth with HTTP-only cookie, refresh rotation, and Argon2 hashing | M | EC | Auth suite passes | 0 |
| REQ-104 | No host ports are published; ingress is via Cloudflare Tunnel | M | R11 | `docker compose ps` shows no published ports | 0 |
| REQ-105 | ~~Cloudflare Access is configured, with a service-token path for programmatic API access~~ **Withdrawn 2026-08-30** by [[Bindery/ADR-008 — App-Native Authentication as the Front Door\|ADR-008]]; its intent is carried by REQ-107 | M | RT | *(was: an API token authenticates without a browser flow)* | 0 |
| REQ-106 | Blob serving is authenticated and library-scoped; no unauthenticated static routes | M | R11 | Direct blob URL without a session returns 403 | 1 |
| REQ-107 | A REST API with scoped tokens is exposed deliberately and documented | S | R13 | Token-scoped request succeeds; out-of-scope request is refused | 8 |

## K — Operations & Observability

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-108 | The job table is the observability surface; stuck and failed jobs are queryable | M | R9 | Health panel reads directly from it | 1 |
| REQ-109 | An in-app health panel shows queue depth, failures, stuck jobs, and API spend | M | R10 | Panel reflects a seeded failure state | 8 |
| REQ-110 | A push notification fires on permanent failure or a stalled pipeline | M | R10 | Simulated stall produces a notification | 8 |
| REQ-111 | All jobs are idempotent; replaying a job produces an identical end state | M | R9 | Idempotency suite passes | 1 |
| REQ-112 | Every pipeline stage is independently replayable against its stored artifact | M | R10 | Re-classify without re-OCR verified on a fixture | 3 |
| REQ-113 | Targeted reprocessing by prompt version is supported | M | R10 | "Reprocess everything on v2" affects only those documents | 3 |
| REQ-114 | Migrations are applied explicitly, never automatically on container boot | M | R11 | Container start does not mutate the schema | 0 |
| REQ-115 | A staging compose stack mirrors production for migration rehearsal | S | R11 | Stack starts and runs the corpus end to end | 0 |

## L — Q&A, Delight & Later

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-116 | Natural-language Q&A answers questions over the archive with **every answer cited to a page** | S | R12 | An uncited answer is treated as a failure | 8 |
| REQ-117 | Find-similar returns related documents using embeddings | C | R12 | Returns the known-related fixture | 5 |
| REQ-118 | Search can be scoped to a single bundle | C | R12 | Scoped query returns only that file's pages | 2 |
| REQ-119 | First-run ingests one document and narrates the pipeline end to end | C | R13 | Completes in under a minute on the target hardware | 8 |
| REQ-120 | Expiry tracking with reminders for passports, registrations, policies, and warranties | S | R12 | Reminder fires ahead of a seeded expiry date | 9 |
| REQ-121 | ~~Cloud replication of the redundancy tier to S3 or Azure, client-side encrypted~~ **Superseded by REQ-158 – REQ-166.** Server-side encryption (SSE-KMS) replaces client-side by explicit operator decision | C | R8 | See [[Bindery/ADR-010 — Offsite Replication to S3\|ADR-010]] | ~~9~~ 13 |
| REQ-122 | Learn-from-corrections injects prior corrections as few-shot examples | C | R12 | Measurable improvement on the corpus after seeded corrections | 9 |
| REQ-123 | Native iOS app with share-sheet ingest and offline capture queue | C | R8 | Ships as its own project phase | 9 |

## Won't (this release)

| ID | Req | Pri | Src |
|---|---|:-:|:-:|
| REQ-124 | Document annotation, markup, redaction, or page rearranging | W | R7 |
| REQ-125 | Comments, approvals, or collaborative review workflows | W | R7 |
| REQ-126 | Automatic retention-based deletion | W | R13 |
| REQ-127 | Missing-document detection for recurring series | W | R12 |
| REQ-128 | Weekly digest notifications | W | R12 |
| REQ-129 | Telemetry or analytics of any kind | W | R12 |
| REQ-130 | Semantic search as the primary retrieval path | W | R4 |
| REQ-131 | General file storage as a peer of documents *(boundary held; crossing requires a new ADR)* | W | R8/RT |


## M — Accounts, Onboarding & Administration

> Added 2026-08-29. Sources: R14 = the multi-user interview. See [[Bindery/ADR-008 — App-Native Authentication as the Front Door|ADR-008]] and [[Bindery/ADR-009 — Strict Per-Account Isolation|ADR-009]].

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-132 | Bindery's own login page is the front door; no external identity challenge precedes it | M | R14 | An unauthenticated request to any app route lands on Bindery's login, not a Cloudflare screen | 10 |
| REQ-133 | Login is rate-limited per IP and per account, with escalating cost | M | RT | 10 rapid failures are throttled; the suite asserts the delay grows | 10 |
| REQ-134 | Repeated failures lock an account for a bounded window, visible and clearable by an admin | M | RT | Lockout engages, expires on its own, and an admin can clear it early | 10 |
| REQ-135 | Authentication failures are indistinguishable between "no such user" and "wrong password" | M | RT | Response body and timing are equivalent for both cases | 10 |
| REQ-136 | An admin can issue a one-time, expiring password-reset code; an admin can never set a password directly | M | R14 | Code works once, expires, and no endpoint accepts an admin-supplied password for another user | 10 |
| REQ-137 | A user can change their own password, which invalidates every other session they hold | M | R14 | Second session is rejected after the change | 10 |
| REQ-138 | TOTP two-factor is available to any user, self-enrolled with recovery codes | S | R14 | Enrolment, challenge and recovery-code paths each verified | 10 |
| REQ-156 | TOTP is mandatory for any account holding administrator rights; the grant is refused without it | M | R14 | Granting admin to an account with no TOTP is refused at the API, not only in the UI | 10 |
| REQ-157 | The admin panel shows, per account, whether TOTP is enrolled | M | R14 | The column reflects a freshly enrolled and a freshly disabled account | 10 |
| REQ-139 | Accounts are created only by invitation; there is no public sign-up | M | R14 | The registration endpoint refuses without a valid invitation token | 10 |
| REQ-140 | An invitation is a single-use, expiring link that provisions exactly one account and one personal library | M | R14 | Second use of the same link is refused; the created account owns one library | 10 |
| REQ-141 | Each account carries a storage quota, set at invite time and adjustable by an admin | M | R14 | Upload past the quota is refused with a message naming the limit and current usage | 10 |
| REQ-142 | The admin panel shows per-account storage, file counts and last activity | M | R14 | Figures match a direct database count | 10 |
| REQ-143 | An administrator cannot read any document, page, text or title outside their own libraries | M | R14/RT | The permission suite asserts every read path refuses an admin from another library | 10 |
| REQ-144 | The event log is library-scoped; global entries carry no document content | M | RT | An admin reading the log sees stage and error data only for other libraries | 10 |
| REQ-145 | Suspending an account preserves its data and blocks its sessions immediately | M | R14 | Active session is rejected on the next request; documents remain intact | 10 |
| REQ-146 | A first-run welcome flow explains ingest, search and review, and can be re-opened later | M | R14 | A new account sees it once; it is reachable afterwards from help | 10 |
| REQ-147 | Onboarding ends with the user's first document ingested and found by search | S | R14 | The flow is not marked complete until a search returns a hit | 10 |

## N — In-App Documentation & Versioning

| ID | Req | Pri | Src | Acceptance | Phase |
|---|---|:-:|:-:|---|:-:|
| REQ-148 | Guided documentation is served from the app itself, at stable routes, with no external dependency | M | R14 | Docs render with the network blocked to everything but the origin | 11 |
| REQ-149 | Documentation screenshots are captured automatically from the running application | M | R14 | A CI job regenerates every screenshot and fails on a stale one | 11 |
| REQ-150 | A documentation page exists for every user-facing screen, and CI fails when a route has none | M | R14 | Adding a route without a doc page fails the build | 11 |
| REQ-151 | An FAQ covers ingest, search, review, sharing, storage and account recovery | S | R14 | Each topic has at least one entry linking to its guide | 11 |
| REQ-152 | Every service reports a version derived from the build, not hand-maintained | M | R14 | `/api/version` returns the commit the image was built from | 11 |
| REQ-153 | The UI surfaces the running version of api, worker and web, and flags a mismatch between them | M | R14 | A deliberately mismatched stack shows a warning | 11 |
| REQ-154 | The schema revision and its drift from the code's head revision are visible in the health panel | M | RT | An unapplied migration is reported before it causes an error | 11 |
| REQ-155 | A user-facing changelog records what changed in each version | C | R14 | Release notes render at a stable route | 11 |

---

## Coverage Summary

| Priority | Count |
|---|---:|
| **Must** | 101 |
| **Should** | 31 |
| **Could** | 15 |
| **Won't** | 8 |
| **Total** | **157** | *(REQ-054 and REQ-105 withdrawn; kept in place with their reasons rather than deleted)*

> [!note] REQ-105 is superseded, not met
> "Cloudflare Access is configured, with a service-token path" was satisfied and is now deliberately withdrawn by [[Bindery/ADR-008 — App-Native Authentication as the Front Door|ADR-008]]. Its intent — programmatic API access without a browser flow — is carried by REQ-107, which Bindery's own scoped tokens already satisfy. It is left in the register with this note rather than deleted, because a requirement that vanishes is a requirement nobody can audit.

## See Also
- [[Bindery/Scope of Work|Scope of Work]] · [[Bindery/Test Strategy|Test Strategy]] · [[Bindery/Risk Register|Risk Register]] · [[Bindery/Architecture|Architecture]]
