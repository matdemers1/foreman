import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, safeEqual, verifyPassword } from '../../src/auth/passwords.js';
import { cookieName, cookieOptions, hashToken } from '../../src/auth/sessions.js';
import {
  BASE_DELAY_MS,
  delayFor,
  FREE_ATTEMPTS,
  MAX_DELAY_MS,
} from '../../src/auth/throttle.js';
import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  provisioningUri,
  TOTP_PERIOD,
  verifyCode,
} from '../../src/auth/totp.js';

const PEPPER = Buffer.alloc(32, 5).toString('base64');
const KEK = Buffer.alloc(32, 6).toString('base64');

describe('passwords (FRM-REQ-018)', () => {
  it('verifies the password it hashed', async () => {
    const hash = await hashPassword('correct horse battery staple', PEPPER);
    expect(await verifyPassword(hash, 'correct horse battery staple', PEPPER)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('one', PEPPER);
    expect(await verifyPassword(hash, 'two', PEPPER)).toBe(false);
  });

  it('is useless without the pepper — a stolen database is not enough', async () => {
    const hash = await hashPassword('secret', PEPPER);
    const otherPepper = Buffer.alloc(32, 99).toString('base64');
    expect(await verifyPassword(hash, 'secret', otherPepper)).toBe(false);
  });

  it('stores Argon2id, not something cheaper', async () => {
    const hash = await hashPassword('x', PEPPER);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    // 64 MiB, per the OWASP profile the module documents.
    expect(hash).toContain('m=65536');
  });

  it('treats a corrupt stored hash as a failed login, not a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything', PEPPER)).toBe(false);
    expect(needsRehash('not-a-hash')).toBe(true);
  });

  it('does not consider a current hash in need of rehashing', async () => {
    expect(needsRehash(await hashPassword('x', PEPPER))).toBe(false);
  });

  it('compares tokens without leaking length by early return', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('throttling (FRM-REQ-023, FRM-REQ-024)', () => {
  it('does not punish a typo', () => {
    for (let i = 1; i <= FREE_ATTEMPTS; i++) expect(delayFor(i)).toBe(0);
  });

  it('doubles after the free attempts', () => {
    expect(delayFor(FREE_ATTEMPTS + 1)).toBe(BASE_DELAY_MS);
    expect(delayFor(FREE_ATTEMPTS + 2)).toBe(BASE_DELAY_MS * 2);
    expect(delayFor(FREE_ATTEMPTS + 3)).toBe(BASE_DELAY_MS * 4);
  });

  it('caps the delay instead of locking the account out', () => {
    // The requirement is explicit: delay, never lock. A ceiling is what keeps it a delay.
    expect(delayFor(1000)).toBe(MAX_DELAY_MS);
    expect(Number.isFinite(delayFor(1e6))).toBe(true);
  });
});

describe('session cookies', () => {
  it('uses the __Host- prefix on a secure origin', () => {
    expect(cookieName(true)).toBe('__Host-foreman_session');
    expect(cookieName(false)).toBe('foreman_session');
  });

  it('sets HttpOnly, Secure, SameSite=Lax and Path=/', () => {
    const options = cookieOptions(true);
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    // Lax and not Strict: the OIDC redirect is a cross-site GET and Strict would drop the cookie.
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('stores only a hash of the cookie value', () => {
    const token = 'a-session-token';
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('TOTP', () => {
  it('round-trips a secret through encryption at rest', () => {
    const secret = generateSecret();
    const stored = encryptSecret(secret, KEK);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored, KEK)).toBe(secret);
  });

  it('refuses to decrypt with the wrong key', () => {
    const stored = encryptSecret(generateSecret(), KEK);
    expect(() => decryptSecret(stored, Buffer.alloc(32, 7).toString('base64'))).toThrow();
  });

  it('refuses a KEK too short to be a key', () => {
    expect(() => encryptSecret('x', Buffer.alloc(8, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('accepts a current code and refuses the same code twice', async () => {
    const secret = generateSecret();
    const { TOTP, Secret } = await import('otpauth');
    const now = new Date();
    const code = new TOTP({
      issuer: 'Foreman',
      label: 'me@example.com',
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD,
      secret: Secret.fromBase32(secret),
    }).generate({ timestamp: now.getTime() });

    const first = verifyCode(secret, code, 'me@example.com', null, now);
    expect(first.valid).toBe(true);

    // A code seen over a shoulder is good for one login, not for the rest of its window.
    const replay = verifyCode(secret, code, 'me@example.com', first.step ?? 0, now);
    expect(replay.valid).toBe(false);
  });

  it('refuses a code that is simply wrong', () => {
    expect(verifyCode(generateSecret(), '000000', 'me@example.com', null).valid).toBe(false);
  });

  it('builds a provisioning URI an authenticator app can read', () => {
    const uri = provisioningUri(generateSecret(), 'me@example.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Foreman');
  });
});
