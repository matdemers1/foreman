/**
 * Reading the vault's markdown (T-8.2).
 *
 * Written against the real files in `fixtures/vault/`, which is the whole point of copying them in
 * first: a parser written against imagined input passes its own tests and then meets a corpus that
 * uses both YAML styles, a `Src` column of round codes, and a scope of work with no task IDs at all.
 */

export interface Frontmatter {
  readonly data: Record<string, unknown>;
  /** The document with its frontmatter removed, so offsets into the body are honest. */
  readonly body: string;
  /** True when the file opened with `---` at all. A file with none is not an error. */
  readonly present: boolean;
}

/**
 * Frontmatter, in both styles the corpus actually uses.
 *
 * ```yaml
 * tags: [type/requirements, project/bindery]   # inline — Bindery
 * tags:                                        # block — the vault's own templates
 *   - project/foreman
 * ```
 *
 * Hand-parsed rather than handed to a YAML library: the subset in use is small and flat, and a
 * full YAML parser brings anchors, multi-document streams and arbitrary type coercion — three
 * things no vault file needs and any of which could turn a date into something surprising.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) return { data: {}, body: text, present: false };

  const data: Record<string, unknown> = {};
  const lines = (match[1] ?? '').split(/\r?\n/);

  let currentKey: string | null = null;
  let block: string[] = [];

  const flush = () => {
    if (currentKey !== null && block.length > 0) data[currentKey] = block;
    currentKey = null;
    block = [];
  };

  for (const line of lines) {
    // A block-style list item belongs to the key above it.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && currentKey !== null) {
      block.push(unquote(item[1] ?? ''));
      continue;
    }

    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    flush();

    const key = pair[1] ?? '';
    const raw = (pair[2] ?? '').trim();

    if (raw === '') {
      // Either a block list follows, or the value really is empty. Decided by what comes next.
      currentKey = key;
      continue;
    }
    data[key] = scalar(raw);
  }
  flush();

  return { data, body: text.slice(match[0].length), present: true };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(raw: string): unknown {
  // Inline list: `[a, b, c]`. The corpus uses this for `tags` and `aliases`.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((part) => unquote(part));
  }
  const value = unquote(raw);
  // Deliberately no number or boolean coercion. `version: 1.10` is a string in every file that
  // has one, and turning it into 1.1 is the kind of corruption nobody notices for a year.
  return value;
}

// ─── Markdown tables ───────────────────────────────────────────────────────

export interface MarkdownTable {
  readonly headers: string[];
  readonly rows: Record<string, string>[];
  /** The line the table started on, for a reconciliation note that can be checked. */
  readonly line: number;
}

/**
 * Every pipe table in a body, keyed by header.
 *
 * The registers are tables, and a register is the densest thing in the corpus — 439 requirements
 * across several tables in one file, each with its own section heading above it.
 */
export function parseTables(body: string): MarkdownTable[] {
  const lines = body.split(/\r?\n/);
  const tables: MarkdownTable[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    const divider = lines[i + 1];
    if (header === undefined || divider === undefined) continue;
    if (!header.trim().startsWith('|')) continue;
    // The divider is what makes it a table rather than a line that happens to contain pipes.
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(divider)) continue;

    const headers = splitRow(header);
    const rows: Record<string, string>[] = [];

    let j = i + 2;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line === undefined || !line.trim().startsWith('|')) break;

      const cells = splitRow(line);
      const row: Record<string, string> = {};
      for (const [index, name] of headers.entries()) row[name] = cells[index] ?? '';
      rows.push(row);
    }

    tables.push({ headers, rows, line: i + 1 });
    i = j - 1;
  }

  return tables;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

// ─── Checkbox lists ────────────────────────────────────────────────────────

export interface ChecklistItem {
  readonly done: boolean;
  readonly text: string;
  /** The heading this item sat under — the phase, in a scope of work. */
  readonly section: string | null;
  readonly line: number;
}

/**
 * Checkbox items, with the heading above them.
 *
 * Clearwhen's scope of work is **free text with no task IDs** — `- [x] Capabilities: WeatherKit
 * (app ID), App Group entitlement` — and it is not an outlier: twelve scopes of work in the corpus
 * have no task IDs at all. Those become synthesized, flagged tasks (T-8.4), which is the only way
 * those projects import at all.
 */
export function parseChecklist(body: string): ChecklistItem[] {
  const lines = body.split(/\r?\n/);
  const items: ChecklistItem[] = [];
  let section: string | null = null;

  for (const [index, line] of lines.entries()) {
    const heading = /^#{2,4}\s+(.*)$/.exec(line);
    if (heading !== null) {
      section = (heading[1] ?? '').trim();
      continue;
    }

    const item = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (item === null) continue;

    items.push({
      done: (item[1] ?? ' ').toLowerCase() === 'x',
      text: (item[2] ?? '').trim(),
      section,
      line: index + 1,
    });
  }

  return items;
}

/** The `##` and `###` headings of a body, with the prose under each — a document's sections. */
export interface Section {
  readonly heading: string;
  readonly body: string;
  readonly level: number;
}

export function parseSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];

  let current: { heading: string; level: number; lines: string[] } | null = null;
  let fenced = false;

  for (const line of lines) {
    // A `##` inside a fenced block is code, not a heading. Missing this splits a document at a
    // comment in a shell sample.
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;

    const heading = fenced ? null : /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (current !== null) {
        sections.push({
          heading: current.heading,
          body: current.lines.join('\n').trim(),
          level: current.level,
        });
      }
      current = { heading: (heading[2] ?? '').trim(), level: (heading[1] ?? '##').length, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }

  if (current !== null) {
    sections.push({
      heading: current.heading,
      body: current.lines.join('\n').trim(),
      level: current.level,
    });
  }

  return sections;
}
