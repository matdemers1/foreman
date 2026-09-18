/**
 * Parsing a finding's location (T-6.3, FRM-REQ-116).
 *
 * The plan assumed one path with several ranges — `api/vault/store.py:196-206,299-310`. Measured
 * against the real 127 findings, that shape covers about a fifth of them. The rest look like this:
 *
 * ```text
 * api/config.py:12-14; api/settings_store.py:70; api/main.py (no startup check in `lifespan`)
 * api/taxonomy_health.py:150-195, invoked from api/routers/entities.py:529
 * api/routers/vault.py:99-120 (unlock) → api/vault/service.py:101-111 → api/vault/crypto.py:36-37
 * docs/zimaos-deploy.md:135-168, :239, :322 vs the warning at :277-284
 * worker/runner.py:67 and :487-502
 * Makefile:88
 * ```
 *
 * **So this scans rather than splits.** The first version tried to split on separators — `;`, `,`,
 * ` and `, `→` — and every corpus shape that used a separator it had not met dropped a whole file
 * silently. There is no delimiter grammar here to get right: a location is *prose that contains
 * file references*, and the robust reading is to find the references and let the prose be prose.
 *
 * Two things that follow:
 *
 * - **The raw string is always kept** (`finding.locationRaw`). Parsing serves filtering and the
 *   regression watch; the authored text is what a person reads, and it says things no parse holds.
 * - **A bare `:239` belongs to the file before it**, which is how people write a second range.
 */

export interface ParsedLocation {
  readonly path: string;
  /** `12-14`, `42,67,69,144`, or null when a file is named without a line. */
  readonly lines: string | null;
  /** Parenthesised text that followed this reference — `(unlock)`, `(export_full)`. */
  readonly note: string | null;
}

/**
 * A file reference: a path-shaped token, optionally followed by `:lines`.
 *
 * Path-shaped means one of three things, and all three are in the corpus:
 *   - contains a slash — `api/routers/vault.py`, `.github/workflows/build.yml`
 *   - has an extension — `renovate.json`, `.env.example`
 *   - is an extensionless build file that a line number follows — `Makefile:88`
 */
const REFERENCE_RE = new RegExp(
  [
    '(?<path>',
    String.raw`(?:[\w.@-]+\/[\w./@-]+)`, // has a directory
    // The lookahead matters: without it the extension group stops at five characters and
    // `.env.example` is read as `.env.examp` — a path that matches no file on disk.
    String.raw`|(?:\.?[\w@-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,10}(?![\w-]))`, // has an extension
    String.raw`|(?:Makefile|Dockerfile|Procfile|Justfile|Caddyfile|Rakefile)`, // known, extensionless
    ')',
    String.raw`(?::(?<lines>\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*))?`,
  ].join(''),
  'g',
);

/** A continuation — `, :239` or ` and :487-502` — naming another range of the file before it. */
const CONTINUATION_RE = /:(\d+(?:-\d+)?)/g;

export function parseLocation(raw: string | null | undefined): ParsedLocation[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [];

  const found: { path: string; lines: string | null; note: string | null; end: number }[] = [];

  REFERENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_RE.exec(raw)) !== null) {
    const path = match.groups?.['path'];
    if (path === undefined) continue;

    // An extensionless build file only counts when a line number follows it: otherwise every
    // sentence mentioning "the Makefile" would become a location.
    const lines = match.groups?.['lines'] ?? null;
    if (/^(?:Makefile|Dockerfile|Procfile|Justfile|Caddyfile|Rakefile)$/.test(path) && lines === null) {
      continue;
    }

    found.push({
      path,
      lines: lines === null ? null : lines.replace(/\s+/g, ''),
      note: noteAfter(raw, match.index + match[0].length),
      end: match.index + match[0].length,
    });
  }

  // Ranges written after a reference without repeating the path belong to it.
  for (const [index, reference] of found.entries()) {
    const until = found[index + 1]?.end ?? raw.length;
    const tail = raw.slice(reference.end, until);
    const extra = continuationsIn(tail);
    if (extra.length > 0) {
      reference.lines = [reference.lines, ...extra].filter((l) => l !== null).join(',');
    }
  }

  // One row per file: a file named twice is one location with both ranges, which is what the
  // regression watch matches on and what a reader expects to see.
  const byPath = new Map<string, ParsedLocation>();
  for (const reference of found) {
    const existing = byPath.get(reference.path);
    byPath.set(
      reference.path,
      existing === undefined
        ? { path: reference.path, lines: reference.lines, note: reference.note }
        : {
            path: existing.path,
            lines: [existing.lines, reference.lines].filter((l) => l !== null).join(',') || null,
            note: existing.note ?? reference.note,
          },
    );
  }

  return [...byPath.values()];
}

/** `(unlock)` immediately after a reference is about that reference. Anything else is not. */
function noteAfter(raw: string, from: number): string | null {
  const parenthesised = /^\s*\(([^)]{1,200})\)/.exec(raw.slice(from));
  return parenthesised?.[1]?.trim() ?? null;
}

/**
 * Bare `:239` references in the text between one file reference and the next.
 *
 * Only bare ones: anything with a path in front of it was already matched as its own reference,
 * and the slice starts after that match.
 */
function continuationsIn(tail: string): string[] {
  const out: string[] = [];
  CONTINUATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTINUATION_RE.exec(tail)) !== null) {
    const before = tail.slice(0, match.index);
    // A colon-number that ends a word is part of something else — `localhost:5432`, `v3:1`.
    if (/[\w.@/-]$/.test(before)) continue;
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Just the files a finding points at — what the regression watch matches commits against. */
export function pathsIn(raw: string | null | undefined): string[] {
  return parseLocation(raw).map((l) => l.path);
}
