import {
  PageQuery,
  PhaseCreate,
  ProjectCreate,
  ProjectUpdate,
  RequirementCreate,
  RequirementUpdate,
  TaskCreate,
  TaskUpdate,
} from '@foreman/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { softDelete } from '../domain/undo.js';
import {
  createPhase,
  createProject,
  createRequirement,
  createTask,
  findProject,
  listPhases,
  updateProject,
  updateRequirement,
  updateTask,
} from '../domain/projects.js';
import { requireAuth, requireScope } from '../auth/middleware.js';
import {
  actorOf,
  decodeCursor,
  encodeCursor,
  handler,
  param,
  parseBody,
  parseQuery,
} from './helpers.js';

/**
 * The spine over HTTP: projects, phases, requirements, tasks.
 *
 * Every list is paged — **no route returns an unbounded list** (FRM-REQ-092). One project already
 * has 439 requirements, and an endpoint that returns all of them is one that works right up until
 * the day it is asked about the real corpus.
 */

export function projectRoutes(db: Db): Router {
  const router = Router();
  router.use(requireAuth);
  // Reading needs `read`; anything that changes state needs `write`, and a denial is audited.
  router.use(requireScope(db, 'read'));
  const canWrite = requireScope(db, 'write');

  // ─── Projects ────────────────────────────────────────────────────────────

  router.get(
    '/',
    handler(async (req, res) => {
      const query = parseQuery(PageQuery, req, res);
      if (query === null) return;

      const after = decodeCursor(query.cursor);
      const projects = await db.project.findMany({
        where: { deletedAt: null, ...(after === null ? {} : { code: { gt: after } }) },
        orderBy: { code: 'asc' },
        take: query.limit + 1,
      });

      const items = projects.slice(0, query.limit);
      const hasMore = projects.length > query.limit;
      res.json({
        items,
        nextCursor: hasMore ? encodeCursor(items.at(-1)?.code ?? '') : null,
        total: await db.project.count({ where: { deletedAt: null } }),
      });
    }),
  );

  router.post(
    '/',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectCreate, req, res);
      if (body === null) return;
      const project = await createProject(db, actorOf(req), body);
      res.status(201).json(project);
    }),
  );

  router.get(
    '/:code',
    handler(async (req, res) => {
      const project = await findProject(db, param(req, 'code'));
      const [phases, requirements, tasks, openFindings] = await Promise.all([
        db.phase.count({ where: { projectId: project.id, deletedAt: null } }),
        db.requirement.count({ where: { projectId: project.id, deletedAt: null } }),
        db.task.count({ where: { projectId: project.id, deletedAt: null } }),
        db.finding.count({ where: { projectId: project.id, status: 'open', deletedAt: null } }),
      ]);
      res.json({ ...project, counts: { phases, requirements, tasks, openFindings } });
    }),
  );

  router.patch(
    '/:code',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(ProjectUpdate, req, res);
      if (body === null) return;
      res.json(await updateProject(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  // ─── Phases ──────────────────────────────────────────────────────────────

  router.get(
    '/:code/phases',
    handler(async (req, res) => {
      // Ordered by build order, not by number: Bindery built 0–8.5, 9–11, 13–16, with 12 ahead.
      const phases = await listPhases(db, param(req, 'code'));
      res.json({ items: phases, nextCursor: null, total: phases.length });
    }),
  );

  router.post(
    '/:code/phases',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(PhaseCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createPhase(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  // ─── Requirements ────────────────────────────────────────────────────────

  const RequirementQuery = PageQuery.extend({
    priority: z.enum(['M', 'S', 'C', 'W']).optional(),
    phase: z.string().optional(),
    /** Requirements no task covers — the coverage hole, which is the point of the register. */
    uncovered: z.coerce.boolean().optional(),
    earsLint: z.enum(['ok', 'warned']).optional(),
  });

  router.get(
    '/:code/requirements',
    handler(async (req, res) => {
      const query = parseQuery(RequirementQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const rows = await db.requirement.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          ...(query.priority === undefined ? {} : { priority: query.priority }),
          ...(query.phase === undefined ? {} : { phase: { humanId: query.phase } }),
          ...(query.earsLint === undefined ? {} : { earsLintOk: query.earsLint === 'ok' }),
          ...(query.uncovered === true ? { tasks: { none: {} } } : {}),
          ...(after === null ? {} : { seq: { gt: Number(after) } }),
        },
        orderBy: { seq: 'asc' },
        take: query.limit + 1,
        include: { tasks: { select: { taskId: true } } },
      });

      const items = rows.slice(0, query.limit);
      res.json({
        items: items.map((row) => ({
          ...row,
          coveredBy: row.tasks.length,
          tasks: undefined,
        })),
        nextCursor:
          rows.length > query.limit ? encodeCursor(String(items.at(-1)?.seq ?? '')) : null,
        total: null,
      });
    }),
  );

  router.post(
    '/:code/requirements',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RequirementCreate, req, res);
      if (body === null) return;
      // The EARS lint runs inside, and warns rather than rejecting.
      res.status(201).json(await createRequirement(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/requirements/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(RequirementUpdate, req, res);
      if (body === null) return;
      res.json(await updateRequirement(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  // ─── Tasks ───────────────────────────────────────────────────────────────

  const TaskQuery = PageQuery.extend({
    phase: z.string().optional(),
    status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  });

  router.get(
    '/:code/tasks',
    handler(async (req, res) => {
      const query = parseQuery(TaskQuery, req, res);
      if (query === null) return;
      const project = await findProject(db, param(req, 'code'));
      const after = decodeCursor(query.cursor);

      const rows = await db.task.findMany({
        where: {
          projectId: project.id,
          deletedAt: null,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.phase === undefined ? {} : { phase: { humanId: query.phase } }),
          ...(after === null ? {} : { humanId: { gt: after } }),
        },
        orderBy: { humanId: 'asc' },
        take: query.limit + 1,
        include: {
          files: { select: { path: true } },
          requirements: { select: { requirement: { select: { humanId: true } } } },
        },
      });

      const items = rows.slice(0, query.limit).map((row) => ({
        ...row,
        files: row.files.map((f) => f.path),
        requirements: row.requirements.map((r) => r.requirement.humanId),
      }));
      res.json({
        items,
        nextCursor: rows.length > query.limit ? encodeCursor(items.at(-1)?.humanId ?? '') : null,
        total: null,
      });
    }),
  );

  router.post(
    '/:code/tasks',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TaskCreate, req, res);
      if (body === null) return;
      res.status(201).json(await createTask(db, actorOf(req), param(req, 'code'), body));
    }),
  );

  router.patch(
    '/:code/tasks/:humanId',
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(TaskUpdate, req, res);
      if (body === null) return;
      res.json(await updateTask(db, actorOf(req), param(req, 'humanId'), body));
    }),
  );

  router.delete(
    '/:code/requirements/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'requirement', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  router.delete(
    '/:code/tasks/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'task', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  router.delete(
    '/:code/phases/:humanId',
    canWrite,
    handler(async (req, res) => {
      await softDelete(db, actorOf(req), 'phase', param(req, 'humanId'));
      res.status(204).end();
    }),
  );

  return router;
}
