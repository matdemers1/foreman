# The GitHub App

Foreman authenticates as a **GitHub App**, not with a personal token. Check-run data is not
retrievable with a PAT, and a PAT is a credential tied to a person rather than to an installation
that can be revoked on its own.

## State in production

**Registered, installed, and ingesting since 2026-09-21.** Checked on 2026-10-06 against the
production database and host (read-only), not inferred from the console:

- `server.env` on the host sets all four `GITHUB_*` variables, and an unsigned POST to
  `/webhooks/github` is refused with 401 "signature did not verify" — the receiver has a secret.
  (Without one it answers 503.)
- **One installation.** Every one of the 8,291 `ingest-webhook` jobs carries the same
  `installation.id` and a `gh:<delivery id>` idempotency key. The first arrived at
  2026-09-21 02:46 UTC, a minute before the three backfills; the newest within minutes of the
  check. By event: 7,026 `check_run`, 634 `push`, 608 `check_suite`, 23 `release`.
- **Rows from GitHub.** `check_run`: foreman 404, bindery 564, d3-auth 528, every one with the
  `external_id` GitHub sends (Actions' own job UUID). Their names, conclusions and completion
  times match what `gh api …/check-runs` reports for the same commit to the second. Commits:
  foreman 119, bindery 280, d3-auth 140. `reconcile-repo` has run 51 times, every run
  succeeded.
- Two ids are *not* stored, so do not look for them: GitHub's numeric check-run id (the code keeps
  `external_id` and falls back to the numeric id only when there is none), and `repo.github_id`,
  which is null on all three because nothing writes it.

### Only three repositories are linked

The App is installed more widely than Foreman reads. Deliveries arrive from eleven
repositories, and only these three are linked to a project:

| Project | Linked repository |
|---|---|
| `FRM` | `matdemers1/foreman` |
| `BND` | `matdemers1/bindery` |
| `AUTH` | `matdemers1/d3-auth` |

A delivery for any other repository is acknowledged, queued, and then **skipped** (`no linked
repo` in its job result; see `apps/server/src/jobs/ingest.ts`). It writes no commit or check-run
row, and a later link does not replay it — the link's backfill reads history from GitHub instead.

That is why `foreman_brief` reports `ci.unknown: true` for these projects. It is grey, not red:
no check run has been ingested, which says nothing about whether their builds pass.

| Project | Repository | Why CI is unknown |
|---|---|---|
| `CW` Clearwhen | none | The local repository has no remote; there is nothing on GitHub to install on |
| `DI` d3cloud.io | `matdemers1/d3cloud-www` | Delivering, not linked |
| `DS` Design System | `matdemers1/d3-design-system` | Delivering, not linked |
| `FLR` Floorspec | `matdemers1/d3-floorspec`, `matdemers1/floorspec` | Delivering, not linked |
| `PST` Postroom | `matdemers1/d3-postroom` | Delivering, not linked — the busiest repository (4,043 deliveries) |
| `SHP` Shipyard | `matdemers1/shipyard` | Delivering, not linked |

`matdemers1/d3-constellation` and `matdemers1/d3-app-contract` (project `CON`) deliver too and
are not linked either. To turn any of them on, link it (below); the backfill brings in the last
hundred commits and their check runs.

## Setting it up on a new instance

### Registering it

1. **Settings → Developer settings → GitHub Apps → New GitHub App**, on the account that owns the
   repositories.
2. Name it `foreman`. Homepage `https://foreman.d3cloud.io`.
3. **Webhook URL** `https://foreman.d3cloud.io/webhooks/github`, and generate a **webhook secret**.
4. **Repository permissions** — the least that works:
   - Contents: **Read-only** (commits and their files)
   - Checks: **Read-only** (check runs and conclusions)
   - Metadata: **Read-only** (mandatory)
   - Nothing else. In particular **not** Pull requests: Foreman does not ingest them
     (FRM-REQ-099), and a permission it does not use is a permission to be stolen.
5. **Subscribe to events**: Push, Check run, Check suite, Release. Again, not Pull request.
6. Generate a **private key** and download the `.pem`.
7. **Install** the App on the repositories to ingest, and note the installation id from the URL.

### Configuring

```bash
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=87654321
GITHUB_WEBHOOK_SECRET=<the secret from step 3>
# The key, with literal \n between lines. Both forms work; this is the one that survives a .env.
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
```

Restart the server and the worker. Neither refuses to start without these — a clone with no App
still runs, and the health screen shows the ingest jobs failing with a message naming the three
variables.

## Linking a repository

```bash
curl -X POST https://foreman.d3cloud.io/api/projects/BND/repos \
  -H "authorization: Bearer $FOREMAN_WRITE_TOKEN" \
  -H 'content-type: application/json' -d '{"fullName":"matdemers1/bindery"}'
```

Linking enqueues a backfill: commits, releases, and check runs for the last hundred commits. It runs
in the worker because it is minutes of API calls, and a link that blocked until history was read
would time out.

## What to check afterwards

- **Health** (`/system`) — "Last ingest" should move within a minute of a push.
- **Activity** (`/projects/BND/activity`) — the pushed commit, with any attribution proposed.
- A **redelivery** from the App's Advanced tab must produce no second row: the delivery id is the
  idempotency key.

## Token expiry

Installation tokens last an hour. The client refreshes **five minutes before** expiry rather than
after a 401, because the failure mode of the latter is not "it breaks" — it is "it works all
afternoon and quietly 401s overnight", discovered days later as missing commits (R-12).

If a request ever fails with 401 after an hour of idleness, that margin is the thing to look at.
