# Backup and restore

ADR-007: **the database dump is the only escape hatch.** After the cutover there is no markdown
mirror behind Foreman, so this file is the entire recovery story for anything created in it.

## What runs on its own

| Job | When | Idempotency key |
|---|---|---|
| `backup` | nightly | `backup:<YYYY-MM-DD>` |
| `restore-drill` | weekly | `restore-drill:<ISO week>` |

Both are scheduled by the worker on its idle tick rather than by cron. The key carries the date, so
asking every minute enqueues one job — and a worker started at noon still gets that day's run,
where a timer firing "every 24 hours" skips a day on every restart.

Dumps land in `BACKUP_DIR` (`/backups` in the image, a Docker volume) as
`foreman-<timestamp>.sql.gz`, and anything older than `BACKUP_RETENTION_DAYS` is pruned by the
second stage of the same job.

## Taking one now

```bash
docker compose exec server node dist/cli/run-job.js backup
```

It refuses a dump under 1 KiB. A dump that small restored nothing, and catching it here — where the
fix is cheap — beats finding out during a restore, where it is not.

## The drill

`FRM-REQ-145` is satisfied by **performing** a restore, not by writing this file. Bindery's own code
review found a restore drill "verified by grepping" rather than by running; that finding is free to
inherit.

```bash
docker compose exec server node dist/cli/run-job.js restore-drill
```

The job creates a scratch database, restores the newest dump into it, **queries it**, and drops it
in a `finally` — so a failed drill leaves nothing behind to fill the disk it was protecting.

## Restoring for real

The drill proves the dump is readable. This is what you do when you actually need it.

```bash
# 1. A clean database beside the live one.
docker compose exec postgres psql -U foreman -d postgres -c 'create database foreman_restored'

# 2. The newest dump into it. ON_ERROR_STOP, or a half-restore looks like a success.
docker compose exec server sh -c \
  'gunzip -c /backups/$(ls -t /backups | head -1) \
   | psql "postgresql://foreman:foreman@postgres:5432/foreman_restored" -v ON_ERROR_STOP=1'

# 3. Check it holds what you expect before you trust it.
docker compose exec postgres psql -U foreman -d foreman_restored \
  -tAc "select count(*) from project"

# 4. Boot the app against it on a spare port and log in.
docker compose exec -e DATABASE_URL=postgresql://foreman:foreman@postgres:5432/foreman_restored \
  -e PORT=3299 server node dist/index.js
```

Then point `DATABASE_URL` at the restored database and restart the stack.

## Performed on 2026-09-18

Not a description of what would happen — what did:

```console
$ docker compose exec server node dist/cli/run-job.js backup
  dump: succeeded
    {"path":"/backups/foreman-2026-09-18T18-57-37.sql.gz","bytes":169064}
  prune: succeeded
backup: succeeded

$ docker compose exec server node dist/cli/run-job.js restore-drill
  restore: succeeded
    {"dump":"foreman-2026-09-18T18-57-37.sql.gz","verifiedAt":"2026-09-18T18:57:40.350Z"}
restore-drill: succeeded
```

And the full path, restored into a clean database with the app booted against it:

```console
projects=2
users=1
login status: 200 {"status":"signed_in"}
session: 200 {"authenticated":true,"user":{"email":"dev@localhost", ...}}
```

The scratch and restored databases were dropped afterwards.

## What breaks it

- **`pg_dump` not on `PATH`.** The server image installs `postgresql-client-16`; a developer's Mac
  usually has neither, which is why the integration tests skip these on a host without them and CI
  runs them in the image.
- **A version mismatch.** `pg_dump` from a client older than the server refuses. The image pins the
  major version to the one Compose runs.
- **A dump taken as a role that no longer exists.** `--no-owner --no-privileges` is why this does
  not happen: a dump that can only be restored as the role that made it is a dump that fails on the
  day it is needed, on a fresh host.
