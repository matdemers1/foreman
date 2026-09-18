import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { generateSecret, provisioningUri, TOTP_PERIOD } from '../../src/auth/totp.js';
import { encryptSecret } from '../../src/auth/totp.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The app-native login path, over real HTTP (T-0.6).
 *
 * Driven through `fetch` against a listening server rather than by calling handlers, because the
 * things most worth asserting here — the cookie's flags, the status codes, the `Retry-After`
 * header — only exist once a response has actually been written.
 */

const url = process.env['DATABASE_URL'];

const EMAIL = 'operator@example.com';
const PASSWORD = 'a-long-enough-password-for-a-test';

describe.skipIf(url === undefined)('app-native login', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;
  let userId: string;

  beforeAll(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    db = createDb(url ?? '');
    const app = createApp({ config, db });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => {
        resolve(s);
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  beforeEach(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.authThrottle.deleteMany({});
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Operator', status: 'active' },
    });
    userId = user.id;
    await setPassword({ db, config }, userId, PASSWORD);
    await db.auditEvent.deleteMany({ where: { entityId: userId } });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.authThrottle.deleteMany({});
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  const login = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('signs in with the right password and sets a hardened cookie', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('foreman_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('stores only a hash of the session token, never the token', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    const cookie = res.headers.get('set-cookie') ?? '';
    const token = /foreman_session=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const rows = await db.session.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes an audit event for the login', async () => {
    await login({ email: EMAIL, password: PASSWORD });
    const events = await db.auditEvent.findMany({ where: { entityId: userId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe(EMAIL);
    expect(events[0]?.after).toMatchObject({ event: 'login', method: 'password' });
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrongPassword = await login({ email: EMAIL, password: 'nope' });
    const unknownAccount = await login({ email: 'nobody@example.com', password: 'nope' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Identical, so the response cannot be used to enumerate accounts.
    expect(await wrongPassword.json()).toEqual(await unknownAccount.json());
  });

  it('answers /auth/session for a signed-in cookie and 401 without one', async () => {
    const anonymous = await fetch(`${origin}/auth/session`);
    expect(anonymous.status).toBe(401);

    const res = await login({ email: EMAIL, password: PASSWORD });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const session = await fetch(`${origin}/auth/session`, { headers: { cookie } });

    expect(session.status).toBe(200);
    const body = (await session.json()) as { user: { email: string }; oidcAvailable: boolean };
    expect(body.user.email).toBe(EMAIL);
    // Nothing is configured in this test, and the console must not offer a button to nowhere.
    expect(body.oidcAvailable).toBe(false);
  });

  it('ends the session on logout, and the cookie stops working', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const out = await fetch(`${origin}/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);

    const after = await fetch(`${origin}/auth/session`, { headers: { cookie } });
    expect(after.status).toBe(401);
    expect((await db.session.findFirstOrThrow({ where: { userId } })).revokedAt).not.toBeNull();
  });

  it('asks for a TOTP code once one is enrolled, and refuses a wrong one', async () => {
    const secret = generateSecret();
    await db.credential.update({
      where: { userId },
      data: { totpSecret: encryptSecret(secret, config.KEK), totpConfirmedAt: new Date() },
    });

    const withoutCode = await login({ email: EMAIL, password: PASSWORD });
    expect(withoutCode.status).toBe(200);
    expect(await withoutCode.json()).toEqual({ status: 'totp_required' });
    // No cookie is issued on the first leg.
    expect(withoutCode.headers.get('set-cookie')).toBeNull();

    const wrongCode = await login({ email: EMAIL, password: PASSWORD, totpCode: '000000' });
    expect(wrongCode.status).toBe(401);

    const { Secret, TOTP } = await import('otpauth');
    const code = new TOTP({
      issuer: 'Foreman',
      label: EMAIL,
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD,
      secret: Secret.fromBase32(secret),
    }).generate();

    const signedIn = await login({ email: EMAIL, password: PASSWORD, totpCode: code });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).toContain('foreman_session=');

    // The step is burned, so the same code cannot be used again inside its window.
    const replay = await login({ email: EMAIL, password: PASSWORD, totpCode: code });
    expect(replay.status).toBe(401);
  });

  it('throttles after repeated failures, and says how long to wait', async () => {
    let throttled: Response | null = null;
    for (let i = 0; i < 6; i++) {
      const res = await login({ email: EMAIL, password: 'wrong' });
      if (res.status === 429) {
        throttled = res;
        break;
      }
    }

    expect(throttled, 'six wrong passwords should have been throttled').not.toBeNull();
    expect(throttled?.headers.get('retry-after')).toMatch(/^\d+$/);

    // And it is a delay, not a lockout: the row carries a time, and the account is never disabled.
    const rows = await db.authThrottle.findMany({ where: { scope: 'account', key: EMAIL } });
    expect(rows[0]?.nextAllowedAt.getTime()).toBeGreaterThan(Date.now());
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).status).toBe('active');
  });

  it('clears the throttle once the right password arrives', async () => {
    await login({ email: EMAIL, password: 'wrong' });
    expect(await db.authThrottle.count({ where: { key: EMAIL } })).toBe(1);

    const ok = await login({ email: EMAIL, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await db.authThrottle.count({ where: { key: EMAIL } })).toBe(0);
  });

  it('ends every existing session when the password changes', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect((await fetch(`${origin}/auth/session`, { headers: { cookie } })).status).toBe(200);

    await setPassword({ db, config }, userId, 'a-different-long-password');
    expect((await fetch(`${origin}/auth/session`, { headers: { cookie } })).status).toBe(401);
  });

  it('refuses a suspended account even with the right password', async () => {
    await db.user.update({ where: { id: userId }, data: { status: 'suspended' } });
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('treats the email case-insensitively, since it is not an identifier', async () => {
    const res = await login({ email: EMAIL.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed body without touching the database', async () => {
    const res = await login({ email: EMAIL });
    expect(res.status).toBe(400);
    expect(await db.authThrottle.count()).toBe(0);
  });

  it('never serves the SPA fallback for an API path', async () => {
    const res = await fetch(`${origin}/auth/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('provisions a TOTP URI labelled with the account', () => {
    expect(provisioningUri(generateSecret(), EMAIL)).toContain(encodeURIComponent(EMAIL));
  });
});
