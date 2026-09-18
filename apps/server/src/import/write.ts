import { basename } from 'node:path';
import { parseLocation, sectionKeyFor, type ChecklistItem, type Section } from '@foreman/shared';
import type { Db } from '../db.js';

/**
 * The writers (T-8.3).
 *
 * Every one is an upsert on a natural key — `human_id`, or `(project, kind, title)` for a document
 * — which is the whole of FRM-REQ-150: running the importer twice updates rather than duplicates,
 * as a property of how it writes rather than as a check bolted on afterwards.
 *
 * Nothing here decides *whether* to write. The caller does that, once, so a dry run is the absence
 * of a call rather than a flag threaded through a dozen functions that each have to remember it.
 */

export interface WriteContext {
  readonly db: Db;
  readonly projectId: string;
  readonly code: string;
}

// ─── Phases and tasks ──────────────────────────────────────────────────────

/** `## Phase 8.5 — The Half Phase` → `{ number: 8.5, name: 'The Half Phase' }`. */
export function parsePhaseHeading(heading: string): { number: string; name: string } | null {
  const match = /^Phase\s+(\d+(?:\.\d+)?)\s*[—–-]\s*(.+)$/i.exec(heading.trim());
  if (match === null) return null;
  return { number: match[1] ?? '', name: (match[2] ?? '').trim() };
}

export async function writePhase(
  ctx: WriteContext,
  number: string,
  name: string,
  sortOrder: number,
): Promise<string> {
  const humanId = `${ctx.code}-P-${number}`;
  const phase = await ctx.db.phase.upsert({
    where: { humanId },
    create: {
      projectId: ctx.projectId,
      humanId,
      // Decimal, because Bindery shipped a Phase 8.5 and an integer column makes that plan
      // unrepresentable.
      number,
      // Independent of the number: the order they were built in is not the order they are
      // numbered, and the import order is the authored order.
      sortOrder,
      name,
    },
    update: { name },
    select: { id: true },
  });
  return phase.id;
}

export interface TaskWrite {
  readonly humanId: string;
  readonly title: string;
  readonly done: boolean;
  readonly synthesized: boolean;
  readonly phaseId: string | null;
  readonly sortOrder: number;
  readonly requirements: readonly string[];
}

/**
 * A task ID out of a checklist line, or one synthesized from its position (T-8.4, FRM-REQ-151).
 *
 * Twelve scopes of work in the corpus have no task IDs at all — Clearwhen's is
 * `- [x] Capabilities: WeatherKit (app ID), App Group entitlement`. A synthesized ID is flagged as
 * such on the row, so it is never mistaken for one somebody chose and cited.
 */
