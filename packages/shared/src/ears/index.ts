import type { EarsPattern } from '../enums.js';
import { parseEars, type EarsParse } from './parser.js';

export * from './parser.js';

/**
 * The lint, as the domain layer uses it. **Warns, never blocks** (FRM-REQ-051, FRM-REQ-052): a
 * requirement that does not conform is stored with its note, because 591 of them already exist and
 * a parser that rejects them is a parser nobody runs twice.
 */
export interface EarsResult {
  readonly pattern: EarsPattern;
  readonly ok: boolean;
  readonly note?: string;
}

export function lintEars(statement: string): EarsResult {
  const parsed: EarsParse = parseEars(statement);
  return {
    pattern: parsed.pattern,
    ok: parsed.ok,
    ...(parsed.note === undefined ? {} : { note: parsed.note }),
  };
}
