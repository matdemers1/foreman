import { describe, expect, it } from 'vitest';
import { extractHumanIds, formatHumanId, parseHumanId, ProjectCode } from '../src/index.js';

describe('human IDs (ADR-008)', () => {
  it('parses a project-prefixed requirement ID', () => {
    expect(parseHumanId('BND-REQ-021')).toEqual({
      code: 'BND',
      type: 'REQ',
      seq: '021',
      seqValue: 21,
    });
  });

  it('parses a dotted task ID, because Bindery shipped a Phase 8.5', () => {
    const parsed = parseHumanId('FRM-T-8.5');
    expect(parsed?.seq).toBe('8.5');
    expect(parsed?.seqValue).toBe(8.5);
  });

  it('refuses an unprefixed ID — the whole point of the ADR', () => {
    expect(parseHumanId('REQ-021')).toBeNull();
  });

  it('pads whole sequences and leaves dotted ones alone', () => {
    expect(formatHumanId('FRM', 'REQ', 7)).toBe('FRM-REQ-007');
    expect(formatHumanId('FRM', 'T', '0.3')).toBe('FRM-T-0.3');
  });

  it('accepts ecosystem project codes and rejects a lower-case one', () => {
    expect(ProjectCode.safeParse('AUTH').success).toBe(true);
    expect(ProjectCode.safeParse('bnd').success).toBe(false);
  });
});

describe('citation extraction', () => {
  it('finds IDs in prose', () => {
    const ids = extractHumanIds('Satisfies BND-REQ-001 and BND-REQ-002, per BND-ADR-005.');
    expect(ids.sort()).toEqual(['BND-ADR-005', 'BND-REQ-001', 'BND-REQ-002']);
  });

  it('ignores IDs inside fenced code and inline code', () => {
    const md = ['Real: FRM-REQ-003', '```', 'FRM-REQ-999', '```', 'and `FRM-REQ-888`'].join('\n');
    expect(extractHumanIds(md)).toEqual(['FRM-REQ-003']);
  });
});
