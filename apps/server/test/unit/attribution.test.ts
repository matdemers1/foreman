import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIDENCE, parseCitations } from '../../src/domain/attribution.js';

/**
 * Commit-message parsing, measured against **real commit subjects** (T-5.7, FRM-REQ-107).
 *
 * The plan's second signal was justified by a measurement — 56% of Bindery's commits and 65% of
 * D3 Auth's cite a task ID — so the test that matters is not "does the regex work on an example I
 * wrote" but "does it hit on the corpus that measurement came from".
 */

interface Fixture {
  readonly repo: string;
  readonly sha: string;
  readonly subject: string;
}

const REAL: Fixture[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/real-commits.json'), 'utf8'),
) as Fixture[];

/** Project codes for the repos in the fixture, as Foreman would assign them. */
const CODE: Record<string, string> = { bindery: 'BND', 'd3-auth': 'AUTH', foreman: 'FRM' };

const citationsIn = (fixture: Fixture) =>
  parseCitations(fixture.subject, CODE[fixture.repo] ?? 'XXX');

describe('what a commit message cites', () => {
  it('reads the bare form, which is the only form anybody actually writes', () => {
    // Not one real commit in three repositories writes `BND-T-13.9`. They all write `T-13.9`,
    // because the person typing knows which repository they are in.
    const cited = parseCitations('Guard the rule that could delete the archive (T-13.9)', 'BND');
    expect(cited).toEqual([{ humanId: 'BND-T-13.9', explicit: false }]);
  });

  it('reads the prefixed form too, and marks it as explicit', () => {
    expect(parseCitations('Fix BND-T-13.9', 'BND')).toEqual([
      { humanId: 'BND-T-13.9', explicit: true },
    ]);
  });

  it('ignores a prefixed ID belonging to another project', () => {
    // A cross-reference to another project's decision is not this commit's work.
    expect(parseCitations('As decided in AUTH-ADR-002, swap the client', 'BND')).toEqual([]);
  });

  it('pads a requirement sequence but never a dotted task', () => {
    expect(parseCitations('Satisfies REQ-7', 'BND')[0]?.humanId).toBe('BND-REQ-007');
    expect(parseCitations('Finishes T-13.9', 'BND')[0]?.humanId).toBe('BND-T-13.9');
    expect(parseCitations('Finishes T-4', 'BND')[0]?.humanId).toBe('BND-T-4');
  });

  it('finds several citations in one subject', () => {
    const cited = parseCitations(
      'The vault boundary, before anything can create a vaulted row (T-16.1 to T-16.4, T-16.11)',
      'BND',
    );
    expect(cited.map((c) => c.humanId)).toEqual([
      'BND-T-16.1',
      'BND-T-16.4',
      'BND-T-16.11',
    ]);
  });

  it('does not read a version number as a task', () => {
    // The corpus is full of these, and each false hit is a proposal somebody has to reject.
    for (const subject of [
      'Bump vite from 7.3.6 to 8.2.2',
      'Release v1.2.0',
      'Fix the 2-3 second delay',
      'Upgrade to Postgres 16',
    ]) {
      expect(parseCitations(subject, 'BND'), subject).toEqual([]);
    }
  });

  it('never throws, whatever the subject is', () => {
    for (const subject of ['', '   ', '🙂', 'T-', 'REQ-', '```', 'a'.repeat(5000)]) {
      expect(() => parseCitations(subject, 'BND')).not.toThrow();
    }
  });
});

describe('the real corpus (RT-02)', () => {
  it('loaded the fixtures, so the rate below is not measured over nothing', () => {
    expect(REAL.length).toBeGreaterThan(250);
    expect(new Set(REAL.map((r) => r.repo)).size).toBe(3);
  });

  it('hits on D3 Auth, where the plan measured 65%', () => {
    const rows = REAL.filter((r) => r.repo === 'd3-auth');
    const hit = rows.filter((r) => citationsIn(r).length > 0);
    const rate = hit.length / rows.length;

    // Measured now at ~55% over human-authored commits. The plan's 65% counted differently; what
    // matters is that the signal is real and large, and it is.
    expect(
      rate,
      `cited on ${String(hit.length)} of ${String(rows.length)} D3 Auth commits (${(rate * 100).toFixed(0)}%)`,
    ).toBeGreaterThan(0.45);
  });

  it('hits on Bindery — at a far lower rate than the plan recorded', () => {
    const rows = REAL.filter((r) => r.repo === 'bindery');
    const hit = rows.filter((r) => citationsIn(r).length > 0);
    const rate = hit.length / rows.length;

    // **The plan says 56% for Bindery. It is 19%.** The signal is real but much weaker here, which
    // is exactly why agent-declared attribution is signal 1 rather than a nicety — and why R-02's
    // tripwire (under 50% attributed) would fire on message parsing alone.
    expect(rate).toBeGreaterThan(0.15);
    expect(rate).toBeLessThan(0.35);
  });

  it('parses a citation out of every subject that contains one', () => {
    // A crude independent check: anything that looks like an ID to a person should be found.
    const looksCited = REAL.filter((r) => /(?<![A-Z0-9-])(T|REQ)-\d/.test(r.subject));
    const parsed = looksCited.filter((r) => citationsIn(r).length > 0);
    expect(parsed.length).toBe(looksCited.length);
  });

  it('proposes nothing for the commits that cite nothing, rather than guessing', () => {
    const quiet = REAL.filter((r) => citationsIn(r).length === 0);
    // Roughly half the corpus. Those commits are what the agent-declared signal and the
    // unattributed-commit screen (FRM-REQ-110) exist for — not something to infer a task from.
    expect(quiet.length).toBeGreaterThan(100);
  });
});

describe('precedence is a property of the numbers, not of the order things ran', () => {
  it('ranks declared above message above file overlap', () => {
    expect(CONFIDENCE.declared).toBeGreaterThan(CONFIDENCE.message);
    expect(CONFIDENCE.message).toBeGreaterThan(CONFIDENCE.file_overlap);
  });

  it('keeps file overlap weak enough to read as a hint', () => {
    // Two tasks touching `app.ts` is the normal case. If this ever approaches the message
    // signal, a coincidence starts outranking a statement.
    expect(CONFIDENCE.file_overlap).toBeLessThan(0.5);
  });
});
