import { z } from 'zod';
import {
  AdrStatus,
  DocumentKind,
  RiskImpact,
  RiskLikelihood,
  RiskStatus,
} from '../enums.js';
import { Instant, Timestamps, Uuid } from './common.js';

/**
 * The record: documents and their sections, ADRs, decisions, risks and glossary terms.
 *
 * Everything authored lives here. The spine (`spine.ts`) is what is being built; this is what was
 * decided and why — and the reason Foreman can replace a vault rather than merely index one.
 */

// ─── Section keys ──────────────────────────────────────────────────────────

/**
 * A section key: lower-case words joined by hyphens.
 *
 * **Load-bearing.** This is the fragment in `foreman://bindery/architecture#deployment`, so it must
 * be stable across edits, slug-safe and unique within its document. Renaming a heading must not
 * change the key, or every citation and every cached resource URI silently points at nothing —
 * which is why `SectionUpdate` below has no `key` field at all.
 */
export const SectionKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a section key is lower-case words joined by hyphens');
export type SectionKey = z.infer<typeof SectionKey>;

/**
 * Derive a key from a heading. Used **once**, when a section is first created.
 *
 * Deliberately not re-run on rename: a key derived fresh from an edited heading would change, and a
 * changing key is the bug this whole type exists to prevent.
 */
export function sectionKeyFor(heading: string): string {
  const slug = heading
    .normalize('NFKD')
    // Strip accents, then anything that is not a word character or a space.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 120)
    // A trailing hyphen is possible after the slice.
    .replace(/-+$/, '');
  // A heading of only punctuation or non-Latin script slugs to nothing; it still needs a key.
  return slug.length > 0 ? slug : 'section';
}

// ─── Document ──────────────────────────────────────────────────────────────

export const DocumentSection = z
  .object({
    id: Uuid,
    documentId: Uuid,
    key: SectionKey,
    heading: z.string().min(1).max(300),
    bodyMd: z.string().max(200_000),
    sortOrder: z.number().int(),
  })
  .extend(Timestamps.shape);
export type DocumentSection = z.infer<typeof DocumentSection>;

export const Document = z
  .object({
    id: Uuid,
    projectId: Uuid,
    phaseId: Uuid.nullable(),
    kind: DocumentKind,
    title: z.string().min(1).max(300),
    sourcePath: z.string().max(1000).nullable(),
  })
  .extend(Timestamps.shape);
export type Document = z.infer<typeof Document>;

export const DocumentCreate = z.object({
  kind: DocumentKind,
  title: z.string().min(1).max(300),
  phaseId: Uuid.nullish(),
  sourcePath: z.string().max(1000).optional(),
  /** Sections may be given at creation; a key is derived from each heading if none is supplied. */
  sections: z
    .array(
      z.object({
        key: SectionKey.optional(),
        heading: z.string().min(1).max(300),
        bodyMd: z.string().max(200_000).default(''),
      }),
    )
    .max(200)
    .optional(),
});
export type DocumentCreate = z.infer<typeof DocumentCreate>;

/** No `kind`: a document's kind decides its section shape, and changing it would orphan them. */
export const DocumentUpdate = DocumentCreate.omit({ kind: true, sections: true }).partial();
export type DocumentUpdate = z.infer<typeof DocumentUpdate>;

/**
 * One section's new content. **There is no `key`** — see `SectionKey`. A heading may be renamed;
 * the address it is reached by may not.
 */
export const SectionUpdate = z.object({
  heading: z.string().min(1).max(300).optional(),
  bodyMd: z.string().max(200_000),
  /** A note recorded on the revision — "why", when the diff only shows "what". */
  note: z.string().max(500).optional(),
});
export type SectionUpdate = z.infer<typeof SectionUpdate>;

