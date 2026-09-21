import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The innovation board does not leak into the ledger (FRM-ADR-016, FRM-REQ-172).
 *
 * `FRM-REQ-125` and its neighbours record Foreman's anti-features as requirements asserting their
 * absence: no general issue tracking, no assignees, no comments, no multi-user collaboration. The
 * board reverses two of those — **for the ideas surface only**, which is the whole basis on which
 * ADR-016 argues the reversal is not a retreat.
 *
 * That argument is worth exactly as much as its enforcement. A comment table that grows a
 * `requirementId` next quarter turns the plan-vs-reality ledger into the issue tracker it was
 * built not to be, and nothing about that change would look alarming in review — it would look
 * like a small, reasonable extension of a feature that already exists.
 *
 * So: discussion attaches to a project idea and to nothing else, and scoring likewise. This test
 * is the sentence "the board stays in its lane", written where it fails.
 */

const SCHEMA = readFileSync(
  resolve(import.meta.dirname, '../../prisma/schema.prisma'),
  'utf8',
);

/** The body of one model block. */
function model(name: string): string {
  const match = new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(SCHEMA);
  if (match?.[1] === undefined) throw new Error(`no model ${name} in the schema`);
  return match[1];
}

describe('discussion and scoring reach the ideas surface only', () => {
  /** Everything the ledger is made of. A comment on any of these is an issue tracker. */
  const LEDGER = [
    'requirement',
    'task',
    'phase',
    'adr',
    'finding',
    'audit',
    'decision',
    'risk',
    'document',
    'commit',
    'release',
    'deployment',
  ];

  it.each(['IdeaComment', 'IdeaScore'])('%s points at a project idea and nothing else', (name) => {
    const body = model(name);
    expect(body).toMatch(/projectIdeaId\s+String/);

    for (const kind of LEDGER) {
      // `taskId`, `task Task @relation`, and every other spelling of the same mistake.
      const foreign = new RegExp(`\\b${kind}Id\\b`, 'i');
      expect(body, `${name} must not reference a ${kind}`).not.toMatch(foreign);
    }
  });

  it('gives neither of them an assignee or a due date', () => {
    // The other half of FRM-REQ-125: a comment thread plus an assignee plus a due date is a
    // ticketing system that arrived one field at a time.
    for (const name of ['IdeaComment', 'IdeaScore', 'ProjectIdea']) {
      expect(model(name), name).not.toMatch(/assignee/i);
      expect(model(name), name).not.toMatch(/dueDate/i);
      expect(model(name), name).not.toMatch(/\bpriority\b/i);
    }
  });

  it('leaves every ledger model without a comment relation', () => {
    // Read from the other direction, because a relation is declared on both sides and only one of
    // them is in the tables above.
    for (const name of ['Requirement', 'Task', 'Finding', 'Adr', 'Phase']) {
      expect(model(name), `${name} must not carry comments`).not.toMatch(/IdeaComment|comments\s/);
    }
  });

  it('keeps the board behind a mode the deployment chooses', () => {
    // The reversal is scoped to a deployment that asked for it. A solo Foreman that silently grew
    // a members screen would be the anti-features eroding by default rather than by decision.
    const routes = readFileSync(
      resolve(import.meta.dirname, '../../src/routes/board.ts'),
      'utf8',
    );
    expect(routes).toMatch(/FOREMAN_MODE !== 'board'/);
    expect(routes).toMatch(/res\.status\(404\)/);
  });
});
