import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';
import * as sessions from './sessions.js';
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

export async function login({ db, config }: AuthDeps, input: LoginInput): Promise<LoginOutcome> {
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

  const totpEnrolled =
    user.credential.totpConfirmedAt !== null && user.credential.totpSecret !== null;

  if (totpEnrolled) {
    if (input.totpCode === undefined || input.totpCode.length === 0) {
      return { kind: 'totp_required', userId: user.id };
    }
    const secret = decryptSecret(user.credential.totpSecret ?? '', config.KEK);
    const result = verifyCode(
      secret,
      input.totpCode,
      email,
      user.credential.totpLastStep === null ? null : Number(user.credential.totpLastStep),
    );
    if (!result.valid) {
      await throttle.recordFailure(db, keys);
      return { kind: 'rejected', reason: 'credentials' };
    }
    // Burn the step so the same code cannot be replayed inside its window.
    await db.credential.update({
      where: { userId: user.id },
      data: { totpLastStep: BigInt(result.step ?? 0) },
    });
  }

  await throttle.clear(db, keys);
  const session = await sessions.issue(db, user.id, 'password', {
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { kind: 'session', token: session.token, userId: user.id };
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
