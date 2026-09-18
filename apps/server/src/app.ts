import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { schemaRevision } from './boot.js';
import { logger } from './logger.js';
import { attachAuth } from './auth/middleware.js';
import { authRoutes } from './routes/auth.js';

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
  // Behind the Cloudflare Tunnel, so `req.ip` must come from the proxy or every login shares one
  // throttle bucket. One hop, not `true`: trusting every hop lets a client spoof its own address.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));
  app.use(attachAuth({ db, config }));
  app.use('/auth', authRoutes({ db, config }));

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

  // An API path that matches nothing is a 404 in JSON, not Express's default HTML page: a client
  // parsing a response should never have to guess which it got.
  app.use('/api', apiNotFound);
  app.use('/auth', apiNotFound);
  app.use('/webhooks', apiNotFound);

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

  // Last: anything thrown or passed to next(err). Never leaks the message, which may carry a query,
  // a path, or a value from the row that failed.
  app.use(((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'unhandled request error',
    );
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  }) as ErrorRequestHandler);

  return app;
}

function apiNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}
