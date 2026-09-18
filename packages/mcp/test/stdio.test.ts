import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The binary itself (ADR-003).
 *
 * `index.ts` is four lines and none of the other tests touch it — they build a server in-process.
 * But it is the thing Claude actually launches, and its failure modes are the ones a person meets
 * first: no configuration, and the one rule of stdio.
 */

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHARED_DIST = fileURLToPath(new URL('../../shared/dist/index.js', import.meta.url));

interface RunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Remove the variables entirely rather than passing them through as given. */
  readonly unset?: boolean;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the shim with tsx, feed it something, and collect both streams. */
function run(
  env: Record<string, string>,
  { input = '', timeoutMs = 8000, unset = false }: RunOptions = {},
): Promise<Run> {
  // A developer's own shell may have these set, and a test that only passes on a machine without
  // them is not a test — so start from a copy with both removed.
  const base = { ...process.env };
  delete base['FOREMAN_URL'];
  delete base['FOREMAN_TOKEN'];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      // Node with the tsx loader rather than `npx tsx`: pnpm does not hoist, so `tsx` is only on
      // PATH here by accident of a local install, and CI finds nothing (exit 127).
      cwd: PACKAGE_ROOT,
      env: unset ? { ...base, ...env } : { FOREMAN_URL: '', FOREMAN_TOKEN: '', ...base, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input !== '') child.stdin.write(input);
    child.stdin.end();
  });
}

describe('the stdio entry point', () => {
  beforeAll(() => {
    // A subprocess does not get vitest's aliases: it resolves `@foreman/shared` through the
    // package's own exports, which point at `dist`. Every other test in this repo runs in-process
    // and never needs it built, so on a clean checkout it is not there.
    if (existsSync(SHARED_DIST)) return;
    const built = spawnSync('pnpm', ['--filter', '@foreman/shared', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(built.status, `could not build @foreman/shared: ${built.stderr}`).toBe(0);
  }, 120_000);

  it('refuses to start with no configuration, and names both variables', async () => {
    const result = await run({}, { unset: true });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FOREMAN_URL');
    expect(result.stderr).toContain('FOREMAN_TOKEN');
  }, 20_000);

  it('writes that refusal to stderr and nothing at all to stdout', async () => {
    const result = await run({}, { unset: true });

    // **The one rule of stdio.** stdout is the protocol channel: a stray line there is a parse
    // error at the other end rather than a message anybody reads, and the symptom is a client
    // that fails to connect with no explanation.
    expect(result.stdout).toBe('');
  }, 20_000);

  it('treats a variable that is set but blank as missing', async () => {
    // Regression: `FOREMAN_URL=` passed an `=== undefined` guard and started a server that could
    // never reach a Foreman. A client config with an empty value is common, and the symptom — a
    // shim that connects and then fails every call — is much harder to read than a refusal.
    const result = await run({ FOREMAN_URL: '', FOREMAN_TOKEN: '   ' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FOREMAN_URL');
    expect(result.stdout).toBe('');
  }, 20_000);

  it('refuses with only half the configuration', async () => {
    const half = await run({ FOREMAN_URL: 'https://foreman.d3cloud.io' }, { unset: true });
    expect(half.code).toBe(1);
    expect(half.stdout).toBe('');

    const other = await run({ FOREMAN_TOKEN: 'frm_x' }, { unset: true });
    expect(other.code).toBe(1);
    expect(other.stdout).toBe('');
  }, 30_000);

  it('speaks the protocol on stdout when it is configured', async () => {
    // A real initialize, framed as the SDK frames it. The server should answer on stdout with a
    // JSON-RPC result naming itself — proving the transport is wired, without a Foreman behind it.
    const initialize = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '0.0.0' },
      },
    })}\n`;

    const result = await run(
      { FOREMAN_URL: 'http://127.0.0.1:1', FOREMAN_TOKEN: 'frm_unused' },
      { input: initialize },
    );

    expect(result.stdout, result.stderr).toContain('"jsonrpc":"2.0"');
    expect(result.stdout).toContain('foreman-mcp');
    // Even here: nothing but protocol on stdout.
    expect(result.stdout.split('\n').filter((l) => l.trim() !== '').every((l) => l.startsWith('{'))).toBe(
      true,
    );
  }, 30_000);
});
