import { createPrivateKey, createSign } from 'node:crypto';
import type { Config } from '../config.js';

/**
 * The GitHub App client (T-5.1, FRM-REQ-093, FRM-REQ-094).
 *
 * **An App, not a personal token.** Check-run data is not retrievable with a PAT, and a PAT is a
 * credential tied to a person rather than to an installation that can be revoked on its own.
 *
 * The risk this file exists to handle is R-12: **installation tokens expire in an hour.** The
 * failure mode is not "it breaks" — it is "it works all afternoon and then quietly 401s at some
 * point overnight", which is discovered days later as missing commits. So the token is refreshed
 * *before* it expires, with a margin, and there is no code path that uses one without checking.
 *
 * No SDK: the App JWT is a signed pair of base64url objects, and the four calls needed here are
 * `fetch`. A dependency that ships its own HTTP stack, retry policy and auth cache is a lot of
 * surface for that.
 */

const API = 'https://api.github.com';
const UA = 'foreman (https://foreman.d3cloud.io)';

/**
 * Refresh this long before the token actually expires.
 *
 * Five minutes rather than a few seconds: the margin has to cover a long backfill that took the
 * token at minute 59, plus clock skew between here and GitHub. GitHub's own guidance is to treat
 * these as short-lived and re-request freely — they are cheap.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The App JWT's own lifetime. GitHub refuses anything over ten minutes. */
