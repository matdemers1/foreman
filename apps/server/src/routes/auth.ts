import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { InviteAccept } from '@foreman/shared';
import { record } from '../domain/audit.js';
import { acceptInvite } from '../domain/members.js';
import { logger } from '../logger.js';
import { isSecureOrigin, requireUser } from '../auth/middleware.js';
import * as native from '../auth/native.js';
import * as sessions from '../auth/sessions.js';

/**
 * The app-native login routes. The OIDC routes join them in T-0.7 — **beside** these, never in
 * front of them: ADR-004 makes both paths permanent, and this one has to work with the issuer
 * unreachable.
 */

const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  totpCode: z.string().max(16).optional(),
});

export interface AuthRouteDeps {
  readonly db: Db;
  readonly config: Config;
  /** Whether the D3 Auth button should be offered at all. */
  readonly oidcAvailable?: boolean;
}

export function authRoutes(deps: AuthRouteDeps): Router {
  const router = Router();
  const secure = isSecureOrigin(deps.config);

  /**
   * Spend an invitation: choose a password (FRM-ADR-016).
   *
   * Here rather than under `/api/board`, for two reasons. It is an authentication flow — it sets
   * a credential — and `/api` is guarded in its entirety by the search router mounted at that
   * prefix, so a public endpoint cannot live under it at all.
   *
   * It deliberately does not return a session. Accepting proves the person holds the token from
   * their email; signing in proves they know the password they just chose.
   */
  router.post('/invite/accept', (req, res, next) => {
    void (async () => {
      const parsed = InviteAccept.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'the request body is not valid',
          fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      if (deps.config.FOREMAN_MODE !== 'board') {
        res.status(404).json({ error: 'this Foreman is not running an innovation board' });
        return;
      }
      try {
        const { email } = await acceptInvite(deps.db, deps.config, parsed.data);
        res.json({ email, next: 'sign in with the password you just set' });
      } catch {
        // One answer for every failure, decided in the domain: telling them apart tells an
        // attacker which of their guesses was a real invitation.
        res.status(404).json({ error: 'that invitation is not usable — ask for a new one' });
      }
    })().catch(next);
  });

  router.post('/login', (req, res) => {
    void (async () => {
      const parsed = LoginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'email and password are required' });
        return;
      }

      const outcome = await native.login(deps, {
        email: parsed.data.email,
        password: parsed.data.password,
        totpCode: parsed.data.totpCode,
        ip: req.ip ?? 'unknown',
        userAgent: req.get('user-agent'),
      });

      switch (outcome.kind) {
        case 'throttled': {
          const seconds = Math.ceil(outcome.retryAfterMs / 1000);
          res.setHeader('Retry-After', String(seconds));
          // The scope is deliberately not disclosed: which limit was hit is information.
          res.status(429).json({ error: 'too many attempts', retryAfterSeconds: seconds });
          return;
        }
        case 'rejected': {
          // One message for every failure — wrong account, wrong password, wrong code.
          res.status(401).json({ error: 'invalid credentials' });
          return;
        }
        case 'totp_required': {
          res.status(200).json({ status: 'totp_required' });
          return;
        }
        case 'session': {
          sessions.setCookie(res, outcome.token, secure);
          await record(deps.db, {
            actor: parsed.data.email.trim().toLowerCase(),
            actorKind: 'user',
            action: 'create',
            entityType: 'user',
            entityId: outcome.userId,
            after: { event: 'login', method: 'password' },
          });
          logger.info({ userId: outcome.userId, method: 'password' }, 'login');
          res.status(200).json({ status: 'signed_in' });
          return;
        }
      }
    })().catch((error: unknown) => {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'login failed');
      res.status(500).json({ error: 'login failed' });
    });
  });

  router.post('/logout', (req, res) => {
    void (async () => {
      const sessionId = req.auth?.sessionId;
      if (sessionId !== undefined) {
        await sessions.revoke(deps.db, sessionId);
        await record(deps.db, {
          actor: req.auth?.actor ?? 'unknown',
          actorKind: 'user',
          action: 'delete',
          entityType: 'user',
          entityId: req.auth?.userId ?? sessionId,
          after: { event: 'logout' },
        });
      }
      sessions.clearCookie(res, secure);
      res.status(204).end();
    })().catch(() => {
      // Signing out must always appear to work: leaving a cookie behind is the worse failure.
      sessions.clearCookie(res, secure);
      res.status(204).end();
    });
  });

  /** Who am I. The console calls this on load to decide between the app and the login screen. */
  router.get('/session', (req, res) => {
    void (async () => {
      const userId = req.auth?.userId;
      if (userId === undefined || userId === null) {
        // `oidcAvailable` rides on the 401 too, and must: the login screen is the *only* place the
        // D3 Auth button matters, and it is reached by exactly the people this branch answers.
        // Sending it only to signed-in callers meant the button could never appear at all.
        // It leaks nothing — whether a login button should render is not a secret.
        res.status(401).json({
          authenticated: false,
          oidcAvailable: deps.oidcAvailable ?? false,
          // On the 401 as well, for the same reason `oidcAvailable` is: the sign-in screen is the
          // first thing a colleague sees, and it should say which product they are signing in to.
          mode: deps.config.FOREMAN_MODE,
        });
        return;
      }
      const user = await deps.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true, displayName: true, status: true, role: true },
      });
      const credential = await deps.db.credential.findUnique({
        where: { userId: user.id },
        select: { totpConfirmedAt: true },
      });
      res.json({
        authenticated: true,
        user,
        // What this deployment is, and what this person may do in it. The console asks once, at
        // the top, rather than guessing from what the API happens to refuse.
        mode: deps.config.FOREMAN_MODE,
        currency: deps.config.CURRENCY,
        totpEnrolled: credential?.totpConfirmedAt !== undefined && credential.totpConfirmedAt !== null,
        // The console shows the second button only when there is something behind it.
        oidcAvailable: deps.oidcAvailable ?? false,
      });
    })().catch(() => {
      res.status(500).json({ error: 'session lookup failed' });
    });
  });

  router.post('/totp/enrol', requireUser, (req, res) => {
    void (async () => {
      const { secret, uri } = await native.beginTotpEnrolment(deps, req.auth?.userId ?? '');
      // Shown once, and only to the account it belongs to.
      res.json({ secret, uri });
    })().catch(() => {
      res.status(500).json({ error: 'enrolment failed' });
    });
  });

  router.post('/totp/confirm', requireUser, (req, res) => {
    void (async () => {
      const code = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
      if (!code.success) {
        res.status(400).json({ error: 'a code is required' });
        return;
      }
      const ok = await native.confirmTotpEnrolment(deps, req.auth?.userId ?? '', code.data.code);
      if (!ok) {
        res.status(400).json({ error: 'that code did not match' });
        return;
      }
      await record(deps.db, {
        actor: req.auth?.actor ?? 'unknown',
        actorKind: 'user',
        action: 'update',
        entityType: 'user',
        entityId: req.auth?.userId ?? '',
        after: { event: 'totp_enrolled' },
      });
      res.status(204).end();
    })().catch(() => {
      res.status(500).json({ error: 'confirmation failed' });
    });
  });

  return router;
}
