---
aliases: [Bindery Phase 0]
tags: [type/planning, project/bindery, status/active, tech/docker, tech/postgres, tech/python]
project: bindery
phase: 0
created: 2026-08-27
updated: 2026-08-27
status: complete
---

# Phase 0 — Foundation

> [!abstract] Objective
> Prove the stack runs end to end — a file can be uploaded and listed — with **nothing exposed to the internet** and **no way to accidentally delete anything**.

## Order of Operations

1. **Repo first.** Directory skeleton and `CLAUDE.md` before any code, so structure is a decision rather than an accident.
2. **Compose before application code.** Get `postgres` + `api` + `web` + `worker` + `cloudflared` talking. A stack that starts is worth more than an endpoint that can't run.
3. **Schema baseline before endpoints.** The tier columns, the library boundary, and the audit table exist in migration 0001 — retrofitting a classification scheme onto filed documents means re-touching every one.
4. **Auth before anything that touches a document.** No endpoint ships unauthenticated, not even temporarily.
5. **Tunnel and Access before the first real file.** The archive is never reachable from the open internet, not even during development.
6. **The trivial upload path last** — it's the proof, not the feature.

## File-by-File

| Path | Contents |
|---|---|
| `CLAUDE.md` | Project overview, dev commands, conventions, links to vault docs |
| `infra/docker-compose.yml` | Five services. **No `ports:` on any of them** except the tunnel's internal wiring |
| `infra/Dockerfile.api` | Python 3.13 slim, FastAPI, uvicorn |
| `infra/Dockerfile.worker` | Same base + Tesseract 5, Ghostscript, OCRmyPDF, poppler |
| `infra/Dockerfile.web` | Node build → nginx serve |
| `infra/cloudflared/config.yml` | Tunnel ingress rules for `/` and `/api/` |
| `api/db/models/` | `library.py`, `user.py`, `membership.py`, `source_file.py`, `page.py`, `document.py`, `tag.py`, `job.py`, `audit_event.py` |
| `alembic/versions/0001_baseline.py` | Extensions (`pg_trgm`, `vector`), all baseline tables, tier columns, indexes |
| `api/auth/` | JWT issue/verify, refresh rotation, Argon2 hashing |
| `api/routers/` | `auth.py`, `upload.py`, `documents.py` |
| `.github/workflows/build.yml` | Build and push `api`/`worker`/`web` to GHCR |

## Build Notes — decisions taken during implementation

> [!info] Deviations from the file-by-file plan, and why
>
> | Planned | Built | Why |
> |---|---|---|
> | `infra/cloudflared/config.yml` | No config file | The tunnel runs in **token mode**, so ingress rules live in the Cloudflare dashboard. One source of truth for routing, and the only secret in the repo is the token. Documented in `docs/access-setup.md` |
> | `worker/import/` | `worker/backlog/` | `import` is a Python keyword — `worker.import` is a `SyntaxError` and can never be imported |
> | — | `refresh_token` table | Refresh **rotation** needs server-side state. Not in the Data Model doc because it is an auth implementation detail, not archive data. Rotation revokes rather than deletes, which also gives reuse detection a chain to walk |
> | — | `source_file.library_id` | A file with no documents yet still needs an owner, which library-scoped blob serving (REQ-106) requires. `document.library_id` remains the authoritative access boundary (ADR-005) |
> | `document.embedding` | Deferred to Phase 3 | The vector dimension is not known until the embedding model is chosen (T-3.2). The `vector` extension **is** created in the baseline; only the column waits. Adding a nullable column later is cheap — unlike the tier columns, which are not |
> | `document.correspondent_id`, `document_type_id`, `known_form_id` | Deferred to Phases 3 and 5 | The tables they reference do not exist yet |
> | — | `Makefile` | The compose file lives in `infra/`, so every raw invocation needs `--env-file .env` to see the repo-root env. The Makefile carries that flag so nobody forgets it |
> | — | `HOST_DATA_ROOT` split from `DATA_ROOT` | One variable cannot be both the host bind source and the in-container path. On the ZimaOS box both are `/data`; splitting them is what lets the stack run anywhere else |

