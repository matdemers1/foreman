import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FRM-REQ-125 — Foreman provides no general issue or bug tracking.
 *
 * An anti-feature recorded as a requirement asserting its absence. The distinction is narrow and
 * worth stating: a **finding** comes from an audit, has a lens, a severity and a verification
 * verdict, and belongs to a run. An **issue** is anything anybody wants to write down. The first is
 * a managed lifecycle over a bounded corpus; the second is a product nobody asked for, and the
 * fastest way to turn Foreman back into the vault it replaced.
 *
 * Also FRM-REQ-122's structural half: the recurrence engine must reach no model. Its sibling
 * `no-llm.test.ts` guards the dependency list; this guards the one file most tempted to call one.
 */

const SERVER_SRC = resolve(import.meta.dirname, '../../src');
const SCHEMA = resolve(import.meta.dirname, '../../prisma/schema.prisma');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'generated' || entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

describe('no issue tracking (FRM-REQ-125)', () => {
  const schema = readFileSync(SCHEMA, 'utf8');
  const models = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);

  it('has no issue, ticket, bug or story table', () => {
    for (const forbidden of ['Issue', 'Ticket', 'Bug', 'Story', 'Sprint', 'Board', 'Label']) {
      expect(models, `a ${forbidden} table is general issue tracking`).not.toContain(forbidden);
    }
  });

  it('has a finding table, which is the bounded thing it is not', () => {
    // The assertion above means nothing without this one: it has to be possible to tell the
    // feature from its absence.
    expect(models).toContain('Finding');
    expect(models).toContain('Audit');
    // A finding is anchored to a run and a lens; that anchoring is what stops it being an issue.
    expect(schema).toMatch(/model Finding \{[\s\S]*auditId/);
    expect(schema).toMatch(/model Finding \{[\s\S]*lenses/);
  });

  it('has no route that creates a finding outside an audit context', () => {
    // A finding must belong to a project, and is created through it. A top-level `POST /findings`
    // would be an issue tracker's front door.
    const routes = readFileSync(join(SERVER_SRC, 'routes/findings.ts'), 'utf8');
    expect(routes).not.toMatch(/router\.post\(\s*'\/findings'/);
    expect(routes).toMatch(/router\.post\(\s*'\/:code\/findings'/);
  });

  it('never assigns a finding to a person', () => {
    // No assignees is an anti-feature in its own right (FRM-REQ-041): Foreman has one operator,
    // and an assignee field is the first half of a workflow engine.
    expect(schema).not.toMatch(/model Finding \{[\s\S]*assignee/i);
    expect(schema).not.toMatch(/model Finding \{[\s\S]*dueDate/i);
  });
});

describe('recurrence reaches no model (FRM-REQ-122)', () => {
  const recurrence = readFileSync(join(SERVER_SRC, 'domain/recurrence.ts'), 'utf8');

  it('makes no outbound call of any kind', () => {
    // Not "no LLM" — *no network*. The judgement is Claude's to make with the other repository in
    // front of it; Foreman's job is to notice the shape and hand it over.
    for (const forbidden of ['fetch(', 'http.', 'https.', 'axios', 'request(', 'XMLHttpRequest']) {
      expect(recurrence, `recurrence must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports nothing that could reach a network', () => {
    const imports = [...recurrence.matchAll(/^import .*?from '([^']+)';$/gm)].map((m) => m[1]);
    // Only the database and local modules. An import list this short is the proof.
    expect(imports.sort()).toEqual(['../db.js', './errors.js']);
  });

  it('says in its own output that nothing was called', () => {
    // The caller is being handed something to judge. Whoever reads the payload should know no
    // model judged it first, without having to read this file.
    expect(recurrence).toContain('no model was called');
  });

  it('is the only place recurrence is computed', () => {
    // A second implementation elsewhere would not be covered by the checks above.
    const elsewhere = sourceFiles(SERVER_SRC)
      .filter((f) => !f.endsWith('domain/recurrence.ts'))
      .filter((f) => /recurrenc/i.test(readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
      .filter((f) => !/routes\/findings\.ts$/.test(f));

    expect(elsewhere.map((f) => f.replace(SERVER_SRC, 'src'))).toEqual([]);
  });
});
