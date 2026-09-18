import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../logger.js';
import * as sessions from './sessions.js';

/**
 * "Sign in with D3 Auth" — the second of the two permanent login paths (ADR-004, FRM-REQ-016,
 * FRM-REQ-019, FRM-REQ-020, FRM-REQ-021).
 *
 * Written against `d3-auth/examples/express`, line by line, as the phase plan says. It does **not**
 * use `@d3cloud/auth-client`: that package is a workspace package in the `d3-auth` repo and is not
 * published to npm (a 404 today), so it cannot be a dependency of another repository. What it adds
 * over raw `openid-client` is reproduced here — a pinned algorithm list, identity by `(iss, sub)`,
 * roles read from userinfo — and Foreman's own ADR-010 records the swap back when it is published.
 *
 * **Nothing here may be load-bearing for the password path.** Discovery happens once at boot and is
 * allowed to fail: an unreachable issuer leaves `oidcAvailable` false and every other route
 * untouched (FRM-REQ-017).
 */

/** Signature algorithms accepted on an ID token. Pinned: `alg` is attacker-influenced. */
export const ALLOWED_ALGORITHMS = ['RS256', 'ES256'] as const;

/** A sign-in in flight. Ten minutes is longer than any real sign-in takes. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const TX_COOKIE = 'foreman_oidc_tx';

export interface PendingSignIn {
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly expiresAt: number;
  /** Set when this sign-in is linking an identity to an already-signed-in account. */
  readonly linkToUserId?: string;
}

export interface OidcClient {
  readonly issuer: string;
  beginSignIn(linkToUserId?: string): Promise<{ url: string; tx: string }>;
  completeSignIn(callbackUrl: URL, tx: string, state: string): Promise<CompletedSignIn>;
  endSessionUrl(idToken: string, returnTo: string): string | null;
}

export interface CompletedSignIn {
  readonly iss: string;
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly idToken: string;
  readonly linkToUserId?: string;
}

export class OidcError extends Error {}

/**
 * Discover the provider and build a client, or return `null` when it is not configured or not
 * reachable. Never throws: a provider that is down is a Foreman that offers one login button
 * instead of two, not a Foreman that will not start.
 */
