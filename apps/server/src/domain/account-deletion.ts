import type { Db } from '../db.js';
import { record } from './audit.js';

/**
 * Deleting your own account (FRM-T-15.3, FRM-ADR-022).
 *
 * **The person goes; what they wrote stays, and stays attributed.** A board's record of why it
 * funded something is not allowed to develop a hole because somebody left — the same reason
 * `suspend` exists instead of a delete. So the purge removes everything that is *them* — the
 * credential, linked identities, sessions, the invite, push registrations, the email address — and
 * keeps the row, with its display name, for the submissions, scores and comments that point at it.
 * Audit events keep the actor they were written with: history is not rewritten.
 *
 * In between is a grace period. The account is suspended at once (every sign-in path already
 * refuses a suspended account), every session and API token it made ends, and an admin can undo
 * the whole thing from the members screen until the purge runs.
 */

/** At least the contract's day; a week, so a person who regrets it on Monday can still be helped. */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type DeletionRequest =
  | { readonly kind: 'scheduled'; readonly graceUntil: Date }
  | { readonly kind: 'last_owner' }
  | { readonly kind: 'gone' };

/**
 * Schedule a deletion. The caller has already proven the person with a current code; this decides
 * whether the instance can lose them, and ends everything they were signed in with.
 */
export async function requestDeletion(db: Db, userId: string, now = new Date()): Promise<DeletionRequest> {
  return db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, deletedAt: null, status: 'active' } });
    if (user === null) return { kind: 'gone' } as const;

    // An instance with no admin has no way to appoint one: the same rule as demoting the last.
    if (user.role === 'admin') {
      const others = await tx.user.count({
        where: { role: 'admin', status: 'active', deletedAt: null, id: { not: userId } },
      });
      if (others === 0) return { kind: 'last_owner' } as const;
    }

    const graceUntil = new Date(now.getTime() + DELETION_GRACE_MS);
    await tx.user.update({ where: { id: userId }, data: { status: 'suspended', deleteAfter: graceUntil } });
    // Soft revocation, as everywhere else, so the sessions screen still shows what was ended.
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
    await tx.relayRegistration.deleteMany({ where: { userId } });
    const tokens = await tx.apiToken.updateMany({
      where: { createdBy: user.email, revokedAt: null },
      data: { revokedAt: now },
    });
    await record(tx, {
      actor: user.email,
      actorKind: 'user',
      action: 'update',
      entityType: 'user',
      entityId: user.id,
      entityHumanId: user.email,
      before: { status: user.status },
      after: { status: 'suspended', event: 'deletion_requested', deleteAfter: graceUntil.toISOString(), apiTokensRevoked: tokens.count },
    });
    return { kind: 'scheduled', graceUntil } as const;
  });
}

/** The tombstone an address becomes, so the real one can be invited again. */
export const tombstoneEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

/**
 * Purge every account whose grace period has passed. Run nightly by the worker; `now` is the
 * test clock. Each account is its own transaction, so one bad row cannot hold up the rest.
 */
export async function purgeDeletedAccounts(db: Db, now = new Date()): Promise<{ purged: number }> {
  const due = await db.user.findMany({
    where: { deleteAfter: { lte: now }, deletedAt: null, status: 'suspended' },
    select: { id: true, email: true },
  });

  for (const user of due) {
    await db.$transaction(async (tx) => {
      await tx.credential.deleteMany({ where: { userId: user.id } });
      await tx.identity.deleteMany({ where: { userId: user.id } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.invite.deleteMany({ where: { userId: user.id } });
      await tx.relayRegistration.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: { email: tombstoneEmail(user.id), deletedAt: now, deleteAfter: null },
      });
      await record(tx, {
        actor: 'account-deletion',
        actorKind: 'system',
        action: 'delete',
        entityType: 'user',
        entityId: user.id,
        // The address is the thing being removed, so it is not written into the trail that keeps
        // the purge: the request event before it already names who asked.
        entityHumanId: tombstoneEmail(user.id),
        after: { event: 'account_purged' },
      });
    });
  }
  return { purged: due.length };
}
