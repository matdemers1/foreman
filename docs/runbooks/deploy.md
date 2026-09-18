# Deploying

One origin, no host ports, behind a Cloudflare Tunnel. The server serves the built console as
statics, so there is one process to deploy and one certificate to care about.

## What runs

| Service | What it is |
|---|---|
| `server` | Express API + the built console. Runs migrations on boot. |
| `worker` | Job queue drain: ingest, attribution, reconcile, backup, restore drill. |
| `postgres` | PostgreSQL 16. The only stateful thing. |

The worker runs **no migrations** — the server owns the schema, so two processes never race to
change it.

## The standing rule

After every push to production, report **the commit SHA per image and the schema revision**. Both,
because "what is deployed" has two answers and the interesting failures are when they disagree — an
image rolled back over a migration that was not.

```bash
docker compose ps --format '{{.Service}} {{.Image}}'
curl -s https://foreman.d3cloud.io/health | jq '{schemaRevision, oidcReachable}'
```

`/health` is the deploy probe and answers JSON. The console's health *screen* is at `/system` —
they are different things, and a request to `/health` never reaches the SPA.

## Deploying

```bash
git pull
docker compose -f docker-compose.yml up -d --build --wait
```

`--wait` blocks until every healthcheck passes. The server's is `node dist/healthcheck.js`; the
worker's checks that its heartbeat file was touched in the last two minutes, which is the only way
to tell a drained queue from a dead worker.

Migrations run on the server's boot, before it serves. A migration that fails stops the boot, and
the old container keeps serving — which is the behaviour to want.

## Rolling back

```bash
git checkout <previous sha>
docker compose -f docker-compose.yml up -d --build --wait
```

**Migrations do not roll back.** If the release included one, restore from the dump taken before it
instead — see [backup-restore.md](backup-restore.md). This is the case the standing rule exists to
make visible: an image at an old SHA against a schema at a new revision is not a rollback, it is a
combination nobody has tested.

## Configuration

Everything comes from `.env`, except the two things Compose sets itself:

- `DATABASE_URL` — inside the network the database is `postgres:5432`, not the host's port.
- `BACKUP_DIR` — `/backups`, the only writable path in the image.

A developer's `.env` points at the host, which is why these are set in `docker-compose.yml`
rather than inherited. Getting this wrong is an afternoon: the container reads a host-shaped URL,
cannot resolve it, and the error names DNS rather than configuration.

## Health after a deploy

- `/health` — schema revision, whether D3 Auth is reachable.
- `/system` — the queue, last ingest, last backup, last restore drill.
- Both logins still work. The password path must work with D3 Auth unreachable (FRM-REQ-017);
  an e2e test asserts it, but after a deploy it is worth seeing.
