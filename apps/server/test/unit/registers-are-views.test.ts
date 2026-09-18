import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-006 — the five registers are views, not documents (FRM-REQ-057, FRM-REQ-074).
 *
 * A never-regress test. The Requirements Register and the Scope of Work were documents in the
 * vault, and both were wrong within a fortnight of being written, because a document is a copy and
 * a copy is only as current as the last person who remembered to update it.
 *
 * The enforcement is not a convention anybody has to keep: **there is no document kind to author
 * one under.** If a kind like `requirements_register` ever appears in the enum, a screen for it
 * follows, and the moment two answers to "what are the requirements" exist they start to disagree.
 */

const SCHEMA = readFileSync(
  resolve(import.meta.dirname, '../../prisma/schema.prisma'),
  'utf8',
);

/** The five that are generated. Each is a query in `coverage.ts` or `views.ts`, not a row. */
const GENERATED_REGISTERS = [
  'requirements_register',
  'scope_of_work',
  'risk_register',
  'glossary',
  'traceability_matrix',
];

describe('the registers cannot be authored', () => {
  const enumBody = /enum DocumentKind \{([^}]*)\}/.exec(SCHEMA)?.[1] ?? '';
  const kinds = enumBody
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('///'));

  it('found the enum, so the assertion below is measured over something', () => {
    expect(kinds.length).toBeGreaterThan(5);
    expect(kinds).toContain('architecture');
  });

  it.each(GENERATED_REGISTERS)('has no `%s` document kind', (register) => {
    expect(kinds).not.toContain(register);
  });

  it('has no ADR kind either — an ADR is an entity, not a section of a document', () => {
    expect(kinds).not.toContain('adr');
    expect(kinds).not.toContain('decision_record');
  });
});
