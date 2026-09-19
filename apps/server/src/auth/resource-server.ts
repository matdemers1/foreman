import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../config.js';

/**
 * Foreman as an OAuth 2.1 resource server (ADR-013).
 *
 * The remote MCP endpoint is a **public endpoint holding every project's internals**, which is the
 * cost ADR-013 accepted. What keeps that honest is one check the spec states twice: a token is
 * only acceptable if it was issued *for Foreman*.
 *
 *   > MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST**
 *   > reject tokens that do not include them in the audience claim.
 *
 * Without it, any token D3 Auth ever issued — for Bindery, for the console, for anything added
 * later — would open Foreman. That is not a Foreman bug, it is a cross-service compromise, so the
 * audience check is not optional and not configurable.
 */

export class TokenRejected extends Error {}

export interface ResourceToken {
  readonly sub: string;
  readonly iss: string;
  readonly scopes: readonly string[];
  readonly email: string | undefined;
}

/**
 * The canonical URI of this MCP server (RFC 8707 §2), and the audience every token must carry.
 * Derived from BASE_URL rather than configured separately: two sources for one identity is how
 * they come to disagree.
 */
export function canonicalMcpUri(config: Config): string {
  return new URL('/mcp', config.BASE_URL).toString();
}

export interface Verifier {
  verify(token: string): Promise<ResourceToken>;
}

/**
 * Built once and kept: `createRemoteJWKSet` caches the key set and re-fetches on an unknown `kid`,
 * so a rotation costs one fetch rather than a restart. Returns `null` when D3 Auth is not
 * configured, which is the same shape the console's OIDC path uses — a Foreman without a provider
 * offers no remote MCP rather than refusing to start.
 */
export function createVerifier(config: Config): Verifier | null {
  const issuer = config.D3AUTH_ISSUER;
  if (issuer === undefined) return null;

  const jwks = createRemoteJWKSet(new URL('/oidc/jwks', issuer));
  const audience = canonicalMcpUri(config);

  return {
    async verify(token: string): Promise<ResourceToken> {
      let payload: Record<string, unknown>;
      try {
        // `issuer` and `audience` are checked by the library, not by us afterwards: a check that
        // happens after a successful verify is a check somebody can forget to write.
        const verified = await jwtVerify(token, jwks, { issuer, audience });
        payload = verified.payload;
      } catch (error) {
        throw new TokenRejected(error instanceof Error ? error.message : 'the token did not verify');
      }

      const sub = typeof payload['sub'] === 'string' ? payload['sub'] : undefined;
      if (sub === undefined) throw new TokenRejected('the token carries no subject');

      // Space-delimited per RFC 8693 / OAuth 2.1. An absent scope is no scopes, never all of them.
      const raw = typeof payload['scope'] === 'string' ? payload['scope'] : '';
      const scopes = raw.split(' ').filter((s) => s.length > 0);

      return {
        sub,
        iss: issuer,
        scopes,
        email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
      };
    },
  };
}

/**
 * The RFC 9728 document. `authorization_servers` is what the client follows to find D3 Auth, and
 * `resource` must equal the canonical URI the token is bound to — a mismatch here sends clients to
 * ask for an audience Foreman will then reject.
 */
export function protectedResourceMetadata(config: Config): Record<string, unknown> {
  return {
    resource: canonicalMcpUri(config),
    authorization_servers: config.D3AUTH_ISSUER === undefined ? [] : [config.D3AUTH_ISSUER],
    scopes_supported: ['openid', 'profile', 'email', 'd3:roles'],
    bearer_methods_supported: ['header'],
    resource_documentation: new URL('/', config.BASE_URL).toString(),
  };
}

/**
 * The challenge a 401 carries. `resource_metadata` is how a client that guessed nothing still finds
 * the document; the spec lets clients fall back to probing well-known URIs, but only after this.
 */
export function wwwAuthenticate(config: Config, error?: string): string {
  const metadata = new URL('/.well-known/oauth-protected-resource', config.BASE_URL).toString();
  const parts = [`resource_metadata="${metadata}"`, 'scope="openid profile email"'];
  if (error !== undefined) parts.push(`error="${error}"`);
  return `Bearer ${parts.join(', ')}`;
}
