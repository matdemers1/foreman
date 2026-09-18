import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasPredicate, lintEars, parseEars } from '../src/index.js';

/**
 * The EARS parser (T-3.2), and the tripwire that keeps it honest.
 *
 * The acceptance criterion is not "the parser is correct" — it is **tuned against the real corpus
 * with under a 30% warning rate** (R-11). A parser tuned against invented examples passes its own
 * tests and then fires on every line of somebody's register.
 */

interface Fixture {
  readonly project: string;
  readonly id: string;
  readonly statement: string;
}

const REAL: Fixture[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/real-requirements.json'), 'utf8'),
) as Fixture[];

/** R-11's tripwire. Above this, the lint is noise and people stop reading it. */
const WARNING_RATE_TRIPWIRE = 0.3;

describe('the five patterns, plus complex', () => {
  it.each([
    ['The system shall persist all state in PostgreSQL.', 'ubiquitous'],
    ['While the queue is draining, the system shall report its depth.', 'state'],
    ['When a webhook arrives, the system shall enqueue it.', 'event'],
    ['If the issuer is unreachable, then the system shall accept a password.', 'unwanted'],
    ['Where the tunnel overlay is applied, the system shall serve the console.', 'optional'],
    ['While ingest is running, when a commit arrives, the system shall attribute it.', 'complex'],
  ])('classifies %s as %s', (statement, pattern) => {
    const result = parseEars(statement);
    expect(result.pattern).toBe(pattern);
    expect(result.ok).toBe(true);
  });
});

describe('the modal is recorded, not demanded', () => {
  it('reads "shall" and "must" as an explicit obligation', () => {
    expect(parseEars('The system shall store the hash.').modal).toBe('explicit');
    expect(parseEars('The system must store the hash.').modal).toBe('explicit');
  });

  it('accepts the indicative, which is how most of the real corpus is written', () => {
    // Bindery's 210 requirements are written this way, and exactly one of them says "shall".
    const result = parseEars('Original bytes are stored content-addressed by SHA-256.');
    expect(result.ok).toBe(true);
    expect(result.pattern).toBe('ubiquitous');
    expect(result.modal).toBe('implicit');
  });

  it('accepts the imperative, which is how Burrow is written', () => {
    const result = parseEars('Prune read-state older than 90 days.');
    expect(result.ok).toBe(true);
    expect(result.modal).toBe('implicit');
  });

  it('accepts a prohibition, which is a requirement stated as an absence', () => {
    expect(parseEars('No telemetry or analytics.').ok).toBe(true);
    expect(parseEars('An administrator cannot read a document outside their library.').ok).toBe(true);
  });

  it('accepts a plural subject, which takes the base form', () => {
    expect(parseEars('Saved searches persist as smart shelves.').ok).toBe(true);
  });
});

describe('what it warns about — and it is not style', () => {
  it('flags a statement that names a feature instead of stating a behaviour', () => {
    // The warning that earns the lint its keep: nothing can be tested against a noun phrase.
    for (const naming of [
      'Per-user recovery codes',
      'Supported input types: PDF, JPEG, PNG, TIFF, HEIC',
      'Semantic search as the primary retrieval path',
      'Device Authorization Grant (RFC 8628)',
    ]) {
      const result = parseEars(naming);
      expect(result.ok, naming).toBe(false);
      expect(result.note, naming).toContain('names a feature');
    }
  });

  it('flags two obligations wearing one ID', () => {
    const result = parseEars('The system shall store the hash and shall email the operator.');
    expect(result.ok).toBe(false);
    expect(result.note).toContain('more than one obligation');
  });

  it('flags an If with no then, and a clause with no comma', () => {
    expect(parseEars('If the disk fills the system shall stop writing.').note).toContain('then');
    expect(parseEars('While draining the system shall report depth.').note).toContain('comma');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '   ', '🙂', 'shall', '```', '| | |', 'a'.repeat(5000)]) {
      expect(() => parseEars(input)).not.toThrow();
    }
  });

  it('never rejects: a warned requirement still has a pattern and is still storable', () => {
    const result = lintEars('Per-user recovery codes');
    expect(result.ok).toBe(false);
    expect(result.pattern).toBe('unparsed');
    // `unparsed` is a legal stored state, not a refusal (FRM-REQ-051, FRM-REQ-052).
  });
});

describe('the predicate check', () => {
  it('sees a behaviour', () => {
    expect(hasPredicate('The system stores the hash')).toBe(true);
    expect(hasPredicate('Bytes are stored')).toBe(true);
    expect(hasPredicate('Prune old state')).toBe(true);
  });

  it('does not mistake a citation or a code span for one', () => {
    // `is` inside backticks is not the statement's verb.
    expect(hasPredicate('Field `is_active` on the row')).toBe(false);
    expect(hasPredicate('Device Authorization Grant (RFC 8628)')).toBe(false);
  });
});

describe('the real corpus — the tripwire (R-11)', () => {
  it('loaded the fixtures, so the rate below is not measured over nothing', () => {
    expect(REAL.length).toBeGreaterThan(500);
    expect(new Set(REAL.map((r) => r.project)).size).toBeGreaterThanOrEqual(4);
  });

  it('warns on under 30% of the real requirements', () => {
    const warned = REAL.filter((r) => !parseEars(r.statement).ok);
    const rate = warned.length / REAL.length;

    expect(
      rate,
      `warned on ${String(warned.length)} of ${String(REAL.length)} real requirements ` +
        `(${(rate * 100).toFixed(1)}%). Above ${String(WARNING_RATE_TRIPWIRE * 100)}% the lint is ` +
        'noise, and noise teaches people to ignore the warnings that matter.',
    ).toBeLessThan(WARNING_RATE_TRIPWIRE);
  });

  it('warns on *something*, because a lint that never fires means nothing', () => {
    // The other half of the tripwire. Tuning until the rate is zero would pass the test above and
    // destroy the reason for having it.
    const warned = REAL.filter((r) => !parseEars(r.statement).ok);
    expect(warned.length).toBeGreaterThan(20);
  });

  it('no single register is mostly warnings', () => {
    // The first version was under 60% overall while warning on 100% of two projects. An average
    // hides that; a per-register check does not.
    const byProject = new Map<string, { total: number; warned: number }>();
    for (const row of REAL) {
      const seen = byProject.get(row.project) ?? { total: 0, warned: 0 };
      seen.total += 1;
      if (!parseEars(row.statement).ok) seen.warned += 1;
      byProject.set(row.project, seen);
    }

    for (const [project, counts] of byProject) {
      const rate = counts.warned / counts.total;
      expect(rate, `${project}: ${(rate * 100).toFixed(1)}% warned`).toBeLessThan(0.5);
    }
  });

  it('classifies most of the corpus as ubiquitous, which is what it is', () => {
    const patterns = REAL.map((r) => parseEars(r.statement).pattern);
    const ubiquitous = patterns.filter((p) => p === 'ubiquitous').length;
    // Most requirements are unconditional. A parser finding conditionals everywhere is guessing.
    expect(ubiquitous / REAL.length).toBeGreaterThan(0.6);
  });
});
