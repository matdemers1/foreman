import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequirementQuery } from '../../src/routes/projects.js';

/**
 * S-13's filters, read the way Express hands them over: strings, always.
 *
 * The bug this exists for: `z.coerce.boolean()` on `'false'` is **true**, because every non-empty
 * string is truthy. `?uncovered=false` asked for covered requirements and would have returned
 * precisely the uncovered ones — a filter that silently answers the opposite question.
 */

describe('the uncovered filter is tri-state, and the third state is the trap', () => {
  it('reads true as true', () => {
    expect(RequirementQuery.parse({ uncovered: 'true' }).uncovered).toBe(true);
  });

  it('reads false as FALSE, which coercion did not', () => {
    expect(RequirementQuery.parse({ uncovered: 'false' }).uncovered).toBe(false);
    // The line that would have failed before: Boolean('false') === true.
    expect(z.coerce.boolean().parse('false')).toBe(true);
  });

  it('leaves it undefined when the filter is absent, which is "either"', () => {
    expect(RequirementQuery.parse({}).uncovered).toBeUndefined();
  });

  it('refuses anything else rather than guessing', () => {
    // `?uncovered=1` and `?uncovered=yes` are a caller who believes something about this API that
    // is not true. Saying so beats picking an interpretation.
    for (const value of ['1', '0', 'yes', '', 'TRUE']) {
      expect(RequirementQuery.safeParse({ uncovered: value }).success, value).toBe(false);
    }
  });
});

describe('the rest of the filters', () => {
  it('takes a phase ID or the literal backlog', () => {
    expect(RequirementQuery.parse({ phase: 'BND-P-3' }).phase).toBe('BND-P-3');
    expect(RequirementQuery.parse({ phase: 'none' }).phase).toBe('none');
  });

  it('refuses a priority outside MoSCoW', () => {
    expect(RequirementQuery.safeParse({ priority: 'M' }).success).toBe(true);
    expect(RequirementQuery.safeParse({ priority: 'urgent' }).success).toBe(false);
  });

  it('defaults the page size rather than returning everything', () => {
    expect(RequirementQuery.parse({}).limit).toBe(50);
    expect(RequirementQuery.safeParse({ limit: '10000' }).success).toBe(false);
  });
});
