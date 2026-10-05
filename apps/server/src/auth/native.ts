import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import * as sessions from './sessions.js';
import { record } from '../domain/audit.js';
import * as throttle from './throttle.js';
import { decryptSecret, encryptSecret, generateSecret, provisioningUri, verifyCode } from './totp.js';

/**
 * The app-native login path (FRM-REQ-018, FRM-REQ-023, FRM-REQ-024).
 *
 * This is the path that must keep working when `auth.d3cloud.io` is unreachable, which is why it
 * is built first and why nothing in this file imports anything OIDC.
 *
 * The order is deliberate: **throttle, then hash**. Deciding the delay after a failed comparison
 * would mean every rejected guess had already cost 64MB of Argon2id.
 */

export type LoginOutcome =
  | { readonly kind: 'session'; readonly token: string; readonly userId: string }
  | { readonly kind: 'totp_required'; readonly userId: string }
  | { readonly kind: 'rejected'; readonly reason: 'credentials' }
  | { readonly kind: 'throttled'; readonly retryAfterMs: number; readonly scope?: throttle.Scope };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** Present on the second leg, once TOTP is enrolled. */
  readonly totpCode?: string | undefined;
  readonly ip: string;
  readonly userAgent?: string | undefined;
}

export interface AuthDeps {
  readonly db: Db;
  readonly config: Config;
}

/**
 * A dummy hash, verified when no account matches, so a missing account and a wrong password take
 * the same time. Generated once per process from a value nobody knows.
 */
let decoyHash: Promise<string> | null = null;
function decoy(pepper: string): Promise<string> {
  decoyHash ??= hashPassword(`decoy:${String(Math.random())}`, pepper);
  return decoyHash;
}

export type PasswordStep =
  | { readonly kind: 'ok'; readonly userId: string; readonly email: string; readonly totpEnrolled: boolean }
  | { readonly kind: 'rejected'; readonly reason: 'credentials' }
  | { readonly kind: 'throttled'; readonly retryAfterMs: number; readonly scope?: throttle.Scope };

/**
 * The password leg, shared by the console's login and the native sign-in (FRM-P-14), so both get the
 * same throttle-before-hash, the same decoy and the same rehash — there is one way to check a
 * password here, not two.
 */
export async function passwordStep(
  { db, config }: AuthDeps,
  input: { email: string; password: string; ip: string },
): Promise<PasswordStep> {
  const email = input.email.trim().toLowerCase();
  const keys = { account: email, ip: input.ip };

  // Before any hashing. This is the whole point of the ordering.
  const decision = await throttle.check(db, keys);
  if (!decision.allowed) {
    return {
      kind: 'throttled',
      retryAfterMs: decision.retryAfterMs,
      ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
    };
  }

  const user = await db.user.findFirst({
    where: { email, deletedAt: null },
    include: { credential: true },
  });

  if (user === null || user.credential === null || user.status === 'suspended') {
    // Spend the same time as a real verification, so the response cannot be used to enumerate.
    await verifyPassword(await decoy(config.PEPPER), input.password, config.PEPPER);
    await throttle.recordFailure(db, keys);
    return { kind: 'rejected', reason: 'credentials' };
  }

  const ok = await verifyPassword(user.credential.passwordHash, input.password, config.PEPPER);
  if (!ok) {
    await throttle.recordFailure(db, keys);
    return { kind: 'rejected', reason: 'credentials' };
  }

  // Parameters strengthen over time; a correct password is the only chance to re-hash it.
  if (needsRehash(user.credential.passwordHash)) {
    const rehashed = await hashPassword(input.password, config.PEPPER);
    await db.credential.update({
      where: { userId: user.id },
      data: { passwordHash: rehashed },
    });
  }

  const totpEnrolled = user.credential.totpConfirmedAt !== null && user.credential.totpSecret !== null;
  return { kind: 'ok', userId: user.id, email, totpEnrolled };
}

/**
 * The code leg: right, unused, and then burned so it cannot be replayed inside its window. A wrong
 * one counts against the same throttle as a wrong password.
 */
