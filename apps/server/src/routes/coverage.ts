import { Router } from 'express';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { coverageFor, exitGate, traceabilityMatrix } from '../domain/coverage.js';
import { handler, param } from './helpers.js';

/**
 * Coverage, the traceability matrix, and the exit gate as a question you can ask before you commit
 * to the answer.
 */
export function coverageRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));

  router.get(
    '/:code/coverage',
    handler(async (req, res) => {
      res.json(await coverageFor(db, param(req, 'code')));
    }),
  );

  router.get(
    '/:code/matrix',
    handler(async (req, res) => {
      const items = await traceabilityMatrix(db, param(req, 'code'));
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  // Asked, not performed: the console shows what stands in the way before anybody presses
  // complete, so the refusal is never the first time somebody hears about it.
  router.get(
    '/:code/phases/:humanId/gate',
    handler(async (req, res) => {
      res.json(await exitGate(db, param(req, 'humanId')));
    }),
  );

  return router;
}
