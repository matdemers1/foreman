import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFUSED_EVENTS } from '../../src/routes/webhooks.js';

/**
 * FRM-REQ-099 — Foreman does not ingest pull requests. Ever.
 *
 * An anti-feature recorded as a requirement asserting its own absence, so it cannot quietly
 * arrive. Foreman ingests what **landed**: a PR is a conversation about work, a commit is work.
 * Ingesting PRs would bring reviews, comments, statuses and mergeability with it, and the product
 * would have become a general issue tracker without anybody deciding to build one.
 *
 * The check is structural rather than a promise in a document: no table, no route, no handler.
 */

const SERVER_SRC = resolve(import.meta.dirname, '../../src');
const SCHEMA = resolve(import.meta.dirname, '../../prisma/schema.prisma');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    // Prisma's generated client mentions everything; it is not hand-written surface.
    if (entry === 'generated' || entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('no pull-request ingestion (FRM-REQ-099)', () => {
  it('has no pull-request table', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    const models = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);

    expect(models).not.toContain('PullRequest');
    expect(models).not.toContain('Review');
    // And no column smuggling one in under another name.
    expect(schema).not.toMatch(/pull_request/i);
  });

  it('names the events it refuses, so the refusal is readable', () => {
    expect(REFUSED_EVENTS).toContain('pull_request');
    expect(REFUSED_EVENTS).toContain('pull_request_review');
  });

  it('has no handler for a pull-request webhook', () => {
    // The receiver's allow-list is a `Set` of handled events; anything outside it is acknowledged
    // and dropped. This asserts the handler does not exist, not merely that it is unreachable.
    const webhooks = readFileSync(join(SERVER_SRC, 'routes/webhooks.ts'), 'utf8');
    const handled = /const HANDLED = new Set\(\[([^\]]*)\]\)/.exec(webhooks)?.[1] ?? '';

    expect(handled).not.toMatch(/pull_request/);
    expect(handled).toMatch(/push/);
  });

  it('has no route, query or job that mentions a pull request', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SERVER_SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        // The anti-feature is allowed to be *named* — in the list of refused events, and in the
        // comments explaining why it is absent. What is not allowed is code that acts on one.
        const mentions = /pull.?request|\bPR\b/i.test(line);
        if (!mentions) continue;

        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        const isRefusalList = /REFUSED_EVENTS|pull_request_review|'pull_request'/.test(line);
        if (isComment || isRefusalList) continue;

        offenders.push(`${file.replace(SERVER_SRC, 'src')}:${String(index + 1)}  ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `these lines act on pull requests, which Foreman does not ingest (FRM-REQ-099):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
