import { PageQuery } from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { confirmAttribution, rejectAttribution } from '../domain/attribution.js';
import { findProject } from '../domain/projects.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';

/**
 * Ingested reality over HTTP: commits, their attribution proposals, check runs and releases.
 *
 * The screen these serve (S-24) exists because of R-02: even with three signals a real share of
 * commits stay unattributed, and a coverage gap nobody can see is one nobody closes.
 */
export function realityRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  const CommitQuery = PageQuery.extend({
    /** `none` is the coverage gap; `proposed` is the review queue; `confirmed` is settled. */
    attributed: z.enum(['none', 'proposed', 'confirmed', 'any']).optional(),
    repo: z.string().optional(),
  });

  router.get(
    '/:code/commits',
    handler(async (req, res) => {
      const query = parseQuery(CommitQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));

      const attributed = query.attributed ?? 'any';
      const filters = {
        repo: {
          projectId: project.id,
          deletedAt: null,
          ...(query.repo === undefined ? {} : { fullName: query.repo }),
        },
        // An orphaned commit is history that no longer exists on the remote; it is not work
        // waiting to be attributed, and listing it as such would never empty the queue.
        orphanedAt: null,
        ...(attributed === 'none' ? { attributions: { none: {} } } : {}),
        ...(attributed === 'proposed'
          ? { attributions: { some: { confirmed: false, rejectedAt: null } } }
          : {}),
        ...(attributed === 'confirmed' ? { attributions: { some: { confirmed: true } } } : {}),
      };

      const [rows, total] = await Promise.all([
        db.commit.findMany({
          where: filters,
          orderBy: { committedAt: 'desc' },
          take: query.limit,
          include: {
            repo: { select: { fullName: true } },
            files: { select: { path: true } },
            attributions: {
              include: { task: { select: { humanId: true, title: true, status: true } } },
            },
          },
        }),
        db.commit.count({ where: filters }),
      ]);

      res.json({
        items: rows.map(({ attributions, files, ...commit }) => ({
          ...commit,
          files: files.map((f) => f.path),
          attributions: attributions.map((a) => ({
            task: a.task,
            source: a.source,
            confidence: Number(a.confidence),
            confirmed: a.confirmed,
            rejectedAt: a.rejectedAt,
            evidence: a.evidence,
          })),
        })),
        nextCursor: null,
        total,
      });
    }),
  );

  const AttributionBody = z.object({ task: z.string().min(1) });

  router.post(
    '/:code/attributions/:sha/confirm',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AttributionBody, req, res);
      if (body === null) return;
      res.json(await confirmAttribution(db, actorOf(req), param(req, 'sha'), body.task));
    }),
  );

  router.post(
    '/:code/attributions/:sha/reject',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AttributionBody, req, res);
      if (body === null) return;
      res.json(await rejectAttribution(db, actorOf(req), param(req, 'sha'), body.task));
    }),
  );

  return router;
}
