import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { approximateTokens, buildBrief } from '../domain/brief.js';
import { handler, param } from './helpers.js';

/**
 * `GET /api/brief/:code` — the session brief.
 *
 * The one endpoint whose cost matters as much as its content: it is what a Claude session calls
 * first, every time, and every token it spends is one the actual work does not get.
 */
export function briefRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));

  router.get(
    '/:code',
    handler(async (req, res) => {
      const brief = await buildBrief(db, param(req, 'code'));
      // Advisory, and honest: a caller can see what the answer cost without measuring it.
      res.setHeader('X-Foreman-Approx-Tokens', String(approximateTokens(brief)));
      res.json(brief);
    }),
  );

  return router;
}