export function taskFrom(
  item: ChecklistItem,
  code: string,
  phaseNumber: string,
  position: number,
): TaskWrite {
  /**
   * The ID may already carry its project prefix.
   *
   * The importer rewrites citations *before* it maps, so by the time a task line reaches here
   * `**T-0.1**` is already `**BND-T-0.1**`. A pattern matching only the bare form found nothing
   * and flagged all 222 of Bindery's tasks as synthesized — visibly absurd, which is the whole
   * reason the flag is a column rather than a comment.
   */
  const explicit =
    /\*\*(?:[A-Z][A-Z0-9]{1,7}-)?(T-\d+(?:\.\d+[a-z]?)?)\*\*|(?<![\w-])(?:[A-Z][A-Z0-9]{1,7}-)?(T-\d+\.\d+[a-z]?)(?![\w-])/.exec(
      item.text,
    );
  const id = explicit?.[1] ?? explicit?.[2] ?? null;

  // The title is the line with its ID, bullets and trailing metadata stripped — what a person
  // would call the task if asked.
  const title = item.text
    .replace(/\*\*(?:[A-Z][A-Z0-9]{1,7}-)?T-\d+(?:\.\d+[a-z]?)?\*\*\s*[—–-]?\s*/, '')
    .replace(/\s*·\s*`?REQ-[\d,\s`REQ-]*`?.*$/i, '')
    .replace(/\s*·\s*Size\s+`?\w+`?.*$/i, '')
    .trim();

  // Same reason: the citations in this line are prefixed by now.
  const requirements = [...item.text.matchAll(/(?<![\w-])(?:[A-Z][A-Z0-9]{1,7}-)?REQ-(\d+)(?![\w-])/g)].map(
    (m) => `${code}-REQ-${(m[1] ?? '').padStart(3, '0')}`,
  );

  return {
    humanId: id === null ? `${code}-T-${phaseNumber}.${String(position)}` : `${code}-${id}`,
    title: title.length > 0 ? title.slice(0, 300) : item.text.slice(0, 300),
    done: item.done,
    synthesized: id === null,
    phaseId: null,
    sortOrder: position,
    requirements,
  };
}

export async function writeTask(ctx: WriteContext, task: TaskWrite): Promise<void> {
  const row = await ctx.db.task.upsert({
    where: { humanId: task.humanId },
    create: {
      projectId: ctx.projectId,
      humanId: task.humanId,
      title: task.title,
      status: task.done ? 'done' : 'todo',
      ...(task.done ? { completedAt: new Date() } : {}),
      sortOrder: task.sortOrder,
      // Flagged, so a synthesized ID is never mistaken for one somebody chose (FRM-REQ-045).
      idSynthesized: task.synthesized,
      ...(task.phaseId === null ? {} : { phaseId: task.phaseId }),
    },
    update: {
      title: task.title,
      status: task.done ? 'done' : 'todo',
      ...(task.phaseId === null ? {} : { phaseId: task.phaseId }),
    },
    select: { id: true },
  });

  for (const humanId of task.requirements) {
    const requirement = await ctx.db.requirement.findUnique({
      where: { humanId },
      select: { id: true },
    });
    // A citation of a requirement that is not in the register is a typo in the scope of work, not
    // a reason to invent a row.
    if (requirement === null) continue;

    await ctx.db.taskRequirement.upsert({
      where: { taskId_requirementId: { taskId: row.id, requirementId: requirement.id } },
      create: { taskId: row.id, requirementId: requirement.id },
      update: {},
    });
  }
}

// ─── ADRs ──────────────────────────────────────────────────────────────────

export async function writeAdr(
  ctx: WriteContext,
  path: string,
  data: Record<string, unknown>,
  sections: readonly Section[],
): Promise<void> {
  const match = /^adr-(\d+)\s*[—–-]?\s*(.*)$/i.exec(basename(path).replace(/\.md$/i, ''));
  if (match === null) return;

  const number = Number(match[1]);
  const humanId = `${ctx.code}-ADR-${String(number).padStart(3, '0')}`;
  const title = (match[2] ?? '').trim();

  const sectionNamed = (...names: string[]) =>
    sections.find((s) => names.some((n) => s.heading.toLowerCase().startsWith(n)))?.body ?? null;

  const status = typeof data['status'] === 'string' ? data['status'].toLowerCase() : 'accepted';

  await ctx.db.adr.upsert({
    where: { humanId },
    create: {
      projectId: ctx.projectId,
      humanId,
      number,
      title: title.length > 0 ? title : humanId,
      status: (['proposed', 'accepted', 'superseded', 'rejected'].includes(status)
        ? status
        : 'accepted') as 'accepted',
      contextMd: sectionNamed('context'),
      decisionMd: sectionNamed('decision'),
      consequencesMd: sectionNamed('consequence'),
      rejectedMd: sectionNamed('what was rejected', 'rejected', 'alternatives'),
    },
    update: {
      title: title.length > 0 ? title : humanId,
      contextMd: sectionNamed('context'),
      decisionMd: sectionNamed('decision'),
      consequencesMd: sectionNamed('consequence'),
    },
  });
}

// ─── Documents ─────────────────────────────────────────────────────────────

export async function writeDocument(
  ctx: WriteContext,
  title: string,
  kind: string,
  sourcePath: string,
  sections: readonly Section[],
): Promise<number> {
  // `(project, kind, title)` is the natural key: the same file re-imported updates its document
  // rather than adding a second one beside it.
  const existing = await ctx.db.document.findFirst({
    where: { projectId: ctx.projectId, title, deletedAt: null },
    select: { id: true },
  });

  const document =
    existing ??
    (await ctx.db.document.create({
      data: {
        projectId: ctx.projectId,
        kind: kind as 'research',
        title,
        sourcePath,
      },
      select: { id: true },
    }));

  const seen = new Set<string>();
  for (const [index, section] of sections.entries()) {
    // A key is derived once and must stay put; a duplicate heading gets a suffix rather than
    // overwriting the first one's content.
    let key = sectionKeyFor(section.heading);
    if (seen.has(key)) key = `${key}-${String(index)}`;
    seen.add(key);

    await ctx.db.documentSection.upsert({
      where: { documentId_key: { documentId: document.id, key } },
      create: {
        documentId: document.id,
        key,
        heading: section.heading,
        bodyMd: section.body,
        sortOrder: index,
      },
      update: { heading: section.heading, bodyMd: section.body, sortOrder: index },
    });
  }

  return sections.length;
}

// ─── Findings ──────────────────────────────────────────────────────────────

export async function writeFinding(
  ctx: WriteContext,
  data: Record<string, unknown>,
  title: string,
  sections: readonly Section[],
): Promise<void> {
  const id = data['finding_id'];
  if (typeof id !== 'string') return;

  const humanId = `${ctx.code}-${id}`;
  const str = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' ? value : null;
  };

  const severity = (str('severity') ?? 'medium').toLowerCase();
  const status = (str('status') ?? 'open').toLowerCase();
  const verified = (str('verified') ?? 'unverified').toLowerCase();
  const location = str('location');

  const sectionNamed = (prefix: string) =>
    sections.find((s) => s.heading.toLowerCase().startsWith(prefix))?.body ?? null;

  const finding = await ctx.db.finding.upsert({
    where: { humanId },
    create: {
      projectId: ctx.projectId,
      humanId,
      title,
      severity: (['critical', 'high', 'medium', 'low'].includes(severity)
        ? severity
        : 'medium') as 'medium',
      lenses: (str('lens') ?? '').split(',').map((l) => l.trim()).filter((l) => l.length > 0),
      confidence: str('confidence'),
      // `unverified` is the corpus's commonest value, and a real state rather than a blank.
      verified: (['confirmed', 'plausible', 'unverified'].includes(verified)
        ? verified
        : 'unverified') as 'unverified',
      status: (['open', 'fixed', 'deferred', 'skipped', 'wont_fix'].includes(status)
        ? status
        : 'open') as 'open',
      effort: str('effort'),
      fixedCommitSha: str('fixed_commit'),
      locationRaw: location,
      observedMd: sectionNamed('what was observed'),
      recommendationMd: sectionNamed('recommendation'),
    },
    update: { title, status: (['open', 'fixed', 'deferred', 'skipped', 'wont_fix'].includes(status) ? status : 'open') as 'open' },
    select: { id: true },
  });

  await ctx.db.findingLocation.deleteMany({ where: { findingId: finding.id } });
  for (const [index, parsed] of parseLocation(location).entries()) {
    await ctx.db.findingLocation.create({
      data: {
        findingId: finding.id,
        path: parsed.path,
        lines: parsed.lines,
        note: parsed.note,
        sortOrder: index,
      },
    });
  }
}

// ─── Risks, decisions and terms ────────────────────────────────────────────

export async function writeRisk(
  ctx: WriteContext,
  row: Record<string, string>,
  seq: number,
): Promise<boolean> {
  const title = row['Risk'] ?? row['Title'] ?? row['Description'] ?? '';
  if (title.trim() === '') return false;

  const raw = row['ID'] ?? row['#'] ?? '';
  const humanId = /^R-?\d+$/i.test(raw) ? `${ctx.code}-${raw.toUpperCase()}` : `${ctx.code}-R-${String(seq).padStart(3, '0')}`;

  await ctx.db.risk.upsert({
    where: { humanId },
    create: {
      projectId: ctx.projectId,
      humanId,
      title: title.slice(0, 300),
      mitigation: row['Mitigation'] ?? null,
      // A risk with no named tripwire is a worry. Imported as one, and visible as such.
      tripwire: row['Tripwire'] ?? row['Trigger'] ?? null,
    },
    update: { title: title.slice(0, 300) },
  });
  return true;
}

export async function writeTerm(ctx: WriteContext, row: Record<string, string>): Promise<boolean> {
  const term = row['Term'] ?? row['Name'] ?? '';
  const definition = row['Definition'] ?? row['Meaning'] ?? row['What it means'] ?? '';
  if (term.trim() === '' || definition.trim() === '') return false;

  const existing = await ctx.db.term.findFirst({
    where: { projectId: ctx.projectId, term: term.slice(0, 120) },
    select: { id: true },
  });

  if (existing === null) {
    await ctx.db.term.create({
      data: { projectId: ctx.projectId, term: term.slice(0, 120), definition: definition.slice(0, 4000) },
    });
  } else {
    await ctx.db.term.update({
      where: { id: existing.id },
      data: { definition: definition.slice(0, 4000) },
    });
  }
  return true;
}
