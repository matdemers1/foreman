import { LinkInput } from '@foreman/shared';
import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { link, unlink } from '../domain/links.js';
import { actorOf, handler, parseBody } from './helpers.js';

/**
 * `POST /api/links` — citations between entities.
 *
 * A link is what coverage is computed from, which is why removing one is gated and adding one is
 * not: the cost of a wrong link is a wrong number, and the cost of a lost link is a wrong number
 * nobody can see.
 */
export function linkRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'write'));

  router.post(
    '/',
    handler(async (req, res) => {
      const body = parseBody(LinkInput, req, res);
      if (body === null) return;
      const result = body.remove
        ? await unlink(db, actorOf(req), body.from, body.to, body.kind)
        : await link(db, actorOf(req), body.from, body.to, body.kind);
      res.json(result);
    }),
  );

  return router;
}
