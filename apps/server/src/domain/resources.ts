import type { Db } from '../db.js';
import { NotFound } from './errors.js';
import { findProject } from './projects.js';

/**
 * Documents as addressable resources (T-4.9, FRM-REQ-087).
 *
 * `foreman://bindery/architecture#deployment` returns three paragraphs. That is the whole argument
 * for addressing sections at all: a two-thousand-line architecture document is not something to put
 * in a context window to answer one question about the tunnel.
 *
 * **The address is the kind when the kind is unique in the project**, which it is for architecture,
 * data model, API contract and the rest. Where a project holds several of one kind — phase plans,
 * runbooks — each gets `kind-slug-of-title`, because an address that silently resolves to whichever
 * runbook was written first is worse than a longer one.
 */

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function addressFor(
  document: { kind: string; title: string },
  kindCount: number,
): string {
  // The kind is slugged too: `data_model` is the enum's spelling, and `data-model` is what a URI
  // path segment looks like everywhere else here, section keys included. One convention, not two.
  const kind = slugify(document.kind);
  return kindCount === 1 ? kind : `${kind}-${slugify(document.title)}`;
}

export interface ResourceEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/**
 * Every document and section as a URI. This is what a client lists before it reads.
 *
 * Sections are listed individually on purpose: a client that can only see whole documents will
 * fetch whole documents, and the addressing stops earning its keep.
 */
export async function resourceCatalogue(db: Db, code?: string): Promise<ResourceEntry[]> {
  const documents = await db.document.findMany({
    where: {
      deletedAt: null,
      project: { deletedAt: null, ...(code === undefined ? {} : { code }) },
    },
    include: {
      project: { select: { code: true } },
      sections: {
        where: { deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: { key: true, heading: true, bodyMd: true },
      },
    },
  });

  const counts = new Map<string, number>();
  for (const document of documents) {
    const bucket = `${document.project.code}:${document.kind}`;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return documents.flatMap((document) => {
    const address = addressFor(document, counts.get(`${document.project.code}:${document.kind}`) ?? 1);
    const base = `foreman://${document.project.code}/${address}`;

    return [
      {
        uri: base,
        name: `${document.project.code} — ${document.title}`,
        description: `${document.kind.replace(/_/g, ' ')}, ${String(document.sections.length)} sections`,
        mimeType: 'text/markdown',
      },
      ...document.sections.map((section) => ({
        uri: `${base}#${section.key}`,
        name: `${document.project.code} — ${document.title} — ${section.heading}`,
        // The first line of the body, so a client can choose without fetching.
        description: firstLine(section.bodyMd),
        mimeType: 'text/markdown',
      })),
    ];
  });
}

function firstLine(markdown: string): string {
  const line = markdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  return line === undefined ? '(empty)' : line.slice(0, 160);
}

/** Resolve an address to its document, or say what the project actually holds. */
export async function documentAt(db: Db, code: string, address: string) {
  const project = await findProject(db, code);
  const documents = await db.document.findMany({
    where: { projectId: project.id, deletedAt: null },
    include: {
      sections: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
    },
  });

  const counts = new Map<string, number>();
  for (const document of documents) counts.set(document.kind, (counts.get(document.kind) ?? 0) + 1);

  const found = documents.find((document) => addressFor(document, counts.get(document.kind) ?? 1) === address);
  if (found === undefined) {
    // Naming the addresses that do exist turns a dead end into the next request.
    const available = documents.map((d) => addressFor(d, counts.get(d.kind) ?? 1)).sort();
    throw new NotFound(
      available.length === 0
        ? `${code} has no documents`
        : `${code} has no document at "${address}" — it has ${available.join(', ')}`,
    );
  }
  return found;
}

/** One section, rendered as the markdown a reader would have written. */
export async function sectionAt(db: Db, code: string, address: string, key: string) {
  const document = await documentAt(db, code, address);
  const section = document.sections.find((s) => s.key === key);
  if (section === undefined) {
    const available = document.sections.map((s) => s.key);
    throw new NotFound(
      `${document.title} has no section "${key}" — it has ${available.join(', ')}`,
    );
  }
  return { document, section };
}

/** A document as one markdown string — headings and bodies, in order. */
export function renderDocument(document: {
  title: string;
  sections: { heading: string; bodyMd: string }[];
}): string {
  return [
    `# ${document.title}`,
    ...document.sections.map((section) => `## ${section.heading}\n\n${section.bodyMd}`),
  ].join('\n\n');
}

export function renderSection(section: { heading: string; bodyMd: string }): string {
  return `## ${section.heading}\n\n${section.bodyMd}`;
}
