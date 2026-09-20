/**
 * Rewriting inline citations to project-prefixed IDs (T-8.5, FRM-REQ-152).
 *
 * `REQ-021` inside a Bindery document has to become `BND-REQ-021`, because ADR-008 says an ID
 * resolves with no other context and a bare one does not. This is the subtlest task in the phase,
 * and the reason is asymmetric cost: **a false positive corrupts prose permanently.** A missed
 * rewrite leaves a citation that does not resolve, which is visible and fixable; a wrong rewrite
 * silently changes what a document says.
 *
 * So the rewriter is conservative, and every substitution is logged for review.
 *
 * It must not touch:
 *
 * - an ID that already carries a project prefix — `BND-REQ-021`, or another project's `AUTH-T-1.2`
 * - anything inside a fenced block or an inline code span, where an ID is an example
 * - a URL, a file path, or a heading anchor
 * - **anything inside a `[[wiki link]]`** — the target is a filename, and rewriting it points the
 *   link at a file that does not exist. Found by running this over the real corpus, where
 *   `[[Bindery/ADR-003 — Claude Behind an Adapter|ADR-003]]` was rewritten on both halves.
 * - a bare word that merely looks like one: `REQ` alone, `T-shirt`, a version like `v1-2`
 */

export interface Substitution {
  readonly from: string;
  readonly to: string;
  /** Enough of the line to judge the substitution without opening the file. */
  readonly context: string;
  readonly line: number;
}

export interface RewriteResult {
  readonly text: string;
  readonly substitutions: readonly Substitution[];
  /** IDs left alone, and why — the half a reviewer needs to trust the other half. */
  readonly skipped: readonly { readonly id: string; readonly because: string; readonly line: number }[];
}

/** The types a bare citation may carry. Anything else is a word that happens to have a hyphen. */
const TYPES = ['REQ', 'T', 'P', 'ADR', 'D', 'R', 'CR', 'DA', 'FR', 'API', 'AUD', 'TERM'] as const;

const BARE = new RegExp(String.raw`\b(${TYPES.join('|')})-(\d+(?:\.\d+)?)\b`, 'g');

/** Spans of the text that are code, and therefore off limits. */
function codeSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];

  for (const pattern of [/```[\s\S]*?```/g, /~~~[\s\S]*?~~~/g, /`[^`\n]*`/g]) {
    for (const match of text.matchAll(pattern)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  // A URL or a path is not code, but an ID inside one is part of an address, not a citation.
  for (const match of text.matchAll(/\bhttps?:\/\/\S+|\b[\w./-]+\.(?:md|ts|py|tsx|yaml|yml|json)\b/g)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  // A wiki link is an address on both sides of the pipe: `[[Bindery/ADR-003 — Title|ADR-003]]`.
  // Rewriting the target points it at a file that does not exist, and rewriting the display text
  // makes the two halves disagree.
  for (const match of text.matchAll(/\[\[[^\]]*\]\]/g)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

export function rewriteCitations(
  text: string,
  projectCode: string,
  options: { knownCodes?: readonly string[]; lineOffset?: number } = {},
): RewriteResult {
  const spans = codeSpans(text);
  const inCode = (index: number) => spans.some((s) => index >= s.start && index < s.end);

  const known = new Set((options.knownCodes ?? []).map((c) => c.toUpperCase()));
  known.add(projectCode.toUpperCase());

  const substitutions: Substitution[] = [];
  const skipped: { id: string; because: string; line: number }[] = [];

  /**
   * Line numbers are reported **relative to the file**, not to the text handed in.
   *
   * The importer strips frontmatter before rewriting, so without the offset every logged line is
   * wrong by however many lines the frontmatter had — and a review log whose line numbers do not
   * match the file is a log nobody can use.
   */
  const offset = options.lineOffset ?? 0;
  const lineAt = (index: number) => text.slice(0, index).split('\n').length + offset;

  const out = text.replace(BARE, (match, type: string, seq: string, index: number) => {
    const line = lineAt(index);

    if (inCode(index)) {
      skipped.push({ id: match, because: 'inside code, a path, a URL or a wiki link', line });
      return match;
    }

    // Already prefixed: the character before is `-` preceded by an upper-case code.
    const before = text.slice(Math.max(0, index - 10), index);
    if (/[A-Z][A-Z0-9]{1,7}-$/.test(before)) {
      skipped.push({ id: match, because: 'already carries a project prefix', line });
      return match;
    }

    /**
     * Directly after a path separator, so it is part of an address.
     *
     * The span above catches a path only when it runs unbroken to a known extension, and this
     * vault's paths are full of spaces — `D3 Cloud Vault/Bindery/ADR-011 — A Declined File Is Not
     * a Failure.md` breaks the match long before `.md`, leaving `ADR-011` looking like a citation
     * in open prose. Rewriting it points the text at a file that does not exist.
     *
     * This does mean `REQ-1/REQ-2` leaves the second one alone. That is the cheap failure on
     * purpose: a missed rewrite is a citation that does not resolve, which is visible and fixable,
     * and a wrong one silently changes what a document says.
     */
    if (/[\w)\]]\/$/.test(text.slice(Math.max(0, index - 2), index))) {
      skipped.push({ id: match, because: 'follows a path separator, so it is part of an address', line });
      return match;
    }

    // A bare `T-1` in prose that is plainly not a citation — "T-shirt", "P-value".
    const after = text.slice(index + match.length, index + match.length + 2);
    if (/^[A-Za-z]/.test(after)) {
      skipped.push({ id: match, because: 'runs into a word, so it is not an ID', line });
      return match;
    }

    const replacement = `${projectCode}-${type}-${seq}`;
    substitutions.push({
      from: match,
      to: replacement,
      context: contextAround(text, index),
      line,
    });
    return replacement;
  });

  return { text: out, substitutions, skipped };
}

function contextAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 160);
}
