import { Router } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { record } from '../domain/audit.js';
import { logger } from '../logger.js';
import { isSecureOrigin } from '../auth/middleware.js';
import {
  issueSessionFor,
  OidcError,
  resolveIdentity,
  TX_COOKIE,
  type OidcClient,
} from '../auth/oidc.js';
import * as sessions from '../auth/sessions.js';

/**
 * The OIDC routes, mounted **beside** the password routes and never in front of them.
 *
 * If `client` is null — not configured, or the issuer was unreachable at boot — these routes still
 * exist and answer 503. They never break the password path, which is the point of ADR-004.
 */

export interface OidcRouteDeps {
  readonly db: Db;
  readonly config: Config;
  readonly client: OidcClient | null;
}

export function oidcRoutes({ db, config, client }: OidcRouteDeps): Router {
  const router = Router();
  const secure = isSecureOrigin(config);

  // The transaction cookie is scoped to the callback path and lasts minutes, not weeks. Lax is
  // required: the provider's redirect back is a top-level cross-site GET, which Strict would drop.
  const txCookie = (value: string, maxAgeSeconds: number) =>
    [
      `${TX_COOKIE}=${value}`,
      'Path=/auth/oidc/callback',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${String(maxAgeSeconds)}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');

  router.get('/start', (req, res) => {
    void (async () => {
      if (client === null) {
        res.status(503).json({ error: 'sign-in with D3 Auth is not available' });
        return;
      }
      // Linking attaches the identity to whoever is signed in here already — never to an account
      // matched by email afterwards.
      const linkTo = req.query['link'] === '1' ? req.auth?.userId : undefined;
      const { url, tx } = await client.beginSignIn(linkTo ?? undefined);
      res.setHeader('Set-Cookie', txCookie(tx, 600));
      res.redirect(url);
    })().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not start a D3 Auth sign-in',
      );
      res.status(502).json({ error: 'could not reach the sign-in provider' });
    });
  });

  router.get('/callback', (req, res) => {
    void (async () => {
      res.append('Set-Cookie', txCookie('', 0));
      if (client === null) {
        res.status(503).json({ error: 'sign-in with D3 Auth is not available' });
        return;
      }

      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      const tx = readTxCookie(req.headers.cookie);
      if (tx === null) {
        res.status(400).json({ error: 'no sign-in is in progress for this browser' });
        return;
      }

      try {
        const completed = await client.completeSignIn(
          new URL(req.originalUrl, config.BASE_URL),
          tx,
          state,
        );
        const { userId, created } = await resolveIdentity(db, completed);
        const token = await issueSessionFor(db, userId, {
          ip: req.ip,
          userAgent: req.get('user-agent'),
          sub: completed.sub,
        });
        sessions.setCookie(res, token, secure);

        await record(db, {
          actor: completed.email ?? completed.sub,
          actorKind: 'user',
          action: created ? 'create' : 'update',
          entityType: 'user',
          entityId: userId,
          after: { event: 'login', method: 'oidc', iss: completed.iss, provisioned: created },
        });
        logger.info({ userId, method: 'oidc', created }, 'login');
        res.redirect('/');
      } catch (error) {
        if (error instanceof OidcError) {
          // Audited, because a mismatched issuer or state is worth seeing in the trail.
          logger.warn({ err: error.message }, 'D3 Auth sign-in refused');
          // Back to the login screen with the reason, not a page of JSON: this arrives in a
          // browser, after a redirect the person did not type, and "that sign-in could not be
          // completed" told them nothing about what to do next.
          res.redirect(`/?signin_error=${encodeURIComponent(error.message)}`);
          return;
        }
        throw error;
      }
    })().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'D3 Auth callback failed',
      );
      // 500, and no claim about whose fault it was. This returned 502 "the sign-in provider did
      // not answer" for *any* failure, so a unique-constraint violation in Foreman's own database
      // rendered as a Cloudflare bad-gateway page and read as a tunnel or provider outage.
      res.status(500).json({ error: 'the sign-in could not be completed' });
    });
  });

  /** RP-initiated logout: end the local session, then hand off to the provider to end theirs. */
  router.post('/logout', (req, res) => {
    void (async () => {
      const sessionId = req.auth?.sessionId;
      let redirectTo: string | null = null;

      if (sessionId !== undefined) {
        const session = await db.session.findUnique({ where: { id: sessionId } });
        await sessions.revoke(db, sessionId);
        if (session?.method === 'oidc' && client !== null) {
          // RP-initiated logout is best-effort: the local session has already ended, and a
          // provider that will not build a URL must not turn signing out into a failure.
          redirectTo = await client.endSessionUrl('', config.BASE_URL);
        }
        await record(db, {
          actor: req.auth?.actor ?? 'unknown',
          actorKind: 'user',
          action: 'delete',
          entityType: 'user',
          entityId: req.auth?.userId ?? sessionId,
          after: { event: 'logout', method: 'oidc' },
        });
      }

      sessions.clearCookie(res, secure);
      res.json({ redirectTo });
    })().catch(() => {
      sessions.clearCookie(res, secure);
      res.json({ redirectTo: null });
    });
  });

  return router;
}

function readTxCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === TX_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
