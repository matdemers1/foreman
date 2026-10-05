import { createServer, type Server } from 'node:http';
import { createECDH } from 'node:crypto';
import { openEnvelope } from '../../src/push/envelope.js';
import { signRelayRequest } from '../../src/push/relay.js';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setPassword } from '../../src/auth/native.js';
import { createVerifier } from '../../src/auth/resource-server.js';
import { encryptSecret, generateSecret } from '../../src/auth/totp.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db.js';

/**
 * The D3 App contract (FRM-P-14): the manifest; native sessions in JSON reached with a Bearer token;
 * refresh rotation where a rotated token presented again ends the session; the sessions list naming
 * the phone and revoking it; and D3 Auth tokens for the **app's** audience — distinct from `/mcp`,
 * each path accepting exactly its own — that act as the person and can never mint an API token.
 *
 * Against the real verifier, with a stand-in D3 Auth serving its key set, so the audience rule is
 * the library's, not a stub's.
 */

const url = process.env['DATABASE_URL'];
const PASSWORD = 'a-password-for-the-native-contract-tests';
const DEVICE = { name: "Matt's iPhone", platform: 'ios' };
const PROBLEM = 'https://d3cloud.io/problems/';
const KEK = Buffer.alloc(32, 1).toString('base64');

describe.skipIf(url === undefined)('the D3 App contract (FRM-P-14)', () => {
  let db: Db;
  let config: Config;
  let server: Server;
  let jwksServer: Server;
  let origin: string;
  let issuer: string;
  let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

  const call = (path: string, init: { bearer?: string; cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.cookie !== undefined) headers.set('cookie', init.cookie);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'manual',
    });
  };
  const problemOf = async (res: Response): Promise<Record<string, unknown>> => {
    expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe(res.status);
    return body;
  };

  async function person(opts: { totp?: boolean } = {}): Promise<{ id: string; email: string; secret: string | null }> {
    const email = `native-${randomUUID()}@example.com`;
    const user = await db.user.create({ data: { email, displayName: 'Native', status: 'active' } });
    await setPassword({ db, config }, user.id, PASSWORD);
    let secret: string | null = null;
    if (opts.totp === true) {
      secret = generateSecret();
      await db.credential.update({ where: { userId: user.id }, data: { totpSecret: encryptSecret(secret, KEK), totpConfirmedAt: new Date() } });
    }
    return { id: user.id, email, secret };
  }
  const codeFor = (secret: string, offsetMs = 0) =>
    new TOTP({ issuer: 'Foreman', algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp: Date.now() + offsetMs });

  interface Tokens { accessToken: string; refreshToken: string; expiresIn: number; session: { id: string } }
  async function signIn(who: { email: string }): Promise<Tokens> {
    const res = await call('/auth/native/signin', { body: { email: who.email, password: PASSWORD, device: DEVICE } });
    expect(res.status).toBe(200);
    return (await res.json()) as Tokens;
  }

  const jwt = (opts: { sub: string; aud: string }) =>
    new SignJWT({ scope: 'openid' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(issuer)
      .setSubject(opts.sub)
      .setAudience(opts.aud)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    key = pair.privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    jwksServer = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/oidc/jwks' ? JSON.stringify({ keys: [jwk] }) : '{}');
      }).listen(0, () => { resolve(s); });
    });
    const jwksAddress = jwksServer.address();
    if (jwksAddress === null || typeof jwksAddress === 'string') throw new Error('no port');
    issuer = `http://127.0.0.1:${String(jwksAddress.port)}`;

    db = createDb(url ?? '');
    // The listener's port is not known until it listens, and BASE_URL must equal the origin the
    // app's audience names — so the app is built for a fixed port.
    const port = 32_000 + Math.floor(Math.random() * 2000);
    origin = `http://127.0.0.1:${String(port)}`;
    config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: origin,
      DATABASE_URL: url ?? '',
      KEK,
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
      D3AUTH_ISSUER: issuer,
      D3AUTH_CLIENT_ID: 'foreman',
      D3AUTH_CLIENT_SECRET: 'not-used-here',
      RELAY_ALLOW_LOOPBACK_HTTP: '1',
    });
    server = await new Promise<Server>((resolve) => {
      const s = createApp({ config, db, verifier: createVerifier(config), oidc: null }).listen(port, '127.0.0.1', () => { resolve(s); });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    await new Promise<void>((resolve) => { jwksServer.close(() => { resolve(); }); });
    await db.$disconnect();
  });

  it('serves the manifest: native endpoints on this origin, D3 Auth for the app’s audience — not /mcp’s', async () => {
    const res = await call('/.well-known/d3-app.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      product: 'foreman',
      contract: 1,
      signIn: { methods: ['password', 'totp', 'd3auth'], d3auth: { issuer, resource: origin } },
      endpoints: { nativeSignIn: `${origin}/auth/native/signin`, me: `${origin}/auth/me`, link: `${origin}/auth/native/link` },
    });
  });

  it('password then code gives a named session that opens the API with a Bearer token only', async () => {
    const who = await person({ totp: true });
    const first = await call('/auth/native/signin', { body: { email: who.email, password: PASSWORD, device: DEVICE } });
    expect(first.status).toBe(202);
    const { challenge } = (await first.json()) as { challenge: string };
    const wrong = await call('/auth/native/signin', { body: { challenge, totp: '000000' } });
    expect((await problemOf(wrong))['type']).toBe(`${PROBLEM}invalid_code`);
    const second = await call('/auth/native/signin', { body: { challenge, totp: codeFor(who.secret ?? '') } });
    expect(second.status).toBe(200);
    const tokens = (await second.json()) as Tokens;
    expect(tokens.expiresIn).toBeLessThanOrEqual(900);

    const me = await call('/auth/me', { bearer: tokens.accessToken });
    expect(await me.json()).toMatchObject({ accountId: who.id, email: who.email, roles: [expect.any(String)] });
    expect((await call('/api/portfolio', { bearer: tokens.accessToken })).status).toBe(200);
    expect((await call('/api/portfolio', { cookie: `foreman_session=${tokens.accessToken}` })).status).toBe(401);
    expect(await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } })).toMatchObject({ native: true, deviceName: DEVICE.name });
  });

  it('refusals are registered problems', async () => {
    const who = await person();
    expect((await problemOf(await call('/auth/native/signin', { body: { email: who.email, password: 'nope' } })))['type']).toBe(`${PROBLEM}invalid_credentials`);
    expect((await problemOf(await call('/auth/me')))['type']).toBe(`${PROBLEM}session_revoked`);
    const unknown = await call('/api/portfolio', { bearer: 'not-a-session' });
    expect((await problemOf(unknown))['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('refresh rotates; a rotated token presented again ends the session', async () => {
    const tokens = await signIn(await person());
    const rotated = await call('/auth/native/refresh', { body: { refreshToken: tokens.refreshToken } });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as Tokens;
    expect((await call('/auth/me', { bearer: tokens.accessToken })).status).toBe(401);
    expect((await call('/auth/me', { bearer: next.accessToken })).status).toBe(200);
    expect((await problemOf(await call('/auth/native/refresh', { body: { refreshToken: tokens.refreshToken } })))['type']).toBe(`${PROBLEM}refresh_reused`);
    expect((await problemOf(await call('/auth/native/refresh', { body: { refreshToken: next.refreshToken } })))['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('revoke ends the session and its refresh token', async () => {
    const tokens = await signIn(await person());
    expect((await call('/auth/native/revoke', { bearer: tokens.accessToken, method: 'POST' })).status).toBe(204);
    expect((await problemOf(await call('/auth/native/refresh', { body: { refreshToken: tokens.refreshToken } })))['type']).toBe(`${PROBLEM}session_revoked`);
  });

  it('the sessions list names the phone, and revoking it signs the app out at its next refresh (FRM-T-14.4)', async () => {
    const who = await person();
    const phone = await signIn(who);
    const other = await signIn(who);
    const listed = (await (await call('/auth/sessions', { bearer: other.accessToken })).json()) as { id: string; deviceName: string | null; current: boolean }[];
    expect(listed.find((s) => s.id === phone.session.id)).toMatchObject({ deviceName: DEVICE.name, current: false });
    expect((await call(`/auth/sessions/${phone.session.id}/revoke`, { bearer: other.accessToken, method: 'POST' })).status).toBe(204);
    expect((await problemOf(await call('/auth/native/refresh', { body: { refreshToken: phone.refreshToken } })))['type']).toBe(`${PROBLEM}session_revoked`);
  });

  describe('D3 Auth tokens (FRM-T-14.3)', () => {
    it('an app token links once, then acts as the person — and can never mint an API token', async () => {
      const who = await person({ totp: true });
      const sub = `sub-${randomUUID()}`;
      const app = await jwt({ sub, aud: origin });
      expect((await problemOf(await call('/auth/me', { bearer: app })))['type']).toBe(`${PROBLEM}identity_not_linked`);

      const linked = await call('/auth/native/link', { bearer: app, body: { email: who.email, password: PASSWORD, totp: codeFor(who.secret ?? '') } });
      expect(linked.status).toBe(200);
      expect(await linked.json()).toEqual({ linked: true, accountId: who.id });

      expect((await call('/auth/me', { bearer: app })).status).toBe(200);
      expect((await call('/api/portfolio', { bearer: app })).status).toBe(200);
      const mint = await call('/api/tokens', { bearer: app, body: { name: 'test:native:minted', scopes: ['read'] } });
      expect(mint.status).toBeGreaterThanOrEqual(401);
      expect(await db.apiToken.count({ where: { name: 'test:native:minted' } })).toBe(0);
    });

    it('each path accepts exactly its own audience: an /mcp token is refused on the API, an app token at /mcp', async () => {
      const who = await person();
      const sub = `sub-${randomUUID()}`;
      await db.identity.create({ data: { userId: who.id, iss: issuer, sub, claims: {} } });
      const mcpToken = await jwt({ sub, aud: new URL('/mcp', origin).toString() });
      const appToken = await jwt({ sub, aud: origin });
      expect((await call('/api/portfolio', { bearer: mcpToken })).status).toBe(401);
      expect((await call('/api/portfolio', { bearer: appToken })).status).toBe(200);
      const atMcp = await call('/mcp', {
        bearer: appToken,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        headers: { accept: 'application/json, text/event-stream' },
      });
      expect(atMcp.status).toBe(401);
      // And the /mcp token still works where it belongs, through the loopback.
      const mcp = await call('/mcp', {
        bearer: mcpToken,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        headers: { accept: 'application/json, text/event-stream' },
      });
      expect(mcp.status).toBe(200);
    });
  });

  describe('push through the relay (FRM-T-15.4)', () => {
    const pushes: { path: string; timestamp: string; signature: string; raw: string }[] = [];
    let relay: Server;
    let relayUrl = '';
    beforeAll(async () => {
      relay = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        req.on('end', () => {
          pushes.push({ path: req.url ?? '', timestamp: String(req.headers['x-d3-relay-timestamp']), signature: String(req.headers['x-d3-relay-signature']), raw });
          res.writeHead(202);
          res.end('{}');
        });
      });
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => { resolve(); }));
      const address = relay.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      relayUrl = `http://127.0.0.1:${String(address.port)}`;
    });
    afterAll(() => {
      relay.close();
    });
    const deviceKey = () => {
      const pair = createECDH('prime256v1');
      pair.generateKeys();
      return pair;
    };
    const register = (bearer: string, key: ReturnType<typeof deviceKey>, registration: string, url = relayUrl) =>
      call('/api/push/native/register', { bearer, body: { devicePublicKey: key.getPublicKey().toString('base64'), relay: { url, registration, sendKey: `send-key-${registration}-0123456789` }, categories: [] } });
    const waitFor = async (registration: string) => {
      for (let i = 0; i < 80; i++) {
        const found = pushes.find((p) => p.path === `/v1/push/${registration}`);
        if (found !== undefined) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('no push');
    };

    it('the manifest names the endpoint', async () => {
      const manifest = (await (await call('/.well-known/d3-app.json')).json()) as { endpoints: Record<string, string> };
      expect(manifest.endpoints['relayRegister']).toBe(`${origin}/api/push/native/register`);
    });

    it('a native session registers and gets one foreman.registered only its device can open; revoking forgets it', async () => {
      const tokens = await signIn(await person());
      const key = deviceKey();
      const reg = `reg-${tokens.session.id}`;
      expect((await register(tokens.accessToken, key, reg)).status).toBe(204);
      const pushed = await waitFor(reg);
      expect(pushed.signature).toBe(signRelayRequest(`send-key-${reg}-0123456789`, pushed.timestamp, pushed.raw));
      const payload = JSON.parse(openEnvelope(key, (JSON.parse(pushed.raw) as { ciphertext: string }).ciphertext).toString()) as Record<string, unknown>;
      expect(payload).toMatchObject({ v: 1, category: 'foreman.registered' });
      expect((await call('/auth/native/revoke', { bearer: tokens.accessToken, method: 'POST' })).status).toBe(204);
      // Foreman revokes softly; the registration goes with the session all the same.
      expect(await db.relayRegistration.count({ where: { registration: reg } })).toBe(0);
    });

    it('an app token’s registration belongs to its identity; a bad request, plain http and the console are refused', async () => {
      const who = await person();
      const sub = `sub-${randomUUID()}`;
      const identity = await db.identity.create({ data: { userId: who.id, iss: issuer, sub, claims: {} } });
      const app = await jwt({ sub, aud: origin });
      const key = deviceKey();
      const reg = `app-${sub}`;
      expect((await register(app, key, reg)).status).toBe(204);
      expect(await db.relayRegistration.findFirstOrThrow({ where: { registration: reg } })).toMatchObject({ identityId: identity.id, sessionId: null });
      expect((await register(app, key, 'plain', 'http://relay.example.com')).status).toBe(400);
      expect((await call('/api/push/native/register', { bearer: app, body: { devicePublicKey: key.getPublicKey().toString('base64') } })).status).toBe(400);
      expect((await call('/api/push/native/register', { body: {} })).status).toBe(401);
    });
  });
});
