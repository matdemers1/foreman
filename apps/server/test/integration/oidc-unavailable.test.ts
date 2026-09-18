import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { createOidcClient } from '../../src/auth/oidc.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * FRM-REQ-017 — **with the issuer unreachable, the password path still works.**
 *
 * The whole reason ADR-004 makes both paths permanent. A single sign-on provider is a single point
 * of failure exactly when it is the only way in, so this test blackholes it and then logs in
 * anyway. It is one of the tests that should never be allowed to go red.
 *
 * The blackhole is a port nothing listens on, which refuses immediately: a test that proves
 * resilience should not itself hang for thirty seconds to do it.
 */

const url = process.env['DATABASE_URL'];
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1';

const EMAIL = 'blackhole@example.com';
const PASSWORD = 'the-password-still-works';

describe.skipIf(url === undefined)('D3 Auth unreachable', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3200',
      DATABASE_URL: url ?? '',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      // Fully configured, and pointing at nothing.
      D3AUTH_ISSUER: UNREACHABLE_ISSUER,
      D3AUTH_CLIENT_ID: 'foreman',
      D3AUTH_CLIENT_SECRET: 'not-a-real-secret',
    });

    db = createDb(url ?? '');
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.authThrottle.deleteMany({});
    const user = await db.user.create({
      data: { email: EMAIL, displayName: 'Operator', status: 'active' },
    });
    await setPassword({ db, config }, user.id, PASSWORD);

    // This is the call that must not throw, however badly the provider is behaving.
    const oidc = await createOidcClient(config);
    expect(oidc, 'discovery against a dead issuer should yield null, not a client').toBeNull();

    const app = createApp({ config, db, oidc });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => { resolve(s); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  }, 30_000);

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.authThrottle.deleteMany({});
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    await db.$disconnect();
  });

  it('starts, and says it is configured but not reachable', async () => {
    expect(config.oidcConfigured).toBe(true);

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { oidcConfigured: boolean; oidcReachable: boolean };
    expect(body.oidcConfigured).toBe(true);
    expect(body.oidcReachable).toBe(false);
  });

  it('signs in with a password anyway — the requirement, in one assertion', async () => {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('foreman_session=');

    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const session = await fetch(`${origin}/auth/session`, { headers: { cookie } });
    expect(session.status).toBe(200);
  });

  it('tells an anonymous caller whether to offer the button at all', async () => {
    // The login screen is the only place the D3 Auth button matters, and it is reached by people
    // with no session — so the 401 has to carry this. Sending it only to signed-in callers meant
    // the button could never appear, which is how it shipped before this test existed.
    const res = await fetch(`${origin}/auth/session`);
    expect(res.status).toBe(401);

    const body = (await res.json()) as { authenticated: boolean; oidcAvailable?: boolean };
    expect(body.authenticated).toBe(false);
    expect(body.oidcAvailable, 'the 401 must say whether D3 Auth can be offered').toBeDefined();
    // Unreachable here, so the answer is no.
    expect(body.oidcAvailable).toBe(false);
  });

  it('does not offer a button that leads nowhere', async () => {
    const res = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const session = await fetch(`${origin}/auth/session`, { headers: { cookie } });

    const body = (await session.json()) as { oidcAvailable: boolean };
    // Configured is not the same as reachable, and the console asks the second question.
    expect(body.oidcAvailable).toBe(false);
  });

  it('answers 503 on the sign-in route rather than hanging or crashing', async () => {
    const res = await fetch(`${origin}/auth/oidc/start`, { redirect: 'manual' });
    expect(res.status).toBe(503);
  });

  it('answers 503 on the callback too, without a transaction cookie to read', async () => {
    const res = await fetch(`${origin}/auth/oidc/callback?state=whatever&code=whatever`);
    expect(res.status).toBe(503);
  });
});
