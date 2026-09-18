import { PageQuery } from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireScope } from '../auth/middleware.js';
import type { Db } from '../db.js';
import { record } from '../domain/audit.js';
import { confirmAttribution, rejectAttribution } from '../domain/attribution.js';
import { findProject } from '../domain/projects.js';
import { cadenceFor, ciFor, releaseNotes } from '../domain/reality.js';
import { enqueue, type JobRegistry } from '../jobs/index.js';
import { actorOf, handler, param, parseBody, parseQuery } from './helpers.js';

/**
 * Ingested reality over HTTP: commits, their attribution proposals, check runs and releases.
 *
 * The screen these serve (S-24) exists because of R-02: even with three signals a real share of
 * commits stay unattributed, and a coverage gap nobody can see is one nobody closes.
 */
export function realityRoutes(db: Db, registry?: JobRegistry): Router {
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

  const AttributionBody = z.object({
    task: z.string().min(1),
    /**
     * Set by `foreman_attribute`. A declaration is signal 1 — the one party that was there saying
     * what it did — so it is recorded as `declared`, not as whatever a proposal had guessed.
     */
    declared: z.boolean().optional(),
  });

  router.post(
    '/:code/attributions/:sha/confirm',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(AttributionBody, req, res);
      if (body === null) return;
      res.json(
        await confirmAttribution(db, actorOf(req), param(req, 'sha'), body.task, {
          ...(body.declared === undefined ? {} : { declared: body.declared }),
        }),
      );
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

  // ─── Repositories (T-5.4, FRM-REQ-033, FRM-REQ-102) ──────────────────────

  router.get(
    '/:code/repos',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const items = await db.repo.findMany({
        where: { projectId: project.id, deletedAt: null },
        orderBy: { fullName: 'asc' },
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  const RepoBody = z.object({
    fullName: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'a repository is owner/name'),
    defaultBranch: z.string().max(200).optional(),
  });

  /**
   * Link a repository — and backfill it (FRM-REQ-102).
   *
   * A project may link more than one (FRM-REQ-033): Foreman's own console, server and shim live in
   * one repository, but Burrow's app and its Atlas pipeline do not.
   *
   * The backfill is enqueued rather than run: it is minutes of API calls, and a link that blocks
   * until history is read is a link that times out.
   */
  router.post(
    '/:code/repos',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RepoBody, req, res);
      if (body === null) return;
      const project = await findProject(db, param(req, 'code'));

      const existing = await db.repo.findFirst({ where: { fullName: body.fullName } });
      if (existing !== null && existing.deletedAt === null) {
        res.status(409).json({
          error:
            existing.projectId === project.id
              ? `${body.fullName} is already linked to ${project.code}`
              : `${body.fullName} is linked to another project`,
        });
        return;
      }

      const repo = await db.$transaction(async (tx) => {
        const created = await tx.repo.upsert({
          where: { fullName: body.fullName },
          create: {
            projectId: project.id,
            fullName: body.fullName,
            ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
          },
          update: { projectId: project.id, deletedAt: null },
        });
        await record(tx, {
          ...actorOf(req),
          action: 'create',
          entityType: 'repo',
          entityId: created.id,
          entityHumanId: created.fullName,
          after: created,
        });
        return created;
      });

      if (registry !== undefined) {
        await enqueue(db, registry, 'backfill-repo', {
          payload: { repoId: repo.id },
          // One backfill per repository: a second link attempt must not start a second read of
          // the same history.
          idempotencyKey: `backfill:${repo.id}`,
        });
      }

      res.status(201).json(repo);
    }),
  );

  // ─── What is running (T-5.11) ────────────────────────────────────────────

  router.get(
    '/:code/ci',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      res.json(await ciFor(db, project.id));
    }),
  );

  router.get(
    '/:code/cadence',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      res.json(await cadenceFor(db, project.id));
    }),
  );

  router.get(
    '/:code/deployments',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const items = await db.deployment.findMany({
        where: { projectId: project.id },
        orderBy: { deployedAt: 'desc' },
        take: 50,
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  const DeploymentBody = z.object({
    environment: z.string().min(1).max(60),
    image: z.string().min(1).max(500),
    /** The image digest. What is *running*, as opposed to what a tag pointed at when it was read. */
    imageSha: z.string().min(7).max(200),
    schemaRevision: z.string().max(200).optional(),
    deployedAt: z.iso.datetime({ offset: true }).optional(),
    note: z.string().max(1000).optional(),
  });

  /**
   * Record a deployment (FRM-REQ-098).
   *
   * Image SHA **and** schema revision, together, because "what is deployed" has two answers and
   * the interesting failures are when they disagree — an image rolled back over a migration that
   * was not.
   */
  router.post(
    '/:code/deployments',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(DeploymentBody, req, res);
      if (body === null) return;
      const project = await findProject(db, param(req, 'code'));

      const deployment = await db.$transaction(async (tx) => {
        const created = await tx.deployment.create({
          data: {
            projectId: project.id,
            environment: body.environment,
            image: body.image,
            imageSha: body.imageSha,
            ...(body.schemaRevision === undefined ? {} : { schemaRevision: body.schemaRevision }),
            deployedAt: body.deployedAt === undefined ? new Date() : new Date(body.deployedAt),
            ...(body.note === undefined ? {} : { note: body.note }),
          },
        });
        await record(tx, {
          ...actorOf(req),
          action: 'create',
          entityType: 'deployment',
          entityId: created.id,
          after: created,
        });
        return created;
      });

      res.status(201).json(deployment);
    }),
  );

  // ─── Releases and their notes (T-5.12) ───────────────────────────────────

  router.get(
    '/:code/releases',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const items = await db.release.findMany({
        where: { repo: { projectId: project.id, deletedAt: null } },
        orderBy: { publishedAt: 'desc' },
        take: 50,
      });
      res.json({ items, nextCursor: null, total: items.length });
    }),
  );

  router.get(
    '/:code/releases/:tag/notes',
    handler(async (req, res) => {
      res.json(await releaseNotes(db, param(req, 'code'), param(req, 'tag')));
    }),
  );

  return router;
}
