import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { AuthMethod } from '../generated/prisma/enums.js';
import type { Db } from '../db.js';

/**
 * Session cookies (FRM-REQ-024 neighbourhood).
 *
 * The cookie carries a random value; the database stores only its SHA-256. A leaked row is
 * therefore not a usable cookie. Sessions live in a table rather than in a sealed cookie because
 * revocation has to be immediate — signing out, or rotating a key, must end a session now.
 */

/** `__Host-` forbids a Domain attribute and requires Secure and Path=/: it cannot be set by a
 * sibling subdomain, which is the attack a plain name does not prevent. */
export const COOKIE_NAME = '__Host-foreman_session';
/** The name used when the origin is plain HTTP, where `__Host-` is not permitted. */
export const INSECURE_COOKIE_NAME = 'foreman_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Refresh the expiry at most this often, so an active session does not write on every request. */
const SLIDING_REFRESH_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function cookieName(secure: boolean): string {
  return secure ? COOKIE_NAME : INSECURE_COOKIE_NAME;
}

export function cookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    // Lax, not Strict: the OIDC redirect arrives as a cross-site GET, and Strict would drop the
    // cookie on the way back from the issuer. Lax still blocks cross-site POST.
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export interface IssuedSession {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export async function issue(
  db: Db,
  userId: string,
  method: AuthMethod,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      method,
      ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
      ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent } : {}),
      expiresAt,
    },
  });
  return { id: session.id, token, expiresAt };
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly method: AuthMethod;
}

/**
 * Resolve a token to a live session, or null. Expired and revoked both mean null.
 *
 * `via` keeps the two kinds apart: a cookie only ever resolves a browser session and a Bearer token
 * only a native one (FRM-P-14) — so a console cookie lifted into an Authorization header is nothing,
 * and a native access token pasted into a cookie is nothing either. A native session never slides:
 * its access token lives fifteen minutes and renewing it is the refresh token's job.
 */
export async function resolve(db: Db, token: string, via: 'cookie' | 'bearer' = 'cookie'): Promise<ResolvedSession | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { status: true, deletedAt: true } } },
  });
  if (session === null) return null;
  if (session.native !== (via === 'bearer')) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (session.user.deletedAt !== null || session.user.status === 'suspended') return null;

  const sinceSeen = Date.now() - session.lastSeenAt.getTime();
  if (!session.native && sinceSeen > SLIDING_REFRESH_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }

  return { sessionId: session.id, userId: session.userId, method: session.method };
}

export async function revoke(db: Db, sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // Revocation is soft here, so the cascade never fires: a revoked session's push registration
  // is forgotten explicitly, as the contract has it (FRM-T-15.4).
  await db.relayRegistration.deleteMany({ where: { sessionId } });
}

/** Every session for a user — what a password change ends. */
export async function revokeAllForUser(db: Db, userId: string): Promise<number> {
  const { count } = await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await db.relayRegistration.deleteMany({ where: { userId, sessionId: { not: null } } });
  return count;
}

export function readCookie(req: Request, secure: boolean): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  const name = cookieName(secure);
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(cookieName(secure), token, cookieOptions(secure));
}

export function clearCookie(res: Response, secure: boolean): void {
  res.clearCookie(cookieName(secure), { ...cookieOptions(secure), maxAge: undefined });
}

// ── Native sessions (FRM-P-14, the D3 App contract) ──────────────────────────────────────────────

/** The contract's ceiling for an access token: a phone is lost more often than a desk. */
export const NATIVE_ACCESS_MS = 15 * 60 * 1000;
/** A refresh token's window, renewed by every use (the contract's sliding thirty days). */
export const NATIVE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export interface Device {
  readonly name: string;
  readonly platform: string;
}

export interface NativeTokens {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Seconds, as the contract carries it. */
  readonly expiresIn: number;
}

const opaque = (): string => randomBytes(32).toString('base64url');

