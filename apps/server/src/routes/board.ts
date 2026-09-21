import {
  IdeaCommentCreate,
  IdeaScoreInput,
  InviteCreate,
  MemberUpdate,
  ProjectIdeaFund,
} from '@foreman/shared';
import { Router } from 'express';
import { requireAuth, requireRole, requireScope, reviews } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import {
  comment,
  commentsFor,
  deleteComment,
  fund,
  score,
  scoresFor,
} from '../domain/board.js';
import { invite, listMembers, setRole, suspend } from '../domain/members.js';
import { notifyDecision } from '../adapters/mail.js';
import { actorOf, handler, param, parseBody } from './helpers.js';

/**
 * The innovation-fund board's own surface (FRM-ADR-016): members, scoring, discussion, funding.
 *
 * **Mounted in both modes and guarded in one.** A route that exists only in the board build is a
 * route only the board build has ever run, and the difference would surface as a 404 in
 * production on the day somebody flipped the flag. So these are always here, and `boardOnly`
 * answers 404 in `solo` — the same answer a route that did not exist would give, reached by a
 * path that is tested.
 */
export function boardRoutes(db: Db, config: Config): Router {
  const router = Router();
  const canWrite = requireScope(db, 'write');

  /** In `solo` there is one operator and nothing to administer; the board's surface is not there. */
  const boardOnly = (
    _req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction,
  ): void => {
    if (config.FOREMAN_MODE !== 'board') {
      res.status(404).json({ error: 'this Foreman is not running an innovation board' });
      return;
    }
    next();
  };

  router.use(requireAuth);

  // ── Members ────────────────────────────────────────────────────────────────
  router.get(
    '/members',
    boardOnly,
    requireRole(config, 'admin'),
    handler(async (_req, res) => {
      res.json({ items: await listMembers(db) });
    }),
  );

  router.post(
    '/members/invite',
    boardOnly,
    canWrite,
    requireRole(config, 'admin'),
    handler(async (req, res) => {
      const body = parseBody(InviteCreate, req, res);
      if (body === null) return;
      const issued = await invite(db, config, { ...actorOf(req), userId: req.auth?.userId }, body);

      // The link is returned as well as emailed. Mail is the convenient path and not the reliable
      // one — a relay that is down or an address that bounces must not leave an admin with an
      // account nobody can reach and no way to find out.
      await notifyDecision(config, {
        to: issued.user.email,
        subject: 'You have been invited to the innovation board',
        body: `${issued.user.displayName}, you have been invited.\n\nSet a password: ${issued.acceptUrl}\n\nThe link expires ${issued.expiresAt.toISOString()}.`,
      });

      res.status(201).json({
        user: issued.user,
        acceptUrl: issued.acceptUrl,
        expiresAt: issued.expiresAt,
      });
    }),
  );

  router.patch(
    '/members/:id',
    boardOnly,
    canWrite,
    requireRole(config, 'admin'),
    handler(async (req, res) => {
      const body = parseBody(MemberUpdate, req, res);
      if (body === null) return;
      const id = param(req, 'id');
      let member = body.role === undefined ? null : await setRole(db, actorOf(req), id, body.role);
      if (body.suspended !== undefined) {
        member = await suspend(db, actorOf(req), id, body.suspended);
      }
      res.json(member ?? { unchanged: true });
    }),
  );

  // ── Scoring ────────────────────────────────────────────────────────────────
  router.get(
    '/ideas/:humanId/scores',
    boardOnly,
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      res.json(await scoresFor(db, param(req, 'humanId')));
    }),
  );

  router.put(
    '/ideas/:humanId/scores',
    boardOnly,
    canWrite,
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      const body = parseBody(IdeaScoreInput, req, res);
      if (body === null) return;
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        // A token has scopes, not seniority. Scoring is a person's judgement and is recorded
        // against a person, so there is nobody here to record it against.
        res.status(403).json({ error: 'a token cannot score a submission' });
        return;
      }
      res.json(await score(db, actorOf(req), userId, param(req, 'humanId'), body));
    }),
  );

  // ── Discussion ─────────────────────────────────────────────────────────────
  router.get(
    '/ideas/:humanId/comments',
    boardOnly,
    handler(async (req, res) => {
      const items = await commentsFor(db, param(req, 'humanId'), reviews(config, req.auth));
      res.json({ items });
    }),
  );

  router.post(
    '/ideas/:humanId/comments',
    boardOnly,
    canWrite,
    handler(async (req, res) => {
      const body = parseBody(IdeaCommentCreate, req, res);
      if (body === null) return;
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        res.status(403).json({ error: 'a token cannot comment' });
        return;
      }
      res
        .status(201)
        .json(
          await comment(
            db,
            actorOf(req),
            userId,
            param(req, 'humanId'),
            body,
            reviews(config, req.auth),
          ),
        );
    }),
  );

  router.delete(
    '/comments/:id',
    boardOnly,
    canWrite,
    handler(async (req, res) => {
      const userId = req.auth?.userId;
      if (userId === null || userId === undefined) {
        res.status(403).json({ error: 'a token cannot withdraw a comment' });
        return;
      }
      res.json(
        await deleteComment(db, actorOf(req), userId, param(req, 'id'), req.auth?.role === 'admin'),
      );
    }),
  );

  // ── Funding ────────────────────────────────────────────────────────────────
  router.post(
    '/ideas/:humanId/fund',
    boardOnly,
    canWrite,
    requireRole(config, 'admin', 'reviewer'),
    handler(async (req, res) => {
      const body = parseBody(ProjectIdeaFund, req, res);
      if (body === null) return;
      const funded = await fund(db, actorOf(req), param(req, 'humanId'), body);

      // The submitter is told. A board that decides in a meeting and never says so is the failure
      // every innovation fund actually has, and it is one email.
      if (funded.submittedBy !== null) {
        const amount = (body.amountCents / 100).toFixed(2);
        await notifyDecision(config, {
          to: funded.submittedBy.email,
          subject: `${funded.humanId} has been funded`,
          body: `${funded.submittedBy.displayName}, your submission "${funded.title}" has been funded: ${config.CURRENCY} ${amount}.\n\n${body.reason}\n\n${config.BASE_URL}/project-ideas`,
        });
      }
      res.json(funded);
    }),
  );

  return router;
}