export async function codeStep(
  { db, config }: AuthDeps,
  input: { userId: string; email: string; code: string; ip: string },
): Promise<boolean> {
  const keys = { account: input.email, ip: input.ip };
  const credential = await db.credential.findUnique({ where: { userId: input.userId } });
  if (credential === null || credential.totpSecret === null) return false;
  const secret = decryptSecret(credential.totpSecret, config.KEK);
  const result = verifyCode(
    secret,
    input.code,
    input.email,
    credential.totpLastStep === null ? null : Number(credential.totpLastStep),
  );
  if (!result.valid) {
    await throttle.recordFailure(db, keys);
    return false;
  }
  await db.credential.update({
    where: { userId: input.userId },
    data: { totpLastStep: BigInt(result.step ?? 0) },
  });
  return true;
}

export async function login(deps: AuthDeps, input: LoginInput): Promise<LoginOutcome> {
  const first = await passwordStep(deps, input);
  if (first.kind !== 'ok') return first;

  if (first.totpEnrolled) {
    if (input.totpCode === undefined || input.totpCode.length === 0) {
      return { kind: 'totp_required', userId: first.userId };
    }
    if (!(await codeStep(deps, { userId: first.userId, email: first.email, code: input.totpCode, ip: input.ip }))) {
      return { kind: 'rejected', reason: 'credentials' };
    }
  }

  await throttle.clear(deps.db, { account: first.email, ip: input.ip });
  const session = await sessions.issue(deps.db, first.userId, 'password', {
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { kind: 'session', token: session.token, userId: first.userId };
}

/** Begin TOTP enrolment: a secret, stored encrypted but unconfirmed until a code proves it works. */
export async function beginTotpEnrolment(
  { db, config }: AuthDeps,
  userId: string,
): Promise<{ secret: string; uri: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const secret = generateSecret();
  await db.credential.update({
    where: { userId },
    data: { totpSecret: encryptSecret(secret, config.KEK), totpConfirmedAt: null },
  });
  return { secret, uri: provisioningUri(secret, user.email) };
}

/** Confirm enrolment. Until this succeeds, TOTP is not in force and cannot lock anyone out. */
export async function confirmTotpEnrolment(
  { db, config }: AuthDeps,
  userId: string,
  code: string,
): Promise<boolean> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    include: { credential: true },
  });
  const secret = user.credential?.totpSecret;
  if (secret === undefined || secret === null) return false;

  const result = verifyCode(decryptSecret(secret, config.KEK), code, user.email, null);
  if (!result.valid) return false;

  await db.credential.update({
    where: { userId },
    data: { totpConfirmedAt: new Date(), totpLastStep: BigInt(result.step ?? 0) },
  });
  return true;
}

/** Set or change a password. Every existing session ends: a change is also a revocation. */
export async function setPassword(
  { db, config }: AuthDeps,
  userId: string,
  password: string,
): Promise<void> {
  const passwordHash = await hashPassword(password, config.PEPPER);
  await db.credential.upsert({
    where: { userId },
    create: { userId, passwordHash },
    update: { passwordHash, passwordUpdatedAt: new Date() },
  });
  await sessions.revokeAllForUser(db, userId);
}

export type LinkOutcome = { readonly kind: 'linked' } | { readonly kind: 'elsewhere' };

/**
 * Link a D3 Auth identity to the account that just proved itself with its own password and code
 * (FRM-T-14.2) — by `(iss, sub)`, never by email, and once: an identity linked to someone else is
 * refused. The link and its audit event are written together.
 */
export async function linkIdentity(
  { db }: AuthDeps,
  input: { userId: string; email: string; iss: string; sub: string },
): Promise<LinkOutcome> {
  return db.$transaction(async (tx) => {
    const existing = await tx.identity.findUnique({ where: { iss_sub: { iss: input.iss, sub: input.sub } } });
    if (existing !== null && existing.userId !== input.userId) return { kind: 'elsewhere' } as const;
    if (existing === null) {
      await tx.identity.create({ data: { userId: input.userId, iss: input.iss, sub: input.sub, lastLoginAt: new Date() } });
    }
    await record(tx, {
      actor: input.email,
      actorKind: 'user',
      action: 'create',
      entityType: 'user',
      entityId: input.userId,
      after: { event: 'identity_linked', iss: input.iss, sub: input.sub, via: 'native', already: existing !== null },
    });
    return { kind: 'linked' } as const;
  });
}