/** A native session: an ordinary session row, marked and named, with its first refresh token. */
export async function issueNative(
  db: Db,
  userId: string,
  method: AuthMethod,
  meta: { device: Device | null; ip?: string | undefined; userAgent?: string | undefined },
): Promise<NativeTokens> {
  const accessToken = opaque();
  const refreshToken = opaque();
  const now = Date.now();
  return db.$transaction(async (tx) => {
    const row = await tx.session.create({
      data: {
        userId,
        tokenHash: hashToken(accessToken),
        method,
        native: true,
        deviceName: meta.device?.name.slice(0, 120) ?? null,
        devicePlatform: meta.device?.platform.slice(0, 40) ?? null,
        ...(meta.ip !== undefined ? { ip: meta.ip } : {}),
        ...(meta.userAgent !== undefined ? { userAgent: meta.userAgent.slice(0, 512) } : {}),
        expiresAt: new Date(now + NATIVE_ACCESS_MS),
      },
    });
    await tx.nativeRefresh.create({
      data: { sessionId: row.id, tokenHash: hashToken(refreshToken), createdAt: new Date(now), expiresAt: new Date(now + NATIVE_REFRESH_MS) },
    });
    return { sessionId: row.id, accessToken, refreshToken, expiresIn: NATIVE_ACCESS_MS / 1000 };
  });
}

export type Rotation =
  | { readonly kind: 'rotated'; readonly tokens: NativeTokens; readonly userId: string }
  | { readonly kind: 'reused'; readonly sessionId: string; readonly userId: string }
  | { readonly kind: 'ended' };

/**
 * Exchange a refresh token for a new pair. The presented row is claimed with a conditional update,
 * so two refreshes racing with one token cannot both succeed: the loser sees it replaced, which is
 * reuse, and the session ends — exactly what a stolen token racing its owner should cause.
 */
export async function rotateNative(db: Db, refreshToken: string): Promise<Rotation> {
  const now = new Date();
  const presented = await db.nativeRefresh.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { session: { select: { id: true, userId: true, revokedAt: true, user: { select: { status: true, deletedAt: true } } } } },
  });
  if (
    presented === null ||
    presented.expiresAt.getTime() <= now.getTime() ||
    presented.session.revokedAt !== null ||
    presented.session.user.deletedAt !== null ||
    presented.session.user.status === 'suspended'
  ) {
    return { kind: 'ended' };
  }
  const { id: sessionId, userId } = presented.session;
  if (presented.replacedAt !== null) return { kind: 'reused', sessionId, userId };
  return db.$transaction(async (tx) => {
    const { count } = await tx.nativeRefresh.updateMany({ where: { id: presented.id, replacedAt: null }, data: { replacedAt: now } });
    if (count !== 1) return { kind: 'reused', sessionId, userId } as const;
    const accessToken = opaque();
    const next = opaque();
    await tx.session.update({
      where: { id: sessionId },
      data: { tokenHash: hashToken(accessToken), expiresAt: new Date(now.getTime() + NATIVE_ACCESS_MS), lastSeenAt: now },
    });
    await tx.nativeRefresh.create({
      data: { sessionId, tokenHash: hashToken(next), createdAt: now, expiresAt: new Date(now.getTime() + NATIVE_REFRESH_MS) },
    });
    return { kind: 'rotated', userId, tokens: { sessionId, accessToken, refreshToken: next, expiresIn: NATIVE_ACCESS_MS / 1000 } } as const;
  });
}

/**
 * Sessions still signed in, for the sessions list. A native row expires with its fifteen-minute
 * access token while the device stays signed in for as long as its refresh token is live — so an
 * idle phone stays listed, and so stays revocable.
 */
export function liveSessionWhere(userId: string, now: Date = new Date()) {
  return {
    userId,
    revokedAt: null,
    OR: [
      { native: false, expiresAt: { gt: now } },
      { native: true, refreshes: { some: { replacedAt: null, expiresAt: { gt: now } } } },
    ],
  };
}
