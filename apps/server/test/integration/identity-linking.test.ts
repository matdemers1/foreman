import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OidcError, resolveIdentity, type CompletedSignIn } from '../../src/auth/oidc.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * Identities link by `(iss, sub)`, never by email (ADR-004).
 *
 * The rule exists to stop an account being adopted because a claim happened to carry a matching
 * address. But "never by email" leaves a case the code has to answer rather than trip over: a
 * local account already holds the address the provider asserts.
 *
 * In production it tripped over it. The first D3 Auth sign-in after the deploy hit the operator
 * account seeded under the same address, Prisma raised a unique-constraint violation on
 * `user_email_key`, and the route's catch-all turned that into a 502 that Cloudflare rendered as a
 * bad-gateway page — so a database conflict inside Foreman looked exactly like a tunnel outage.
 */

const url = process.env['DATABASE_URL'];

const ISS = 'https://auth.example.test';
const EMAIL = 'linking@example.com';

const signIn = (over: Partial<CompletedSignIn> = {}): CompletedSignIn =>
  ({
    iss: ISS,
    sub: 'sub-1',
    email: EMAIL,
    name: 'Linking Test',
    roles: [],
    ...over,
  }) as CompletedSignIn;

describe.skipIf(url === undefined)('identity linking', () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url ?? '');
  });

  beforeEach(async () => {
    await db.identity.deleteMany({ where: { iss: ISS } });
    await db.user.deleteMany({ where: { email: EMAIL } });
  });

  afterAll(async () => {
    await db.identity.deleteMany({ where: { iss: ISS } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.$disconnect();
  });

  it('provisions a user when nothing holds the address', async () => {
    const { userId, created } = await resolveIdentity(db, signIn());

    expect(created).toBe(true);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe(EMAIL);
  });

  it('returns the same user the second time, matched on (iss, sub)', async () => {
    const first = await resolveIdentity(db, signIn());
    const second = await resolveIdentity(db, signIn({ email: 'renamed@example.com' }));

    // Matched on the subject, so a changed email still lands on the same account — which is the
    // other half of not matching by email.
    expect(second.userId).toBe(first.userId);
    expect(second.created).toBe(false);
  });

  it('refuses when an account already holds the address, instead of failing on the constraint', async () => {
    await db.user.create({ data: { email: EMAIL, displayName: 'Already here', status: 'active' } });

    await expect(resolveIdentity(db, signIn())).rejects.toBeInstanceOf(OidcError);
  });

  it('says how to link deliberately, because the person has to do something next', async () => {
    await db.user.create({ data: { email: EMAIL, displayName: 'Already here', status: 'active' } });

    // The message is the whole remedy here: it arrives in a browser after a redirect nobody typed.
    await expect(resolveIdentity(db, signIn())).rejects.toThrow(/sign in with your password/i);
    await expect(resolveIdentity(db, signIn())).rejects.toThrow(/link/i);
  });

  it('writes nothing when it refuses', async () => {
    const existing = await db.user.create({
      data: { email: EMAIL, displayName: 'Already here', status: 'active' },
    });

    await expect(resolveIdentity(db, signIn())).rejects.toBeInstanceOf(OidcError);

    // A refusal that half-provisioned would be worse than the crash it replaced.
    expect(await db.user.count({ where: { email: EMAIL } })).toBe(1);
    expect(await db.identity.count({ where: { iss: ISS } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: existing.id } })).displayName).toBe(
      'Already here',
    );
  });

  it('links to the signed-in account when asked to, and makes no second user', async () => {
    const existing = await db.user.create({
      data: { email: EMAIL, displayName: 'Already here', status: 'active' },
    });

    // The sanctioned path: prove control of the password account first, then attach the identity.
    const { userId, created } = await resolveIdentity(
      db,
      signIn({ linkToUserId: existing.id }),
    );

    expect(userId).toBe(existing.id);
    expect(created).toBe(false);
    expect(await db.user.count({ where: { email: EMAIL } })).toBe(1);

    // And the link is real: the next sign-in resolves on (iss, sub) with no linking hint at all.
    const again = await resolveIdentity(db, signIn());
    expect(again.userId).toBe(existing.id);
    expect(again.created).toBe(false);
  });
});
