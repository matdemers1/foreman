import { z } from 'zod';

/**
 * Human IDs — `<CODE>-<TYPE>-<SEQ>` (ADR-008).
 *
 * `BND-REQ-021` resolves with no context; `REQ-021` does not. Every entity that gets cited carries
 * one, it is project-prefixed, globally unique, and **immutable once assigned** — renumbering
 * breaks every citation in every document body.
 */

/** The type segment of a human ID, per entity kind. */
export const HUMAN_ID_TYPE = {
  requirement: 'REQ',
  task: 'T',
  phase: 'P',
  adr: 'ADR',
  decision: 'D',
  risk: 'R',
  finding_code_review: 'CR',
  finding_design: 'DA',
  finding_feature: 'FR',
  finding_api: 'API',
  audit: 'AUD',
  term: 'TERM',
} as const;

export type HumanIdType = (typeof HUMAN_ID_TYPE)[keyof typeof HUMAN_ID_TYPE];

/**
 * A project code: 2–8 upper-case letters and digits, starting with a letter. `BND`, `AUTH`, `FRM`.
 * Unique, and unchangeable after creation (FRM-REQ-031) because every ID embeds it.
 */
export const ProjectCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,7}$/, 'a project code is 2–8 upper-case letters or digits, letter first');
export type ProjectCode = z.infer<typeof ProjectCode>;

/**
 * The sequence segment. Usually zero-padded to three (`001`), but task IDs carry their phase —
 * `BND-T-0.3`, and `FRM-T-8.5` — so a dotted sequence is legal.
 */
const SEQ = String.raw`\d+(?:\.\d+)?`;

export const HUMAN_ID_RE = new RegExp(`^([A-Z][A-Z0-9]{1,7})-([A-Z]{1,4})-(${SEQ})$`);

export const HumanId = z.string().regex(HUMAN_ID_RE, 'expected <CODE>-<TYPE>-<SEQ>, e.g. BND-REQ-021');
export type HumanId = z.infer<typeof HumanId>;

export interface ParsedHumanId {
  readonly code: string;
  readonly type: string;
  readonly seq: string;
  /** Numeric value of the sequence, for ordering. `0.3` sorts before `10`. */
  readonly seqValue: number;
}

/** Parse a human ID, or return `null`. Never throws: unparsed input is a normal condition here. */
export function parseHumanId(value: string): ParsedHumanId | null {
  const m = HUMAN_ID_RE.exec(value.trim());
  if (m === null) return null;
  const [, code, type, seq] = m;
  if (code === undefined || type === undefined || seq === undefined) return null;
  return { code, type, seq, seqValue: Number(seq) };
}

/** Format a human ID. Sequences are zero-padded to three digits unless they are dotted. */
export function formatHumanId(code: string, type: string, seq: number | string): string {
  const seqText =
    typeof seq === 'number'
      ? Number.isInteger(seq)
        ? String(seq).padStart(3, '0')
        : String(seq)
      : seq;
  return `${code}-${type}-${seqText}`;
}

/**
 * Find every human ID cited in a body of markdown, ignoring fenced code blocks and inline code.
 * This is what writes `reference` rows, and what makes backlinks possible.
 */
export function extractHumanIds(markdown: string): string[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const found = new Set<string>();
  const re = new RegExp(`\\b[A-Z][A-Z0-9]{1,7}-[A-Z]{1,4}-${SEQ}\\b`, 'g');
  for (const match of withoutCode.matchAll(re)) {
    if (parseHumanId(match[0]) !== null) found.add(match[0]);
  }
  return [...found];
}
