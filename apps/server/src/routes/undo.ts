import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { undo } from '../domain/undo.js';
import { actorOf, handler, param } from './helpers.js';

/**
 * `POST /api/undo/:auditEventId` — reverse one mutation.
 *
 * The audit trail is not only a record; it is the mechanism. Every mutation is undoable because
 * every mutation wrote what it replaced, in the same transaction.
 */
export function undoRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    '/:auditEventId',
    handler(async (req, res) => {
      res.json(await undo(db, actorOf(req), param(req, 'auditEventId')));
    }),
  );

  return router;
}