export async function createOidcClient(config: Config): Promise<OidcClient | null> {
  if (!config.oidcConfigured) return null;

  const issuerUrl = config.D3AUTH_ISSUER ?? '';
  const clientId = config.D3AUTH_CLIENT_ID ?? '';
  const clientSecret = config.D3AUTH_CLIENT_SECRET ?? '';
  const redirectUri = new URL('/auth/oidc/callback', config.BASE_URL).toString();

  let discovered: oidc.Configuration;
  try {
    discovered = await oidc.discovery(new URL(issuerUrl), clientId, clientSecret);
  } catch (error) {
    logger.warn(
      { issuer: issuerUrl, err: error instanceof Error ? error.message : String(error) },
      'D3 Auth discovery failed; the password path is unaffected',
    );
    return null;
  }

  const pending = new Map<string, PendingSignIn>();

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  };

  return {
    issuer: issuerUrl,

    async beginSignIn(linkToUserId) {
      sweep();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const tx = randomBytes(32).toString('base64url');
      // Awaited, not cast: the challenge is derived by a hash, and a Promise stringified into
      // the URL is a sign-in that fails at the token endpoint with nothing to point at.
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);

      const url = oidc
        .buildAuthorizationUrl(discovered, {
          redirect_uri: redirectUri,
          // `d3:roles` is what makes the roles claim appear at all.
          scope: 'openid profile email d3:roles',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          nonce,
        })
        .toString();

      pending.set(tx, {
        verifier,
        state,
        nonce,
        expiresAt: Date.now() + TRANSACTION_TTL_MS,
        ...(linkToUserId !== undefined ? { linkToUserId } : {}),
      });
      return { url, tx };
    },

    async completeSignIn(callbackUrl, tx, state) {
      const started = pending.get(tx);
      pending.delete(tx);

      // This browser started it, and it is the sign-in it started. Anything else is refused —
      // which is what makes a pasted callback URL useless.
      if (started === undefined) throw new OidcError('no sign-in is in progress for this browser');
      if (started.expiresAt <= Date.now()) throw new OidcError('the sign-in took too long');
      if (started.state !== state) throw new OidcError('state did not match');

      const tokens = await oidc.authorizationCodeGrant(discovered, callbackUrl, {
        pkceCodeVerifier: started.verifier,
        expectedState: started.state,
        expectedNonce: started.nonce,
      });

      const claims = tokens.claims();
      if (claims === undefined) throw new OidcError('the response carried no ID token');

      // RFC 9207: the issuer is checked, not assumed. A token from another provider that happens
      // to carry the same `sub` must not resolve to the same identity.
      if (claims.iss !== issuerUrl.replace(/\/$/, '') && claims.iss !== issuerUrl) {
        throw new OidcError(`unexpected issuer ${claims.iss}`);
      }

      const info = await oidc.fetchUserInfo(discovered, tokens.access_token, claims.sub);

      return {
        iss: claims.iss,
        sub: claims.sub,
        ...(typeof info.email === 'string' ? { email: info.email } : {}),
        ...(typeof info.name === 'string' ? { name: info.name } : {}),
        idToken: tokens.id_token ?? '',
        ...(started.linkToUserId !== undefined ? { linkToUserId: started.linkToUserId } : {}),
      };
    },

    endSessionUrl(idToken, returnTo) {
      try {
        return oidc
          .buildEndSessionUrl(discovered, {
            id_token_hint: idToken,
            post_logout_redirect_uri: returnTo,
          })
          .toString();
      } catch {
        // A provider with no end-session endpoint is not an error; the local session still ends.
        return null;
      }
    },
  };
}

/**
 * Resolve a completed sign-in to a local user.
 *
 * **Identities link by `(iss, sub)`, never by email** (ADR-004). An email is a display attribute
 * that a provider may change or reuse; treating it as a key means whoever next holds an address
 * inherits the account.
 */
export async function resolveIdentity(
  db: Db,
  completed: CompletedSignIn,
): Promise<{ userId: string; created: boolean }> {
  const existing = await db.identity.findUnique({
    where: { iss_sub: { iss: completed.iss, sub: completed.sub } },
  });

  if (existing !== null) {
    await db.identity.update({
      where: { id: existing.id },
      data: { lastLoginAt: new Date(), claims: { email: completed.email ?? null } },
    });
    return { userId: existing.userId, created: false };
  }

  // Linking: attach this identity to the account already signed in here — never to one matched by
  // email afterwards.
  if (completed.linkToUserId !== undefined) {
    await db.identity.create({
      data: {
        userId: completed.linkToUserId,
        iss: completed.iss,
        sub: completed.sub,
        lastLoginAt: new Date(),
        claims: { email: completed.email ?? null },
      },
    });
    return { userId: completed.linkToUserId, created: false };
  }

  // Just-in-time provisioning: a successful sign-in is already proof that D3 Auth meant them to be
  // here, because deny-by-default means it refuses everybody else.
  const user = await db.user.create({
    data: {
      email: completed.email ?? `${completed.sub}@${new URL(completed.iss).hostname}`,
      displayName: completed.name ?? completed.email ?? 'D3 Auth user',
      status: 'active',
      identities: {
        create: {
          iss: completed.iss,
          sub: completed.sub,
          lastLoginAt: new Date(),
          claims: { email: completed.email ?? null },
        },
      },
    },
  });
  return { userId: user.id, created: true };
}

export async function issueSessionFor(
  db: Db,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined; sub?: string | undefined },
): Promise<string> {
  const session = await sessions.issue(db, userId, 'oidc', meta);
  if (meta.sub !== undefined) {
    await db.session.update({ where: { id: session.id }, data: { idTokenSub: meta.sub } });
  }
  return session.token;
}
