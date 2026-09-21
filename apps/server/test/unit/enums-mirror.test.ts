import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as shared from '@foreman/shared';

/**
 * The Prisma enums mirror `packages/shared/src/enums.ts` value for value (FRM-REQ-003).
 *
 * This is listed as a non-negotiable and was, until now, enforced by nobody. It drifted the first
 * time it was tested: `idea` was added to the Prisma `EntityType` and not to the shared one, and
 * every gate stayed green — because the two are used in different places. Prisma's enum is what
 * the column accepts; the shared enum is what the API validates and what the MCP tool schemas are
 * generated from. A value in one and not the other is a row the database will hold and a surface
 * will not name, which surfaces as a validation error on data that is already stored.
 *
 * Reading the schema text rather than the generated client is deliberate: the schema is the thing
 * a person edits, and a stale generated client would make this test agree with itself.
 */

const SCHEMA = readFileSync(
  fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
  'utf8',
);

/** Every `enum Name { … }` in the schema, as a name and its values in declaration order. */
function prismaEnums(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of SCHEMA.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const [, name, body] = match;
    if (name === undefined || body === undefined) continue;
    const values = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      // A Prisma enum value is a bare identifier; `///` doc comments and blanks are not.
      .filter((line) => /^\w+$/.test(line));
    found.set(name, values);
  }
  return found;
}

/** The zod enum exported under a name, if there is one. */
function sharedValues(name: string): readonly string[] | null {
  const exported = (shared as Record<string, unknown>)[name];
  const options = (exported as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? (options as string[]) : null;
}

describe('the Prisma enums and the shared enums', () => {
  const enums = prismaEnums();

  it('finds the enums at all, so an empty pass cannot look like agreement', () => {
    // Without this, a regex that stopped matching would turn every assertion below into a
    // vacuous truth and the suite would go green while checking nothing.
    expect(enums.size).toBeGreaterThan(15);
    expect(enums.get('EntityType')).toContain('idea');
  });

  for (const [name, values] of prismaEnums()) {
    const expected = sharedValues(name);

    it(`${name} agrees, value for value and in order`, () => {
      // Skipped rather than failed only when `packages/shared` has no such enum: a few Prisma
      // enums are storage detail with no surface. Named here so adding one is a decision.
      if (expected === null) {
        expect(
          [
            // Authentication and throttling are the server's own business: no API surface takes
            // one of these as input and no MCP schema names them, so there is nothing to mirror.
            'AuthMethod',
            'UserStatus',
            'ThrottleScope',
            // One Postgres enum backing two zod ones — `RiskLikelihood` and `RiskImpact` are the
            // same three values used for different axes, and the table stores both as `RiskLevel`.
            'RiskLevel',
          ],
          `${name} has no counterpart in packages/shared — add one, or list it here`,
        ).toContain(name);
        return;
      }
      expect(values).toEqual([...expected]);
    });
  }
});
