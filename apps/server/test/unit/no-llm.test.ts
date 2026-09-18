import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterHosts, FORBIDDEN_LLM_HOSTS } from '../../src/adapters/index.js';

/**
 * FRM-REQ-013 — Foreman never calls an LLM from the server.
 *
 * This is a never-regress test, not a style check. Foreman's whole premise is that Claude is its
 * *user* and not its dependency: the day an AI SDK lands in a `package.json`, the product has
 * quietly become something else. Fail loudly instead.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Package names that mean "this process can talk to a model". */
const AI_SDK_PATTERNS = [
  /^@anthropic-ai\//,
  /^anthropic$/,
  /^openai$/,
  /^@openai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^@mistralai\//,
  /^cohere-ai$/,
  /^@aws-sdk\/client-bedrock/,
  /^replicate$/,
  /^groq-sdk$/,
  /^ollama$/,
  /^langchain$/,
  /^@langchain\//,
  /^llamaindex$/,
  /^ai$/, // Vercel AI SDK
];

/** The MCP SDK is the *opposite* of a dependency on a model: it is how Claude reaches Foreman. */
const ALLOWED = new Set(['@modelcontextprotocol/sdk']);

function packageJsonPaths(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) packageJsonPaths(path, found);
    else if (entry === 'package.json') found.push(path);
  }
  return found;
}

describe('no LLM on the server (FRM-REQ-013)', () => {
  const manifests = packageJsonPaths(REPO_ROOT);

  it('finds every workspace manifest, so the check cannot pass by looking at nothing', () => {
    expect(manifests.length).toBeGreaterThanOrEqual(6);
  });

  it.each(manifests)('%s declares no AI SDK', (path) => {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ].filter((name) => !ALLOWED.has(name));

    const offenders = declared.filter((name) => AI_SDK_PATTERNS.some((re) => re.test(name)));
    expect(offenders, `${path} may not depend on a model provider`).toEqual([]);
  });

  it('lists no LLM host among the outbound adapters', () => {
    const hosts = adapterHosts();
    for (const forbidden of FORBIDDEN_LLM_HOSTS) {
      expect(hosts).not.toContain(forbidden);
    }
  });

  it('gives every adapter exactly one host and a stated purpose', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.host).toMatch(/^[a-z0-9.-]+$/);
      expect(adapter.purpose.length).toBeGreaterThan(0);
    }
  });
});
