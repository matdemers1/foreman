import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

/**
 * FRM-REQ-006 — a missing secret is a refusal, and the message names the variable.
 *
 * The test unsets each required variable in turn, which is exactly how the phase plan says to
 * verify it.
 */

const complete = {
  NODE_ENV: 'production',
  PORT: '3200',
  BASE_URL: 'https://foreman.d3cloud.io',
  DATABASE_URL: 'postgresql://foreman:foreman@db:5432/foreman',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
  COOKIE_KEYS: Buffer.alloc(32, 3).toString('base64'),
} satisfies NodeJS.ProcessEnv;

const REQUIRED = ['BASE_URL', 'DATABASE_URL', 'KEK', 'PEPPER', 'COOKIE_KEYS'] as const;

describe('configuration', () => {
  it('accepts a complete environment', () => {
    const config = loadConfig(complete);
    expect(config.PORT).toBe(3200);
    expect(config.COOKIE_KEYS).toHaveLength(1);
  });

  it.each(REQUIRED)('refuses to boot without %s, and names it', (name) => {
    // Rebuilt without the one key, rather than deleted from a copy: the same environment, minus one.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(complete).filter(([key]) => key !== name),
    );
    try {
      loadConfig(env);
      expect.unreachable(`${name} was missing and the config loaded anyway`);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join('\n')).toContain(name);
    }
  });

  it('refuses the placeholder values shipped in .env.example', () => {
    expect(() => loadConfig({ ...complete, KEK: 'change-me' })).toThrow(/placeholder/);
  });

  it('refuses a key too short to be one', () => {
    expect(() => loadConfig({ ...complete, PEPPER: Buffer.alloc(16, 7).toString('base64') })).toThrow(
      /at least 32 bytes/,
    );
  });

  it('refuses a DATABASE_URL that is not postgres', () => {
    expect(() => loadConfig({ ...complete, DATABASE_URL: 'mysql://x/y' })).toThrow(/postgres/);
  });

  it('runs without D3 Auth configured, because the password path must not depend on it', () => {
    const config = loadConfig(complete);
    expect(config.oidcConfigured).toBe(false);
  });

  it('reports OIDC as configured when all three values are present', () => {
    const config = loadConfig({
      ...complete,
      D3AUTH_ISSUER: 'https://auth.d3cloud.io',
      D3AUTH_CLIENT_ID: 'foreman',
      D3AUTH_CLIENT_SECRET: 'shh',
    });
    expect(config.oidcConfigured).toBe(true);
  });

  it('refuses a half-configured issuer, which would fail at the redirect instead of at boot', () => {
    expect(() => loadConfig({ ...complete, D3AUTH_CLIENT_ID: 'foreman' })).toThrow(
      /D3AUTH_CLIENT_ID is set but/,
    );
  });

  it('splits COOKIE_KEYS newest-first so a key can be rotated', () => {
    const newest = Buffer.alloc(32, 9).toString('base64');
    const previous = Buffer.alloc(32, 8).toString('base64');
    const config = loadConfig({ ...complete, COOKIE_KEYS: `${newest}, ${previous}` });
    expect(config.COOKIE_KEYS).toEqual([newest, previous]);
  });
});