> [!warning] Two traps worth remembering
> - **`sa.Enum(SomeEnum)` persists member *names*, not values.** It writes `"PERSONAL"` into a type whose values are `personal`. Every enum column goes through `pg_enum()` in `api/db/base.py`, which sets `values_callable`.
> - **The async engine is module-level, so pytest needs a session-scoped event loop.** Without `asyncio_default_test_loop_scope = "session"`, every test after the first fails with *"attached to a different loop"* — the pool holds connections bound to a loop that has been closed.

## Verification Steps

1. `make up` → all services healthy (`cloudflared` is behind a profile, so `make tunnel` for five)
2. `make ps` → **no `host->container` port mapping on any service** (`REQ-104`) ✅
3. `make migrate` applied manually; restarting `api` leaves `alembic_version` and the table count unchanged (`REQ-114`) ✅
4. `grep -rn "DELETE FROM\|\.delete()" api/ worker/` → no matches; enforced on every run by `tests/test_no_destructive_paths.py` (`REQ-090`) ✅
5. Auth suite green: login, refresh rotation, replay detection, logout, expired and garbage tokens rejected (`REQ-103`) ✅ — 13 tests
6. Browser reaches the Cloudflare hostname and is challenged by Access ✅ *302 to `demersdev.cloudflareaccess.com` without credentials*
7. `curl -H "CF-Access-Client-Id: … " …/api/documents` succeeds **without** a browser flow (`REQ-105`) ✅ *Service Auth policy at precedence 1, above the Allow policy — R-15 closed*
8. Staging stack starts from the same compose file with a separate volume (`REQ-115`) ✅ — `docker-compose.staging.yml`, project `bindery-staging`, volume `pgdata-staging`, migration rehearsed

> [!success] Exit demo — passed in full 2026-08-28, on the real host
> Signed in through the browser, dropped a PDF, saw it listed with its content address. `make ps` shows no `host->container` mapping on any service. A bearer token fetched the same list with no browser flow. 23 tests green; `ruff` clean.
>
> **Still open:** the demo ran against the local stack rather than the Cloudflare hostname, because T-0.5 needs the dashboard. Note that `docker compose ps` shows bare `5432/tcp` and `80/tcp` for image-declared `EXPOSE` ports — those are container-internal. The check that matters is the absence of `->`.

## Risks in this phase

- **R-15 — Cloudflare Access blocks programmatic API access.** Certain to occur; resolved deliberately in T-0.5 via service tokens rather than discovered later.
- **R-10 — bad migration.** Mitigated from the start: staging stack, explicit migration application, never on boot.

## See Also
- [[Bindery/Scope of Work|Scope of Work]] · [[Bindery/Architecture|Architecture]] · [[Bindery/Data Model|Data Model]] · [[Bindery/Phase Plans/Phase 1 — Retrieval|Phase 1]]


## Deployment notes — ZimaOS, 2026-08-28

> [!warning] Three things the plan could not have predicted
> - **`HOME=/DATA` for shells, `HOME=/root` for services, and `/` is a read-only squashfs.** One quirk, two unrelated-looking failures: an SSH key that was correct in every visible way but written to the wrong home, and a "failed to pull after 5 mirror methods" error that was `docker login` writing credentials the daemon never reads. Every host command needs `DOCKER_CONFIG=/DATA/.docker`.
> - **`/DATA` is not the pool.** It is a 904 GB NVMe partition; the 16 TB array is md RAID 5 at `/media/Main-Storage`. The manifest originally pointed the archive at `/DATA`, which would have put every original on a single disk — precisely what **R-09** exists to prevent. Blobs now live on the array, Postgres on NVMe with a nightly dump landing on the array.
> - **The CasaOS custom-app importer cannot deploy this.** It has no way to set `DOCKER_CONFIG`, so it cannot authenticate to a private registry. Deployment is `docker compose` directly.

> [!info] Also worth knowing
> - Cloudflare's Browser Integrity Check rejects default HTTP client user agents with `403 error code: 1010`. API clients must send a real `User-Agent`.
> - The worker starts before migrations are applied — by design, since migrations are explicit — and logs `relation "library" does not exist` until they land. It backs off and recovers on its own. That resilience came from the Phase 2 fix and earned its keep on day one.
