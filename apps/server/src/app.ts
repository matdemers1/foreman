import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { schemaRevision } from './boot.js';

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
}

/**
 * The Express app. Routes arrive in Phase 1; what exists here from Phase 0 is what the Compose
 * healthchecks and the tunnel need.
 */
export function createApp({ config, db }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  /** Liveness: the process is up. Deliberately touches nothing else. */
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  /** Readiness: the database answers. A server that cannot reach Postgres is not ready. */
  app.get('/readyz', async (_req, res) => {
    try {
      await db.$queryRaw`select 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, reason: 'database unreachable' });
    }
  });

  /**
   * The operational view. Queue depth, last ingest, last backup and the running schema revision —
   * the standing rule is that a deployment can state its SHA and its schema revision.
   */
  app.get('/health', async (_req, res) => {
    const [queued, running, failed, revision] = await Promise.all([
      db.job.count({ where: { status: 'queued' } }),
      db.job.count({ where: { status: 'running' } }),
      db.job.count({ where: { status: 'failed' } }),
      schemaRevision(config.DATABASE_URL),
    ]);
    res.json({
      ok: failed === 0,
      queue: { queued, running, failed },
      schemaRevision: revision,
      oidcConfigured: config.oidcConfigured,
    });
  });

  // The console is served by the API, not by a second process (Architecture: one origin, one
  // cookie, no CORS). In development Vite serves it instead and CONSOLE_DIST is unset.
  const consoleDist = config.CONSOLE_DIST;
  if (consoleDist !== undefined && existsSync(consoleDist)) {
    app.use(express.static(consoleDist, { index: false, maxAge: '1h' }));
    // SPA fallback, but never for the API: a mistyped endpoint must 404, not return HTML.
    app.get(/^(?!\/(?:api|auth|webhooks|healthz|readyz|health)\b).*/, (_req, res) => {
      res.sendFile(join(consoleDist, 'index.html'));
    });
  }

  return app;
}
