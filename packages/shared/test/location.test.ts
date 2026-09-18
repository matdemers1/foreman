import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLocation, pathsIn } from '../src/index.js';

/**
 * The location parser, measured against the **real 127 findings** (T-6.3).
 *
 * The plan's example was `api/vault/store.py:196-206,299-310` — one file, two ranges. Written
 * against only that, the parser would have handled 99 of 127 and silently lost a file from each of
 * the other 28.
 */

interface Fixture {
  readonly project: string;
  readonly findingId: string;
  readonly location: string | null;
}

const REAL: Fixture[] = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../apps/server/test/fixtures/real-findings.json'),
    'utf8',
  ),
) as Fixture[];

describe('the shapes the plan anticipated', () => {
  it('reads one file with one range', () => {
    expect(parseLocation('web/src/features/edit/EditPanel.tsx:353')).toEqual([
      { path: 'web/src/features/edit/EditPanel.tsx', lines: '353', note: null },
    ]);
  });

  it('reads one file with several ranges', () => {
    // The plan's own example.
    expect(parseLocation('api/vault/store.py:196-206,299-310')).toEqual([
      { path: 'api/vault/store.py', lines: '196-206,299-310', note: null },
    ]);
  });

  it('reads a bare file with no line at all', () => {
    expect(parseLocation('infra/zimaos/bindery.zimaos.yaml')).toEqual([
      { path: 'infra/zimaos/bindery.zimaos.yaml', lines: null, note: null },
    ]);
  });
});

describe('the shapes the real corpus has and the plan did not', () => {
  it('reads several files separated by semicolons', () => {
    const parsed = parseLocation(
      'api/config.py:12-14; api/settings_store.py:70; .env.example:5,8',
    );
    expect(parsed.map((l) => l.path)).toEqual([
      'api/config.py',
      'api/settings_store.py',
      '.env.example',
    ]);
    expect(parsed[2]?.lines).toBe('5,8');
  });

  it('keeps the prose, which is the only thing saying what is wrong with that file', () => {
    const parsed = parseLocation('api/main.py (no startup check in lifespan)');
    expect(parsed[0]?.path).toBe('api/main.py');
    expect(parsed[0]?.note).toBe('no startup check in lifespan');
  });

  it('tells a comma between ranges from a comma between files', () => {
    // Ranges of one file.
    expect(parseLocation('api/search/query.py:293-296, 302-308, 362-381')).toHaveLength(1);
    // Two files — and the joining words go with the separator, not the path.
    const two = parseLocation('api/taxonomy_health.py:150-195, invoked from api/routers/entities.py:529');
    expect(two.map((l) => l.path)).toEqual([
      'api/taxonomy_health.py',
      'api/routers/entities.py',
    ]);
  });

  it('attaches a bare second range to the file before it', () => {
    const parsed = parseLocation('worker/runner.py:67 and :487-502');
    // One file, both ranges: writing the path once is how people actually write this.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe('worker/runner.py');
    expect(parsed[0]?.lines).toBe('67,487-502');
  });

  it('merges a file named twice rather than listing it twice', () => {
    const parsed = parseLocation('api/db/models/tag.py:51-67 with api/db/models/tag.py:90');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lines).toBe('51-67,90');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of ['', '   ', ';;;', '🙂', 'see the code', ':', 'a'.repeat(5000)]) {
      expect(() => parseLocation(input), input).not.toThrow();
    }
  });
});

describe('the real corpus', () => {
  it('loaded 127 findings, so the rates below are measured over the real thing', () => {
    expect(REAL).toHaveLength(127);
    expect(REAL.every((f) => f.location !== null)).toBe(true);
  });

  it('finds at least one file in every single one', () => {
    // The strongest claim worth making: not one of 127 real locations parses to nothing.
    const empty = REAL.filter((f) => parseLocation(f.location).length === 0);
    expect(
      empty.map((f) => `${f.findingId}: ${f.location ?? ''}`),
      'these locations parsed to no file at all',
    ).toEqual([]);
  });

  it('finds several files where the corpus names several', () => {
    // 28 of 127 name more than one file — the reason a child table exists at all.
    const multi = REAL.filter((f) => parseLocation(f.location).length > 1);
    expect(multi.length).toBeGreaterThanOrEqual(28);
  });

  it('produces paths that look like paths, not fragments of prose', () => {
    const suspect: string[] = [];
    for (const finding of REAL) {
      for (const path of pathsIn(finding.location)) {
        // A path with a space in it is prose that slipped through the separators.
        if (/\s/.test(path)) suspect.push(`${finding.findingId}: "${path}"`);
      }
    }
    expect(suspect, 'these parsed "paths" contain whitespace').toEqual([]);
  });

  it('never invents a line reference', () => {
    for (const finding of REAL) {
      for (const location of parseLocation(finding.location)) {
        if (location.lines === null) continue;
        // Whatever it parsed as lines has to appear in the text it came from.
        expect(finding.location ?? '', finding.findingId).toContain(
          location.lines.split(',')[0] ?? '',
        );
      }
    }
  });
});
