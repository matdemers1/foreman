# The GitHub App

Foreman authenticates as a **GitHub App**, not with a personal token. Check-run data is not
retrievable with a PAT, and a PAT is a credential tied to a person rather than to an installation
that can be revoked on its own.

> [!warning]
> **This has never been run against real GitHub.** The client, its JWT signing and the
> refresh-before-expiry logic are written and tested against a stub; no App is registered. What
> follows is the procedure, not a record of it having been done — unlike
> [backup-restore.md](backup-restore.md), which records a drill that was actually performed.

## Registering it

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

## Configuring

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
