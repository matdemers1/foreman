import { randomBytes } from 'node:crypto';
import type { UserRole } from '@foreman/shared';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { hashToken } from '../auth/sessions.js';
import { setPassword } from '../auth/native.js';
import { record, type Actor } from './audit.js';
import { Conflict, Invalid, NotFound } from './errors.js';

/**
 * Members of a board deployment, and the invitations that create them (FRM-ADR-016).
 *
 * Foreman was built for one operator, and the shape of that shows here: there was no route that
 * created an account at all, because the only account was seeded at boot from `OPERATOR_EMAIL`.
 * A fund board needs colleagues, so it needs a way in for them.
 *
 * **The invitation is a credential, and is treated as one.** Its token is random, stored only as a
 * SHA-256, single-use and time-boxed — the same rules as an API token and a session cookie, for
 * the same reason: a leaked database row must not be a way in. It is shown once, at the moment it
 * is created, and never again.
 */

const SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
  createdAt: true,
  invite: { select: { expiresAt: true, acceptedAt: true } },
} as const;

export async function listMembers(db: Db) {
  return db.user.findMany({
    where: { deletedAt: null },
    // Most privileged first, then alphabetical: the question a members screen answers is "who can
    // decide things", and that is the top of the list rather than buried in it.
    orderBy: [{ role: 'asc' }, { displayName: 'asc' }],
    select: SELECT,
  });
}

export interface IssuedInvite {
  readonly user: Awaited<ReturnType<typeof listMembers>>[number];
  /** Shown once. Never stored, never logged, never in an audit event. */
  readonly token: string;
  readonly acceptUrl: string;
  readonly expiresAt: Date;
}

export async function invite(
  db: Db,
  config: Pick<Config, 'BASE_URL' | 'INVITE_TTL_HOURS'>,
  actor: Actor & { userId?: string | null | undefined },
  input: { email: string; displayName: string; role: UserRole },
): Promise<IssuedInvite> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email }, select: { status: true } });
  // Re-inviting somebody who already accepted is almost always a mistake about who is on the
  // board, and answering it with a fresh token would quietly reset their access.
  if (existing !== null && existing.status === 'active') {
    throw new Conflict(`${email} already has an account`);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.INVITE_TTL_HOURS * 60 * 60 * 1000);

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.upsert({
      where: { email },
      // An unaccepted invite can be re-issued: the name or the role may have been wrong, and the
      // old token stops working because the row it hashes to is replaced.
      update: { displayName: input.displayName, role: input.role, status: 'invited' },
      create: { email, displayName: input.displayName, role: input.role, status: 'invited' },
      select: SELECT,
    });

    await tx.invite.upsert({
      where: { userId: created.id },
      update: {
        tokenHash: hashToken(token),
        expiresAt,
        acceptedAt: null,
        ...(actor.userId === null || actor.userId === undefined
          ? {}
          : { invitedById: actor.userId }),
      },
      create: {
        userId: created.id,
        tokenHash: hashToken(token),
        expiresAt,
        ...(actor.userId === null || actor.userId === undefined
          ? {}
          : { invitedById: actor.userId }),
      },
    });

    await record(tx, {
      ...actor,
      action: 'create',
      entityType: 'user',
      entityId: created.id,
      entityHumanId: email,
      // The token is absent on purpose. An audit trail that carries a live credential is a
      // second copy of it, in the one place designed to be kept forever.
      after: { email, displayName: input.displayName, role: input.role, status: 'invited' },
    });
    return created;
  });

  return {
    user,
    token,
    acceptUrl: `${config.BASE_URL}/accept?token=${token}`,
    expiresAt,
  };
}

/**
 * Spend an invitation: set a password, and the account becomes usable.
 *
 * Deliberately does **not** sign the person in. Accepting proves they hold the token from their
 * email; signing in proves they know the password they just chose. Collapsing the two would mean
 * a forwarded invitation link grants a session.
 */
export async function acceptInvite(
  db: Db,
  config: Config,
  input: { token: string; password: string },
): Promise<{ email: string }> {
  const invitation = await db.invite.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { user: { select: { id: true, email: true, status: true } } },
  });

  // One answer for every failure: wrong token, spent token, lapsed token, deleted account. Telling
  // them apart tells an attacker which of their guesses was a real invitation.
  if (
    invitation === null ||
    invitation.acceptedAt !== null ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    throw new NotFound('that invitation is not usable — ask for a new one');
  }

  await setPassword({ db, config }, invitation.user.id, input.password);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: invitation.user.id }, data: { status: 'active' } });
    await tx.invite.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    await record(tx, {
      actor: invitation.user.email,
      actorKind: 'user',
      action: 'update',
      entityType: 'user',
      entityId: invitation.user.id,
      entityHumanId: invitation.user.email,
      before: { status: invitation.user.status },
      after: { status: 'active' },
    });
  });

  return { email: invitation.user.email };
}

export async function setRole(db: Db, actor: Actor, userId: string, role: UserRole) {
  const before = await db.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (before === null) throw new NotFound(userId);

  // The last admin may not demote themselves. An instance with no admin has no way to appoint
  // one, and the fix is a database console — which is exactly the situation a board deployment
  // cannot get into on a Friday afternoon.
  if (before.role === 'admin' && role !== 'admin') {
    const admins = await db.user.count({ where: { role: 'admin', deletedAt: null } });
    if (admins <= 1) {
      throw new Invalid('this is the only admin — appoint another one first', [
        { path: 'role', message: 'an instance with no admin cannot appoint one' },
      ]);
    }
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { role }, select: SELECT });
    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'user',
      entityId: userId,
      entityHumanId: before.email,
      before: { role: before.role },
      after: { role },
    });
    return user;
  });
}

/**
 * Suspend an account rather than deleting it.
 *
 * Their submissions, scores and comments stay, and stay attributed. Somebody leaving is not a
 * reason for the board's record of why it funded something to develop a hole in it.
 */
export async function suspend(db: Db, actor: Actor, userId: string, suspended: boolean) {
  const before = await db.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (before === null) throw new NotFound(userId);

  if (before.role === 'admin' && suspended) {
    const admins = await db.user.count({
      where: { role: 'admin', status: 'active', deletedAt: null },
    });
    if (admins <= 1) {
      throw new Invalid('this is the only active admin', [
        { path: 'status', message: 'appoint another admin first' },
      ]);
    }
  }

  return db.$transaction(async (tx) => {
    const status = suspended ? 'suspended' : 'active';
    const user = await tx.user.update({ where: { id: userId }, data: { status }, select: SELECT });
    // Their sessions go with it, or a suspended account stays signed in until its cookie lapses.
    if (suspended) await tx.session.deleteMany({ where: { userId } });
    await record(tx, {
      ...actor,
      action: 'update',
      entityType: 'user',
      entityId: userId,
      entityHumanId: before.email,
      before: { status: before.status },
      after: { status },
    });
    return user;
  });
}
