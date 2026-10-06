import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../../src/adapters/github.js';

/**
 * One App, several installations (GL-006, FRM-T-012).
 *
 * The App is installed once per account. While repositories move from matdemers1 to D3Cloud-io
 * they sit under two installations, so the client has to mint a token for the one that covers the
 * repo it is asked about — and a single configured installation id is only the fallback.
 */

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const CONFIGURED = '111';
const ORG_INSTALL = 222;

interface Call {
  readonly method: string;
  readonly url: string;
  readonly auth: string;
}

/** A fake GitHub: D3Cloud-io is its own installation, everything else falls back. */
function fakeGitHub() {
  const calls: Call[] = [];
  const respond = (input: string | URL, init?: RequestInit): Response => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization') ?? '' });

    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });

    const minted = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (minted !== null) {
      return json({ token: `token-${minted[1] ?? ''}`, expires_at: '2099-01-01T00:00:00Z' });
    }
    if (url.endsWith('/repos/D3Cloud-io/foreman/installation')) return json({ id: ORG_INSTALL });
    if (url.endsWith('/installation')) return json({ message: 'Not Found' }, 404);

    if (url.includes('/repos/D3Cloud-io/foreman/commits') && !url.includes('page=2')) {
      return json([{ sha: 'a' }], 200, {
        // GitHub's own next links can name the repository by id rather than by owner.
        link: '<https://api.github.com/repositories/99/commits?page=2>; rel="next"',
      });
    }
    if (url.includes('/repositories/99/commits?page=2')) return json([{ sha: 'b' }]);
    return json({ ok: true });
  };
  const fetchImpl = ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(respond(input, init))) as typeof fetch;

  return { calls, fetchImpl };
}

function client(fetchImpl: typeof fetch) {
  return createGitHubClient({
    config: {
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: PEM,
      GITHUB_APP_INSTALLATION_ID: CONFIGURED,
    },
    fetch: fetchImpl,
    now: () => new Date('2026-10-06T12:00:00Z'),
  });
}

describe('choosing an installation per repository owner', () => {
  it("uses the organization's installation for a repo that moved there", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).get('/repos/D3Cloud-io/foreman/commits/abc');

    const read = calls.find((c) => c.url.includes('/commits/abc'));
    expect(read?.auth).toBe(`Bearer token-${String(ORG_INSTALL)}`);
  });

  it('falls back to the configured installation when the App cannot see the owner', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).get('/repos/matdemers1/bindery/commits/abc');

    const read = calls.find((c) => c.url.includes('/repos/matdemers1/bindery/commits'));
    expect(read?.auth).toBe(`Bearer token-${CONFIGURED}`);
  });

  it('looks each owner up once, and mints one token per installation', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    const github = client(fetchImpl);
    await github.get('/repos/D3Cloud-io/foreman/commits/1');
    await github.get('/repos/D3Cloud-io/foreman/releases');
    await github.get('/repos/d3cloud-io/foreman/commits/2');
    await github.get('/repos/matdemers1/bindery/commits/3');

    const lookups = calls.filter((c) => c.url.endsWith('/installation'));
    // D3Cloud-io once — however it is capitalised — and matdemers1 once.
    expect(lookups).toHaveLength(2);
    const mints = calls.filter((c) => c.url.endsWith('/access_tokens'));
    expect(mints.map((c) => c.url.split('/').at(-2)).sort()).toEqual([CONFIGURED, String(ORG_INSTALL)]);
  });

  it("keeps the first page's installation when the next link names the repo by id", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    const page = await client(fetchImpl).paginate<{ sha: string }>('/repos/D3Cloud-io/foreman/commits');

    expect(page.map((c) => c.sha)).toEqual(['a', 'b']);
    const second = calls.find((c) => c.url.includes('/repositories/99/'));
    expect(second?.auth).toBe(`Bearer token-${String(ORG_INSTALL)}`);
  });

  it('uses the configured installation for anything that is not a repository path', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await client(fetchImpl).get('/rate_limit');

    expect(calls.filter((c) => c.url.endsWith('/installation'))).toHaveLength(0);
    expect(calls.find((c) => c.url.endsWith('/rate_limit'))?.auth).toBe(`Bearer token-${CONFIGURED}`);
  });
});
