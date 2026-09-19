import { randomBytes } from 'node:crypto';
import { createAuthClient, identityKey, type AuthClient } from '@d3cloudio/auth-client';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { logger } from '../logger.js';
import * as sessions from './sessions.js';

/**
 * "Sign in with D3 Auth" — the second of the two permanent login paths (ADR-004, FRM-REQ-016,
 * FRM-REQ-019, FRM-REQ-020, FRM-REQ-021).
 *
 * Built on **`@d3cloudio/auth-client`**, the shared relying-party SDK, since its publication to npm
 * on 2026-09-18. ADR-010 recorded the hand-rolled implementation this replaces and the condition
 * for replacing it; that condition is now met, and roughly two hundred lines of PKCE, state, nonce
 * and issuer handling are gone with it.
 *
 * **Nothing here may be load-bearing for the password path.** Discovery happens once at boot and is
 * allowed to fail: an unreachable issuer leaves `oidcAvailable` false and every other route
 * untouched (FRM-REQ-017).
 */

/** A sign-in in flight. Ten minutes is longer than any real sign-in takes. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
export const TX_COOKIE = 'foreman_oidc_tx';

interface PendingSignIn {
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
  endSessionUrl(idToken: string, returnTo: string): Promise<string | null>;
}

export interface CompletedSignIn {
  readonly iss: string;
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
  readonly roles: readonly string[];
  readonly idToken: string;
  readonly linkToUserId?: string;
}

export class OidcError extends Error {}

/**
 * The one refusal a person can act on: an account already holds the address, so the identity must
 * be attached deliberately rather than matched to it. Separate from `OidcError` because only this
 * case should offer to finish the linking — a bad state or a mismatched issuer must not.
 */
export class IdentityCollision extends OidcError {}

/**
 * Discover the provider and build a client, or return `null` when it is not configured or not
 * reachable. Never throws: a provider that is down is a Foreman that offers one login button
 * instead of two, not a Foreman that will not start.
 */
export async function createOidcClient(config: Config): Promise<OidcClient | null> {
  if (!config.oidcConfigured) return null;

  const issuer = config.D3AUTH_ISSUER ?? '';
  const redirectUri = new URL('/auth/oidc/callback', config.BASE_URL).toString();

  let client: AuthClient;
  try {
    client = await createAuthClient({
      issuer,
      clientId: config.D3AUTH_CLIENT_ID ?? '',
      clientSecret: config.D3AUTH_CLIENT_SECRET ?? '',
      redirectUri,
      // `d3:roles` is what makes the roles claim appear at all.
      scope: 'openid profile email d3:roles',
      // Optional, never required: the password path must keep working without this (FRM-REQ-017).
      ssoMode: 'optional',
      ...(issuer.startsWith('http://') ? { allowInsecureHttp: true } : {}),
    });
  } catch (error) {
    logger.warn(
      { issuer, err: error instanceof Error ? error.message : String(error) },
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
    issuer,

    async beginSignIn(linkToUserId) {
      sweep();
      const start = await client.beginSignIn();
      const tx = randomBytes(32).toString('base64url');

      pending.set(tx, {
        verifier: start.verifier,
        state: start.state,
        nonce: start.nonce,
        expiresAt: Date.now() + TRANSACTION_TTL_MS,
        ...(linkToUserId !== undefined ? { linkToUserId } : {}),
      });
      return { url: start.url, tx };
    },

    async completeSignIn(callbackUrl, tx, state) {
      const started = pending.get(tx);
      pending.delete(tx);

      // This browser started it, and it is the sign-in it started. Anything else is refused —
      // which is what makes a pasted callback URL useless. The SDK checks state, nonce, PKCE and
      // the issuer; this check is about *which browser*, which only Foreman knows.
      if (started === undefined) throw new OidcError('no sign-in is in progress for this browser');
      if (started.expiresAt <= Date.now()) throw new OidcError('the sign-in took too long');
      if (started.state !== state) throw new OidcError('state did not match');

      let session;
      try {
        session = await client.completeSignIn(callbackUrl, {
          verifier: started.verifier,
          state: started.state,
          nonce: started.nonce,
        });
      } catch (error) {
        // The SDK's refusals — a bad issuer, a replayed nonce, a failed PKCE — become the one
        // error type the routes already know how to answer with.
        throw new OidcError(error instanceof Error ? error.message : String(error));
      }

      const { identity } = session;
      const email = typeof identity.claims['email'] === 'string' ? identity.claims['email'] : undefined;
      const name = typeof identity.claims['name'] === 'string' ? identity.claims['name'] : undefined;

      return {
        iss: identity.iss,
        sub: identity.sub,
        ...(email === undefined ? {} : { email }),
        ...(name === undefined ? {} : { name }),
        roles: identity.roles,
        idToken: session.idToken,
        ...(started.linkToUserId !== undefined ? { linkToUserId: started.linkToUserId } : {}),
      };
    },

    async endSessionUrl(idToken, returnTo) {
      try {
        return await client.endSessionUrl({ idToken, returnTo });
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
 * inherits the account. `identityKey` is the SDK's own spelling of that rule.
 */
export async function resolveIdentity(
  db: Db,
  completed: CompletedSignIn,
): Promise<{ userId: string; created: boolean }> {
  // Asserted rather than assumed: if the SDK ever composed this differently, the join below would
  // silently start matching the wrong rows.
  const key = identityKey({ iss: completed.iss, sub: completed.sub });
  if (!key.includes(completed.sub)) {
    throw new OidcError('the identity key no longer contains the subject');
  }

  const existing = await db.identity.findUnique({
    where: { iss_sub: { iss: completed.iss, sub: completed.sub } },
  });

  if (existing !== null) {
    await db.identity.update({
      where: { id: existing.id },
      data: {
        lastLoginAt: new Date(),
        claims: { email: completed.email ?? null, roles: [...completed.roles] },
      },
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
        claims: { email: completed.email ?? null, roles: [...completed.roles] },
      },
    });
    return { userId: completed.linkToUserId, created: false };
  }

  // An account already holds this email, and no identity links to it. Adopting it here — "same
  // address, must be the same person" — is exactly the email-matching this design forbids, and it
  // is an account takeover for anyone who can make D3 Auth assert an address. So: refuse, and say
  // how to do it deliberately. Signing in with the password and linking from there proves control
  // of both sides, which arriving with a matching claim does not.
  if (completed.email !== undefined) {
    const taken = await db.user.findUnique({ where: { email: completed.email } });
    if (taken !== null) {
      throw new IdentityCollision(
        `An account already exists for ${completed.email}. Sign in with your password below and ` +
          'the link will finish automatically — Foreman never joins the two by email alone.',
      );
    }
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
          claims: { email: completed.email ?? null, roles: [...completed.roles] },
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