export const SectionCreate = z.object({
  key: SectionKey.optional(),
  heading: z.string().min(1).max(300),
  bodyMd: z.string().max(200_000).default(''),
  /** Where to put it. Appended when absent. */
  after: SectionKey.optional(),
});
export type SectionCreate = z.infer<typeof SectionCreate>;

// ─── ADR ───────────────────────────────────────────────────────────────────

export const Adr = z
  .object({
    id: Uuid,
    projectId: Uuid,
    humanId: z.string(),
    number: z.number().int(),
    title: z.string().min(1).max(300),
    status: AdrStatus,
    decisionAbstract: z.string().max(2000).nullable(),
    contextMd: z.string().max(100_000).nullable(),
    decisionMd: z.string().max(100_000).nullable(),
    consequencesMd: z.string().max(100_000).nullable(),
    rejectedMd: z.string().max(100_000).nullable(),
    decidedOn: z.string().nullable(),
  })
  .extend(Timestamps.shape);
export type Adr = z.infer<typeof Adr>;

export const AdrCreate = z.object({
  title: z.string().min(1).max(300),
  status: AdrStatus.optional(),
  decisionAbstract: z.string().max(2000).optional(),
  contextMd: z.string().max(100_000).optional(),
  decisionMd: z.string().max(100_000).optional(),
  consequencesMd: z.string().max(100_000).optional(),
  /** What was considered and turned down. The half of an ADR that is usually lost. */
  rejectedMd: z.string().max(100_000).optional(),
  decidedOn: z.iso.date().optional(),
});
export type AdrCreate = z.infer<typeof AdrCreate>;

/** No `number`: it is part of the human ID, and immutable (ADR-008). */
export const AdrUpdate = AdrCreate.partial();
export type AdrUpdate = z.infer<typeof AdrUpdate>;

// ─── Decision ──────────────────────────────────────────────────────────────

/** A locked discovery decision — `D-13`. Smaller than an ADR: a question, its answer, and why. */
export const DecisionCreate = z.object({
  statement: z.string().min(1).max(1000),
  value: z.string().min(1).max(2000),
  rationale: z.string().max(4000).optional(),
  /** When it stopped being up for debate. Null means it is still open. */
  lockedAt: Instant.optional(),
});
export type DecisionCreate = z.infer<typeof DecisionCreate>;

export const DecisionUpdate = DecisionCreate.partial();
export type DecisionUpdate = z.infer<typeof DecisionUpdate>;

// ─── Risk ──────────────────────────────────────────────────────────────────

export const RiskCreate = z.object({
  title: z.string().min(1).max(300),
  likelihood: RiskLikelihood.optional(),
  impact: RiskImpact.optional(),
  mitigation: z.string().max(4000).optional(),
  /**
   * The named condition that forces a re-plan.
   *
   * Required on creation, unlike the column, which is nullable for the importer's sake: a risk with
   * no tripwire is a worry, and a worry is something you re-read and feel bad about rather than
   * something that ever fires.
   */
  tripwire: z.string().min(1).max(1000),
  phaseId: Uuid.nullish(),
});
export type RiskCreate = z.infer<typeof RiskCreate>;

export const RiskUpdate = RiskCreate.partial().extend({
  status: RiskStatus.optional(),
});
export type RiskUpdate = z.infer<typeof RiskUpdate>;

// ─── Glossary ──────────────────────────────────────────────────────────────

export const TermCreate = z.object({
  term: z.string().min(1).max(120),
  definition: z.string().min(1).max(4000),
  aliases: z.array(z.string().min(1).max(120)).max(20).optional(),
  /**
   * Absent means the term belongs to the whole ecosystem and appears in every project's glossary
   * (FRM-REQ-071). "Tripwire" and "human ID" mean the same thing in every project here.
   */
  ecosystem: z.boolean().optional(),
});
export type TermCreate = z.infer<typeof TermCreate>;

export const TermUpdate = TermCreate.partial();
export type TermUpdate = z.infer<typeof TermUpdate>;
