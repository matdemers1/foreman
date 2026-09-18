import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { schemaRevision } from './boot.js';
import { logger } from './logger.js';
import { attachAuth } from './auth/middleware.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { projectRoutes } from './routes/projects.js';
import { briefRoutes } from './routes/brief.js';
import { searchRoutes } from './routes/search.js';
import { coverageRoutes } from './routes/coverage.js';
import { recordRoutes } from './routes/record.js';
import { realityRoutes } from './routes/reality.js';
import { webhookRoutes } from './routes/webhooks.js';
import { buildRegistry, type JobRegistry } from './jobs/index.js';
import { linkRoutes } from './routes/links.js';
import { tokenRoutes } from './routes/tokens.js';
import { undoRoutes } from './routes/undo.js';
import type { OidcClient } from './auth/oidc.js';

export interface MountedRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * Every route the app mounts, recorded as it is mounted.
 *
 * Express 5 does not expose a router's mount path statically — it is compiled into a matcher — so
 * reconstructing the surface by introspection means parsing regexps. Declaring it here instead is
 * both simpler and more honest: the app states what it serves, and the route-enumeration tests
 * check that every one of them behaves (T-2.1, T-2.11).
 */
export function mountedRoutes(app: Express): readonly MountedRoute[] {
  return (app as Express & { locals: { foremanRoutes?: MountedRoute[] } }).locals.foremanRoutes ?? [];
}

function mount(app: Express, prefix: string, router: Router): void {
  app.use(prefix, router);

  const routes = ((app.locals as { foremanRoutes?: MountedRoute[] }).foremanRoutes ??= []);
  const stack = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] })
    .stack;

  for (const layer of stack) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      const path = `${prefix}${layer.route.path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      routes.push({ method: method.toUpperCase(), path });
    }
  }
}

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  /**
   * Null when D3 Auth is not configured, or was unreachable at boot. The console then shows one
   * login button instead of two, and nothing else changes (FRM-REQ-017).
   */
  readonly oidc?: OidcClient | null;
  /** Shared with the worker in production; built here when absent. Swapped in tests. */
  readonly registry?: JobRegistry;
}

/**
 * The Express app. Routes arrive in Phase 1; what exists here from Phase 0 is what the Compose
 * healthchecks and the tunnel need.
 */
export function createApp({ config, db, oidc = null, registry }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind the Cloudflare Tunnel, so `req.ip` must come from the proxy or every login shares one
  // throttle bucket. One hop, not `true`: trusting every hop lets a client spoof its own address.
  app.set('trust proxy', 1);
  // Before `express.json`, and with its own raw parser: the HMAC is over the exact bytes GitHub
  // sent, and a re-serialised object is not those bytes.
  app.use('/webhooks', webhookRoutes({ db, config, registry: registry ?? buildRegistry({ config }) }));
  app.use(express.json({ limit: '2mb' }));
  app.use(attachAuth({ db, config }));
  mount(app, '/auth', authRoutes({ db, config, oidcAvailable: oidc !== null }));
  mount(app, '/auth/oidc', oidcRoutes({ db, config, client: oidc }));
  mount(app, '/api/projects', projectRoutes(db));
  mount(app, '/api/brief', briefRoutes(db));
  mount(app, '/api', searchRoutes(db));
  mount(app, '/api/undo', undoRoutes(db));
  mount(app, '/api/tokens', tokenRoutes(db));
  mount(app, '/api/links', linkRoutes(db));
  mount(app, '/api/projects', coverageRoutes(db));
  mount(app, '/api/projects', recordRoutes(db));
  mount(app, '/api/projects', realityRoutes(db));

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
      // Configured and reachable are different questions, and only the second one decides
      // whether the console should offer the button.
      oidcReachable: oidc !== null,
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
