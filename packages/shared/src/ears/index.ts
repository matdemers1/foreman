import type { EarsPattern } from '../enums.js';

/**
 * EARS — Easy Approach to Requirements Syntax.
 *
 * **The lint warns; it never blocks** (FRM-REQ, and Discovery D-14). A requirement that does not
 * parse is stored with its warning, because the alternative is that somebody stops writing
 * requirements down. 439 already exist, written by hand over a year, and a parser that rejects them
 * is a parser nobody will run twice.
 *
 * The five patterns, plus complex:
 *
 * | Pattern | Shape |
 * |---|---|
 * | ubiquitous | The `<system>` shall `<response>` |
 * | state | **While** `<state>`, the `<system>` shall `<response>` |
 * | event | **When** `<trigger>`, the `<system>` shall `<response>` |
 * | unwanted | **If** `<condition>`, **then** the `<system>` shall `<response>` |
 * | optional | **Where** `<feature>`, the `<system>` shall `<response>` |
 * | complex | a state clause and an event clause together |
 */

export interface EarsResult {
  readonly pattern: EarsPattern;
  readonly ok: boolean;
  /** Present when the statement does not conform. Always says what to do, not just what is wrong. */
  readonly note?: string;
}

const SHALL = /\bshall\b/i;
const WHILE = /^\s*while\b/i;
const WHEN = /^\s*when\b/i;
const IF = /^\s*if\b/i;
const THEN = /\bthen\b/i;
const WHERE = /^\s*where\b/i;

/**
 * Classify a statement. Never throws, and never returns "invalid" — the worst outcome is
 * `unparsed`, which is a stored, legal state.
 */
export function lintEars(statement: string): EarsResult {
  const text = statement.trim();

  if (text.length === 0) {
    return { pattern: 'unparsed', ok: false, note: 'the statement is empty' };
  }

  if (!SHALL.test(text)) {
    return {
      pattern: 'unparsed',
      ok: false,
      // The single most common miss, and the one with the clearest fix.
      note: 'no "shall": EARS states an obligation — "the system shall …"',
    };
  }

  const hasWhile = WHILE.test(text);
  const hasWhen = WHEN.test(text) || /,\s*when\b/i.test(text);

  if (hasWhile && hasWhen) {
    return { pattern: 'complex', ok: true };
  }
  if (hasWhile) {
    return commaCheck(text, 'state', 'While');
  }
  if (WHEN.test(text)) {
    return commaCheck(text, 'event', 'When');
  }
  if (IF.test(text)) {
    if (!THEN.test(text)) {
      return {
        pattern: 'unwanted',
        ok: false,
        note: 'an "If" requirement needs its "then": "If <condition>, then the system shall …"',
      };
    }
    return { pattern: 'unwanted', ok: true };
  }
  if (WHERE.test(text)) {
    return commaCheck(text, 'optional', 'Where');
  }

  // No leading keyword and it states an obligation: an unconditional requirement.
  return { pattern: 'ubiquitous', ok: true };
}

function commaCheck(text: string, pattern: EarsPattern, keyword: string): EarsResult {
  if (!text.includes(',')) {
    return {
      pattern,
      ok: false,
      note: `a "${keyword}" requirement separates its clause with a comma: "${keyword} <clause>, the system shall …"`,
    };
  }
  return { pattern, ok: true };
}
