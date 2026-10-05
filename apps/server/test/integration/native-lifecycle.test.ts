import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { encryptSecret, generateSecret } from '../../src/auth/totp.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';
import { DELETION_GRACE_MS, purgeDeletedAccounts, tombstoneEmail } from '../../src/domain/account-deletion.js';
import { invite } from '../../src/domain/members.js';

/**
 * The D3 App contract's account lifecycle on a board deployment (FRM-T-15.2, FRM-T-15.3,
 * FRM-ADR-022): an invitation accepted from the app — account, authenticator, native session — and
 * an account deleted from it, through the grace period to the purge on a test clock, keeping what
 * the person wrote attributed. A solo Foreman offers neither, and says so in its manifest.
 */

const url = process.env['DATABASE_URL'];
const PROBLEM = 'https://d3cloud.io/problems/';
const KEK = Buffer.alloc(32, 1).toString('base64');
const PASSWORD = 'a-password-for-the-lifecycle-tests';
const DEVICE = { name: "Matt's iPhone", platform: 'ios' };

const codeFor = (secret: string, offsetMs = 0) =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offsetMs });

describe.skipIf(url === undefined)('the account lifecycle from the app (FRM-T-15.2, FRM-T-15.3)', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let solo: Server;
  let origin: string;
  let soloOrigin: string;
  const made: string[] = [];

  const call = (path: string, init: { bearer?: string; body?: unknown; base?: string } = {}) =>
    fetch(`${init.base ?? origin}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        ...(init.bearer === undefined ? {} : { authorization: `Bearer ${init.bearer}` }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const problemType = async (res: Response) => ((await res.json()) as { type: string }).type;

  async function person(role: 'admin' | 'reviewer' | 'submitter'): Promise<{ id: string; email: string; secret: string }> {
    const email = `lifecycle-${randomUUID()}@example.com`;
    const user = await db.user.create({ data: { email, displayName: 'Lifecycle', status: 'active', role } });
    made.push(user.id);
    await setPassword({ db, config }, user.id, PASSWORD);
    const secret = generateSecret();
    await db.credential.update({ where: { userId: user.id }, data: { totpSecret: encryptSecret(secret, KEK), totpConfirmedAt: new Date() } });
    return { id: user.id, email, secret };
  }

  async function signIn(who: { email: string; secret: string }): Promise<string> {
    const first = await call('/auth/native/signin', { body: { email: who.email, password: PASSWORD, device: DEVICE } });
    const { challenge } = (await first.json()) as { challenge: string };
    const second = await call('/auth/native/signin', { body: { challenge, totp: codeFor(who.secret) } });
    expect(second.status).toBe(200);
    return ((await second.json()) as { accessToken: string }).accessToken;
  }

  const listen = (cfg: Config, port: number) =>
    new Promise<Server>((resolve) => {
      const s = createApp({ config: cfg, db, verifier: null, oidc: null }).listen(port, '127.0.0.1', () => { resolve(s); });
    });

  beforeAll(async () => {
    db = createDb(url ?? '');
    const port = 34_000 + Math.floor(Math.random() * 2000);
    origin = `http://127.0.0.1:${String(port)}`;
    soloOrigin = `http://127.0.0.1:${String(port + 1)}`;
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: url ?? '',
      KEK,
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    };
    config = loadConfig({ ...env, BASE_URL: origin, FOREMAN_MODE: 'board' });
    server = await listen(config, port);
    solo = await listen(loadConfig({ ...env, BASE_URL: soloOrigin }), port + 1);
  });

  // Every request comes from 127.0.0.1, so the IP throttle is shared with every suite before this
  // one; each test starts from a clean slate, as auth.test.ts does.
  beforeEach(async () => {
    await db.authThrottle.deleteMany({});
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await new Promise<void>((resolve) => { solo.close(() => { resolve(); }); });
    await db.user.deleteMany({ where: { id: { in: made } } });
    await db.$disconnect();
  });

  it('names both endpoints on a board, and neither on a solo Foreman', async () => {
    const board = (await (await call('/.well-known/d3-app.json')).json()) as { endpoints: Record<string, string | null> };
    expect(board.endpoints['inviteAccept']).toBe(`${origin}/auth/native/invite`);
    expect(board.endpoints['deleteAccount']).toBe(`${origin}/auth/native/delete-account`);
    const one = (await (await call('/.well-known/d3-app.json', { base: soloOrigin })).json()) as { endpoints: Record<string, string | null> };
    expect(one.endpoints['inviteAccept']).toBeNull();
    expect(one.endpoints['deleteAccount']).toBeNull();
    expect((await call('/auth/native/invite', { base: soloOrigin, body: { token: 'x'.repeat(30), displayName: 'A', password: PASSWORD } })).status).toBe(404);
  });

  describe('accepting an invitation (FRM-T-15.2)', () => {
    it('answers an unknown token invite_invalid, never a hint that an account exists', async () => {
      const res = await call('/auth/native/invite', { body: { token: `unknown-${randomUUID()}`, displayName: 'Nobody', password: PASSWORD, device: DEVICE } });
      expect(res.status).toBe(410);
      expect(await problemType(res)).toBe(`${PROBLEM}invite_invalid`);
    });

    it('makes the account, enrols an authenticator, signs in on the device, and the token then dies', async () => {
      const email = `lifecycle-invitee-${randomUUID()}@example.com`;
      const issued = await invite(db, config, { actor: 'test', actorKind: 'system' }, { email, displayName: 'From the admin', role: 'reviewer' });
      made.push(issued.user.id);
      expect(issued.acceptUrl).toBe(`${origin}/invite?token=${issued.token}`);

      const weak = await call('/auth/native/invite', { body: { token: issued.token, displayName: 'Ada', password: 'short', device: DEVICE } });
      expect(weak.status).toBe(422);
      const weakBody = (await weak.json()) as { type: string; detail: string };
      expect(weakBody.type).toBe(`${PROBLEM}weak_password`);
      expect(weakBody.detail).toMatch(/at least 12 characters/);

      const first = await call('/auth/native/invite', { body: { token: issued.token, displayName: 'Ada', password: PASSWORD, device: DEVICE } });
      expect(first.status).toBe(200);
      const { challenge, enrolment } = (await first.json()) as { challenge: string; enrolment: { secret: string; otpauthUri: string; digits: number; period: number } };
      expect(enrolment).toMatchObject({ digits: 6, period: 30 });
      expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      // The account exists already, its name the one the person chose, with the invitation's role.
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({ status: 'active', displayName: 'Ada', role: 'reviewer' });

      // A wrong code leaves the challenge valid.
      const wrong = await call('/auth/native/invite', { body: { challenge, enrolTotp: String((Number(codeFor(enrolment.secret)) + 3) % 1_000_000).padStart(6, '0') } });
      expect(wrong.status).toBe(401);
      expect(await problemType(wrong)).toBe(`${PROBLEM}invalid_code`);

      const second = await call('/auth/native/invite', { body: { challenge, enrolTotp: codeFor(enrolment.secret) } });
      expect(second.status).toBe(200);
      const tokens = (await second.json()) as { accessToken: string; session: { id: string } };
      const me = await call('/auth/me', { bearer: tokens.accessToken });
      expect(me.status).toBe(200);
      const session = await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } });
      expect(session).toMatchObject({ native: true, deviceName: DEVICE.name });
      expect((await db.credential.findUniqueOrThrow({ where: { userId: user.id } })).totpConfirmedAt).not.toBeNull();

      const again = await call('/auth/native/invite', { body: { token: issued.token, displayName: 'Again', password: PASSWORD, device: DEVICE } });
      expect(again.status).toBe(410);
      expect(await problemType(again)).toBe(`${PROBLEM}invite_invalid`);
    });
  });

  describe('deleting an account (FRM-T-15.3, FRM-ADR-022)', () => {
    const host = () => new URL(origin).hostname;

    it('refuses a wrong code, a mismatched confirmation, and anybody not signed in', async () => {
      const who = await person('submitter');
      const bearer = await signIn(who);
      const wrong = await call('/auth/native/delete-account', { bearer, body: { confirmation: host(), totp: String((Number(codeFor(who.secret)) + 3) % 1_000_000).padStart(6, '0') } });
      expect(wrong.status).toBe(401);
      expect(await problemType(wrong)).toBe(`${PROBLEM}invalid_code`);
      const mismatch = await call('/auth/native/delete-account', { bearer, body: { confirmation: 'example.com', totp: codeFor(who.secret) } });
      expect(mismatch.status).toBe(422);
      expect(((await mismatch.json()) as { detail: string }).detail).toContain(host());
      expect((await call('/auth/native/delete-account', { body: { confirmation: host(), totp: '000000' } })).status).toBe(401);
      expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).status).toBe('active');
    });

    it('refuses the last admin, and lets an admin go once there is another', async () => {
      // Every other admin out of the way for a moment, so "the last" is this one; restored after.
      const others = await db.user.findMany({ where: { role: 'admin', status: 'active', deletedAt: null }, select: { id: true } });
      await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'suspended' } });
      try {
        const admin = await person('admin');
        const bearer = await signIn(admin);
        // Signing in burned this step's code, so the deletion uses the next one.
        const res = await call('/auth/native/delete-account', { bearer, body: { confirmation: host(), totp: codeFor(admin.secret, 30_000) } });
        expect(res.status).toBe(409);
        expect(await problemType(res)).toBe(`${PROBLEM}last_owner`);

        await person('admin');
        // That refusal burned the next step too; forget it, rather than wait a minute for a fresh one.
        await db.credential.update({ where: { userId: admin.id }, data: { totpLastStep: null } });
        const next = await call('/auth/native/delete-account', { bearer, body: { confirmation: host(), totp: codeFor(admin.secret, 30_000) } });
        expect(next.status).toBe(202);
      } finally {
        await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'active' } });
      }
    });

    it('schedules it at least a day out, ends every session and token at once, and purges it after the grace period with what they wrote kept', async () => {
      const who = await person('submitter');
      const bearer = await signIn(who);
      const browser = await db.session.create({ data: { userId: who.id, tokenHash: `lifecycle-${randomUUID()}`, method: 'password', expiresAt: new Date(Date.now() + 3_600_000) } });
      const apiToken = await db.apiToken.create({ data: { name: 'lifecycle', tokenHash: `lifecycle-${randomUUID()}`, prefix: 'frm_x', createdBy: who.email } });
      const seq = 900_000 + Math.floor(Math.random() * 90_000);
      const idea = await db.projectIdea.create({ data: { humanId: `PI-${String(seq)}`, seq, title: 'An idea that outlives its author', submittedById: who.id } });

      const res = await call('/auth/native/delete-account', { bearer, body: { confirmation: host().toUpperCase(), totp: codeFor(who.secret, 30_000) } });
      expect(res.status).toBe(202);
      const { graceUntil } = (await res.json()) as { graceUntil: string };
      expect(Date.parse(graceUntil)).toBeGreaterThanOrEqual(Date.now() + 24 * 3_600_000 - 60_000);

      expect((await call('/auth/me', { bearer })).status).toBe(401);
      expect((await db.session.findUniqueOrThrow({ where: { id: browser.id } })).revokedAt).not.toBeNull();
      expect((await db.apiToken.findUniqueOrThrow({ where: { id: apiToken.id } })).revokedAt).not.toBeNull();
      const signIn2 = await call('/auth/native/signin', { body: { email: who.email, password: PASSWORD, device: DEVICE } });
      expect(signIn2.status).toBe(401);

      // Not yet: the grace period is the person's chance to change their mind.
      await purgeDeletedAccounts(db, new Date(Date.now() + DELETION_GRACE_MS - 60_000));
      expect((await db.user.findUniqueOrThrow({ where: { id: who.id } })).email).toBe(who.email);

      await purgeDeletedAccounts(db, new Date(Date.now() + DELETION_GRACE_MS + 60_000));
      const after = await db.user.findUniqueOrThrow({ where: { id: who.id }, include: { credential: true, sessions: true } });
      expect(after.email).toBe(tombstoneEmail(who.id));
      expect(after.deletedAt).not.toBeNull();
      expect(after.credential).toBeNull();
      expect(after.sessions).toEqual([]);
      expect(after.displayName).toBe('Lifecycle');
      // What they wrote stays, and stays theirs.
      expect((await db.projectIdea.findUniqueOrThrow({ where: { id: idea.id } })).submittedById).toBe(who.id);
      const purge = await db.auditEvent.findFirst({ where: { entityId: who.id, action: 'delete', actor: 'account-deletion' } });
      expect(purge).not.toBeNull();
      await db.projectIdea.delete({ where: { id: idea.id } });
      await db.apiToken.delete({ where: { id: apiToken.id } });
    });

    it('is cancelled when an admin lifts the suspension inside the grace period', async () => {
      const { suspend } = await import('../../src/domain/members.js');
      const who = await person('submitter');
      const bearer = await signIn(who);
      expect((await call('/auth/native/delete-account', { bearer, body: { confirmation: host(), totp: codeFor(who.secret, 30_000) } })).status).toBe(202);
      await suspend(db, { actor: 'test', actorKind: 'system' }, who.id, false);
      await purgeDeletedAccounts(db, new Date(Date.now() + DELETION_GRACE_MS + 60_000));
      expect(await db.user.findUniqueOrThrow({ where: { id: who.id } })).toMatchObject({ email: who.email, status: 'active', deleteAfter: null, deletedAt: null });
    });
  });
});
