import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { ActorKind } from '../generated/prisma/enums.js';
import { safeEqual } from './passwords.js';
import { hashToken } from './sessions.js';
import * as sessions from './sessions.js';

/**
 * Two ways in, one identity out (API Contract): a session cookie for the console, a bearer token
 * for the MCP shim. Everything downstream reads `req.auth` and does not care which it was.
 */

export interface AuthContext {
  readonly userId: string | null;
  readonly actor: string;
  readonly actorKind: ActorKind;
  readonly sessionId?: string;
  readonly tokenId?: string;
  readonly scopes: readonly string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface AuthMiddlewareDeps {
  readonly db: Db;
  readonly config: Config;
}

/** True when cookies must carry the `Secure` attribute — that is, everywhere but local HTTP. */
export function isSecureOrigin(config: Config): boolean {
  return config.BASE_URL.startsWith('https://');
}

/**
 * Attach an auth context when one is presented. Never rejects: route guards decide what an
 * unauthenticated request means, so a public endpoint stays public.
 */
export function attachAuth({ db, config }: AuthMiddlewareDeps) {
  const secure = isSecureOrigin(config);

  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      const header = req.headers.authorization;
      if (header !== undefined && header.startsWith('Bearer ')) {
        const presented = header.slice('Bearer '.length).trim();
        const token = await db.apiToken.findUnique({ where: { tokenHash: hashToken(presented) } });
        if (
          token !== null &&
          token.revokedAt === null &&
          (token.expiresAt === null || token.expiresAt.getTime() > Date.now()) &&
          // The lookup was by hash, so this is belt and braces against a hash collision claim.
          safeEqual(hashToken(presented), token.tokenHash)
        ) {
          // Last-used is advisory; a failed write must not fail the request.
          void db.apiToken
            .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);
          req.auth = {
            userId: null,
            actor: token.name,
            actorKind: 'mcp',
            tokenId: token.id,
            scopes: token.scopes,
          };
        }
        next();
        return;
      }

      const cookie = sessions.readCookie(req, secure);
      if (cookie !== null) {
        const session = await sessions.resolve(db, cookie);
        if (session !== null) {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { email: true },
          });
          req.auth = {
            userId: session.userId,
            actor: user?.email ?? session.userId,
            actorKind: 'user',
            sessionId: session.sessionId,
            scopes: ['*'],
          };
        }
      }
      next();
    })().catch(next);
  };
}

/** Guard: a request without an identity gets 401 and nothing else. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.auth === undefined) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

/**
 * The scopes a token may hold. `read` answers questions; `write` changes state; `admin` manages
 * tokens and accounts. A session always holds all three — the operator signing in is the owner —
 * and a token holds only what it was issued with (FRM-REQ-025, FRM-REQ-026, FRM-REQ-027).
 */
export const SCOPES = ['read', 'write', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export function hasScope(auth: AuthContext | undefined, scope: Scope): boolean {
  if (auth === undefined) return false;
  // A signed-in user is the operator. Tokens are the things that are scoped.
  if (auth.scopes.includes('*')) return true;
  return auth.scopes.includes(scope);
}

/**
 * Guard a route by scope. **A denial is audited**, because a read-only token being used on a write
 * route is either a misconfiguration worth finding or an attempt worth seeing — and either way,
 * silence is the wrong answer.
 */
export function requireScope(db: Db, scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasScope(req.auth, scope)) {
      next();
      return;
    }

    const auth = req.auth;
    void db.auditEvent
      .create({
        data: {
          actor: auth?.actor ?? 'anonymous',
          actorKind: auth?.actorKind ?? 'system',
          action: 'update',
          entityType: 'api_token',
          entityId: auth?.tokenId ?? '00000000-0000-7000-8000-000000000000',
          after: {
            event: 'scope_denied',
            required: scope,
            held: auth?.scopes ?? [],
            method: req.method,
            path: req.path,
          },
        },
      })
      // The denial itself must still happen even if recording it fails.
      .catch(() => undefined);

    res.status(403).json({ error: `this token may not ${scope}` });
  };
}

/** Guard: console-only routes. A scoped MCP token may not manage accounts. */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (req.auth === undefined || req.auth.userId === null) {
    res.status(401).json({ error: 'a signed-in user is required' });
    return;
  }
  next();
}