const APP_JWT_TTL_S = 9 * 60;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Not configured is a normal state: a clone with no GitHub App still runs (FRM-REQ-017's spirit). */
export class GitHubNotConfigured extends Error {
  constructor() {
    super(
      'the GitHub App is not configured — set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and ' +
        'GITHUB_APP_INSTALLATION_ID',
    );
    this.name = 'GitHubNotConfigured';
  }
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/**
 * A GitHub App JWT: `{alg:RS256,typ:JWT}.{iat,exp,iss}` signed with the App's private key.
 *
 * `iat` is backdated by a minute. GitHub rejects a token whose `iat` is in the future by its own
 * clock, and a host running a few seconds fast is not a configuration error anybody will diagnose.
 */
export function appJwt(appId: string, privateKeyPem: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + APP_JWT_TTL_S, iss: appId }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();

  // `createPrivateKey` first, so a malformed key fails here with a clear error rather than
  // producing a signature GitHub silently rejects.
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface GitHubClient {
  /** A GET against the API, with the installation token refreshed if it is close to expiring. */
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  /** Every page of a paginated endpoint, following `Link: rel="next"`. */
  paginate<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T[]>;
  /** Exposed so a test can assert the refresh happened, and for the health screen. */
  tokenExpiresAt(): Date | null;
}

export interface GitHubClientOptions {
  readonly config: Pick<
    Config,
    'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_APP_INSTALLATION_ID'
  >;
  /** Swapped in tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export function isConfigured(
  config: Pick<Config, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'GITHUB_APP_INSTALLATION_ID'>,
): boolean {
  return (
    config.GITHUB_APP_ID !== undefined &&
    config.GITHUB_APP_PRIVATE_KEY !== undefined &&
    config.GITHUB_APP_INSTALLATION_ID !== undefined
  );
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const { config } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const fallbackInstallation = config.GITHUB_APP_INSTALLATION_ID ?? '';

  /** One token per installation: a personal account and an organization are separate installs. */
  const cached = new Map<string, InstallationToken>();
  /** In flight, so a burst of parallel stages mints one token rather than eight. */
  const refreshing = new Map<string, Promise<InstallationToken>>();
  /** Owner (lower-cased) → its installation, looked up once per process. */
  const installationOf = new Map<string, Promise<string>>();

  function jwt(): string {
    if (!isConfigured(config)) throw new GitHubNotConfigured();
    return appJwt(
      config.GITHUB_APP_ID ?? '',
      // A key pasted into an env var usually arrives with literal \n. Both forms have to work,
      // because the one that does not is a five-minute outage and a confusing error.
      (config.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      now(),
    );
  }

  const appHeaders = () => ({
    authorization: `Bearer ${jwt()}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': UA,
  });

  async function mint(installation: string): Promise<InstallationToken> {
    const url = `${API}/app/installations/${installation}/access_tokens`;
    const res = await doFetch(url, { method: 'POST', headers: appHeaders() });

    if (!res.ok) {
      throw new GitHubError(res.status, `could not mint an installation token: ${await res.text()}`, url);
    }

    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }

  async function token(installation: string): Promise<string> {
    const current = cached.get(installation);
    // The whole of R-12 in one condition: refresh *before* expiry, never after a 401.
    if (current !== undefined && current.expiresAt.getTime() - now().getTime() > REFRESH_MARGIN_MS) {
      return current.token;
    }

    let pending = refreshing.get(installation);
    if (pending === undefined) {
      pending = mint(installation)
        .then((fresh) => {
          cached.set(installation, fresh);
          return fresh;
        })
        .finally(() => {
          refreshing.delete(installation);
        });
      refreshing.set(installation, pending);
    }
    return (await pending).token;
  }

  /**
   * The installation that covers a `/repos/{owner}/{repo}/…` path (GL-006).
   *
   * The App is installed once per account, and a repository transferred from a personal account to
   * an organization moves to the organization's installation. One configured installation id
   * would therefore reach only the repos still on one side, and during a migration they are on
   * both. So the owner's installation is asked for once (`GET /repos/{owner}/{repo}/installation`,
   * signed with the App JWT) and remembered. Anything that is not a repo path, or a repo the App
   * cannot see (404), uses the configured installation, which is what every call used before.
   */
  async function installationFor(path: string): Promise<string> {
    if (!isConfigured(config)) throw new GitHubNotConfigured();
    const match = /^\/repos\/([^/]+)\/([^/?#]+)/.exec(path);
    if (match === null) return fallbackInstallation;
    const [, owner = '', repo = ''] = match;

    const key = owner.toLowerCase();
    let found = installationOf.get(key);
    if (found === undefined) {
      found = (async () => {
        const url = `${API}/repos/${owner}/${repo}/installation`;
        const res = await doFetch(url, { headers: appHeaders() });
        if (res.status === 404) return fallbackInstallation;
        if (!res.ok) {
          throw new GitHubError(res.status, `could not find the installation for ${owner}: ${await res.text()}`, url);
        }
        const body = (await res.json()) as { id?: number };
        return body.id === undefined ? fallbackInstallation : String(body.id);
      })();
      // A failed lookup is not remembered, so the next call tries again rather than failing forever.
      found.catch(() => installationOf.delete(key));
      installationOf.set(key, found);
    }
    return found;
  }

  async function request(
    installation: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await doFetch(url.toString(), {
      headers: {
        authorization: `Bearer ${await token(installation)}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': UA,
      },
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new GitHubError(
        res.status,
        // Rate limiting reads as a mystery 403 unless it is named.
        res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
          ? `rate limited until ${res.headers.get('x-ratelimit-reset') ?? 'unknown'}`
          : detail.slice(0, 500),
        url.toString(),
      );
    }
    return res;
  }

  return {
    async get<T>(path: string, query?: Record<string, string | number | undefined>) {
      return (await (await request(await installationFor(path), path, query)).json()) as T;
    },

    async paginate<T>(path: string, query?: Record<string, string | number | undefined>) {
      const out: T[] = [];
      // Resolved from the first path and kept: GitHub's `next` links can name the repository by
      // id (`/repositories/123/commits?page=2`), which says nothing about its owner.
      const installation = await installationFor(path);
      let next: string | null = path;
      let params: Record<string, string | number | undefined> = { per_page: 100, ...query };

      while (next !== null) {
        const res = await request(installation, next, params);
        const page = (await res.json()) as T[];
        out.push(...page);

        // The `Link` header carries the whole next URL, parameters included, so subsequent pages
        // must not re-apply ours — that is how a paginator loops on page one forever.
        next = parseNextLink(res.headers.get('link'));
        params = {};
      }
      return out;
    },

    // The configured installation's token is the one the health screen has always shown.
    tokenExpiresAt: () =>
      cached.get(fallbackInstallation)?.expiresAt ??
      [...cached.values()].map((t) => t.expiresAt).sort((a, b) => a.getTime() - b.getTime())[0] ??
      null,
  };
}

/** `<https://api.github.com/...>; rel="next", <...>; rel="last"` → the next URL, or null. */
export function parseNextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}
