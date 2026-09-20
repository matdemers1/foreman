import { createServer, type Server as HttpServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalMcpUri, createVerifier, TokenRejected } from '../../src/auth/resource-server.js';
import { loadConfig, type Config } from '../../src/config.js';

/**
 * The audience check itself, against real signatures (ADR-013).
 *
 * Everywhere else the verifier is stubbed, which tests what the route does with a verdict but not
 * how the verdict is reached. This is the security control the whole remote endpoint rests on:
 *
 *   > MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST**
 *   > reject tokens that do not include them in the audience claim.
 *
 * So it gets a real key pair, a real JWKS served over HTTP, and real signed tokens — including the
 * one that matters most: a perfectly valid token from the right issuer, for somebody else.
 */

let jwks: HttpServer;
let issuer: string;
let config: Config;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' };

  jwks = await new Promise<HttpServer>((resolve) => {
    const s = createServer((req, res) => {
      if (req.url === '/oidc/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    }).listen(0, () => { resolve(s); });
  });

  const address = jwks.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  issuer = `http://127.0.0.1:${String(address.port)}`;

  config = loadConfig({
    NODE_ENV: 'test',
    BASE_URL: 'https://foreman.example.test',
    DATABASE_URL: 'postgresql://unused/unused',
    KEK: Buffer.alloc(32, 1).toString('base64'),
    PEPPER: Buffer.alloc(32, 2).toString('base64'),
    COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    D3AUTH_ISSUER: issuer,
    D3AUTH_CLIENT_ID: 'foreman',
    D3AUTH_CLIENT_SECRET: 'unused',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => { resolve(); }));
});

/** A token that is correct in every way except what the test is about. */
function token(over: { aud?: string; iss?: string; scope?: string; expires?: string } = {}) {
  return new SignJWT({ scope: over.scope ?? 'openid profile', email: 'someone@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(over.iss ?? issuer)
    .setAudience(over.aud ?? canonicalMcpUri(config))
    .setSubject('sub-1')
    .setIssuedAt()
    .setExpirationTime(over.expires ?? '5m')
    .sign(privateKey);
}

describe('the resource-server verifier', () => {
  it('accepts a token issued for this Foreman', async () => {
    const verifier = createVerifier(config);
    const result = await verifier?.verify(await token());

    expect(result?.sub).toBe('sub-1');
    expect(result?.scopes).toEqual(['openid', 'profile']);
  });

  it('refuses a valid token issued for somebody else', async () => {
    // The one that matters. Correctly signed by the right issuer, unexpired, for another resource
    // server — and therefore not a credential here. Without this, every token D3 Auth has ever
    // issued, for Bindery or anything added later, would open Foreman.
    const verifier = createVerifier(config);
    await expect(verifier?.verify(await token({ aud: 'https://bindery.d3cloud.io/mcp' }))).rejects.toBeInstanceOf(
      TokenRejected,
    );
  });

  it('refuses an audience that only looks like this one', async () => {
    const verifier = createVerifier(config);
    for (const near of [
      'https://foreman.example.test/mcp/',
      'https://foreman.example.test',
      'https://foreman.example.test.evil.test/mcp',
      'https://foreman.example.test/mcp/../mcp',
    ]) {
      await expect(verifier?.verify(await token({ aud: near })), near).rejects.toBeInstanceOf(TokenRejected);
    }
  });

  it('refuses a token from the wrong issuer, however well signed', async () => {
    const verifier = createVerifier(config);
    await expect(verifier?.verify(await token({ iss: 'https://somewhere.else.test' }))).rejects.toBeInstanceOf(
      TokenRejected,
    );
  });

  it('refuses an expired token', async () => {
    const verifier = createVerifier(config);
    await expect(verifier?.verify(await token({ expires: '-1m' }))).rejects.toBeInstanceOf(TokenRejected);
  });

  it('refuses a token signed by a key the issuer does not publish', async () => {
    // Forgery: the right claims, the wrong key. The JWKS is the only thing that decides.
    const other = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({ scope: 'openid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(canonicalMcpUri(config))
      .setSubject('sub-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);

    const verifier = createVerifier(config);
    await expect(verifier?.verify(forged)).rejects.toBeInstanceOf(TokenRejected);
  });

  it('treats an absent scope claim as no scopes, never as all of them', async () => {
    const verifier = createVerifier(config);
    const result = await verifier?.verify(await token({ scope: '' }));
    expect(result?.scopes).toEqual([]);
  });

  it('offers no verifier at all when D3 Auth is not configured', () => {
    // A Foreman without a provider serves no remote MCP, rather than serving one that trusts
    // anybody (FRM-REQ-017 keeps the password path working regardless).
    const without = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'https://foreman.example.test',
      DATABASE_URL: 'postgresql://unused/unused',
      KEK: Buffer.alloc(32, 1).toString('base64'),
      PEPPER: Buffer.alloc(32, 2).toString('base64'),
      COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
    });
    expect(createVerifier(without)).toBeNull();
  });
});
