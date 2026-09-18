import type { CheckConclusion } from '../generated/prisma/enums.js';
import type { Db } from '../db.js';
import type { TransactionClient } from './audit.js';

/**
 * Turning GitHub's payloads into rows (T-5.3, FRM-REQ-095 … FRM-REQ-097, FRM-REQ-101).
 *
 * **Idempotency is designed in, not added.** A redelivered webhook is normal operation — GitHub
 * retries anything that times out, and a reconcile deliberately re-reads history that is already
 * stored. So every write here is an upsert on a natural key: `(repo, sha)`, `(commit, path)`,
 * `(repo, sha, check name)`, `(repo, tag)`. Running any of this twice is a no-op, which is what
 * makes the reconcile safe to run whenever there is doubt.
 */

export interface GhCommit {
  readonly id?: string;
  readonly sha?: string;
  readonly message?: string;
  readonly timestamp?: string;
  readonly author?: { name?: string; email?: string; username?: string };
  readonly added?: string[];
  readonly removed?: string[];
  readonly modified?: string[];
  /** The REST shape, which nests differently from the webhook shape. */
  readonly commit?: {
    message?: string;
    author?: { name?: string; email?: string; date?: string };
  };
  readonly files?: { filename: string; status: string; additions?: number; deletions?: number }[];
  readonly stats?: { additions?: number; deletions?: number };
}

export interface NormalCommit {
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  readonly authorEmail: string | null;
  readonly committedAt: Date;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly files: { path: string; status: string; additions: number | null; deletions: number | null }[];
}

/**
 * One shape out of two.
 *
 * A push webhook and `GET /repos/:owner/:repo/commits/:sha` describe the same commit with different
 * field names, and the backfill and the webhook path must produce identical rows or the reconcile
 * will "heal" every commit forever.
 */
export function normalizeCommit(raw: GhCommit): NormalCommit | null {
  const sha = raw.sha ?? raw.id;
  if (sha === undefined || sha === '') return null;

  const message = raw.commit?.message ?? raw.message ?? '';
  const when = raw.commit?.author?.date ?? raw.timestamp;
  const author =
    raw.commit?.author?.name ?? raw.author?.name ?? raw.author?.username ?? 'unknown';
  const email = raw.commit?.author?.email ?? raw.author?.email ?? null;

  // The REST shape carries a `files` array with a status; the push shape carries three lists of
  // paths and no per-file counts.
  const files =
    raw.files !== undefined
      ? raw.files.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions ?? null,
          deletions: f.deletions ?? null,
        }))
      : [
          ...(raw.added ?? []).map((path) => ({ path, status: 'added' })),
          ...(raw.modified ?? []).map((path) => ({ path, status: 'modified' })),
          ...(raw.removed ?? []).map((path) => ({ path, status: 'removed' })),
        ].map((f) => ({ ...f, additions: null, deletions: null }));

  return {
    sha,
    message,
    author,
    authorEmail: email,
    committedAt: when === undefined ? new Date() : new Date(when),
    additions: raw.stats?.additions ?? null,
    deletions: raw.stats?.deletions ?? null,
    files,
  };
}

export interface IngestResult {
  readonly created: number;
  readonly updated: number;
}

/** Upsert commits and their files. Returns what was new, which is what a reconcile reports. */
export async function ingestCommits(
  db: Db,
  repoId: string,
  commits: readonly NormalCommit[],
): Promise<IngestResult> {
  let created = 0;
  let updated = 0;

  for (const commit of commits) {
    const existing = await db.commit.findUnique({
      where: { repoId_sha: { repoId, sha: commit.sha } },
      select: { id: true },
    });

    const row = await db.commit.upsert({
      where: { repoId_sha: { repoId, sha: commit.sha } },
      create: {
        repoId,
        sha: commit.sha,
        message: commit.message,
        author: commit.author,
        authorEmail: commit.authorEmail,
        committedAt: commit.committedAt,
        additions: commit.additions,
        deletions: commit.deletions,
        // A commit that has arrived again is by definition not orphaned any more.
        orphanedAt: null,
      },
      update: {
        message: commit.message,
        author: commit.author,
        committedAt: commit.committedAt,
        ...(commit.additions === null ? {} : { additions: commit.additions }),
        ...(commit.deletions === null ? {} : { deletions: commit.deletions }),
        orphanedAt: null,
      },
      select: { id: true },
    });

    if (existing === null) created += 1;
    else updated += 1;

    for (const file of commit.files) {
      await db.commitFile.upsert({
        where: { commitId_path: { commitId: row.id, path: file.path } },
        create: {
          commitId: row.id,
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
        },
        update: { status: file.status },
      });
    }
  }

  return { created, updated };
}

export interface GhCheckRun {
  readonly head_sha?: string;
  readonly name?: string;
  readonly conclusion?: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly details_url?: string | null;
  readonly external_id?: string | null;
  readonly id?: number;
}

/** GitHub's conclusions, mapped to the enum. An unknown one is stored as null, not invented. */
function conclusionOf(value: string | null | undefined): CheckConclusion | null {
  const known: readonly string[] = [
    'success',
    'failure',
    'cancelled',
    'skipped',
    'timed_out',
    'action_required',
    'neutral',
    'stale',
  ];
  return value !== null && value !== undefined && known.includes(value)
    ? (value as CheckConclusion)
    : null;
}

export async function ingestCheckRuns(
  db: Db,
  repoId: string,
  runs: readonly GhCheckRun[],
): Promise<IngestResult> {
  let created = 0;
  let updated = 0;

  for (const run of runs) {
    const sha = run.head_sha;
    const name = run.name;
    if (sha === undefined || name === undefined) continue;

    const existing = await db.checkRun.findUnique({
      where: { repoId_commitSha_name: { repoId, commitSha: sha, name } },
      select: { id: true },
    });

    await db.checkRun.upsert({
      where: { repoId_commitSha_name: { repoId, commitSha: sha, name } },
      create: {
        repoId,
        commitSha: sha,
        name,
        conclusion: conclusionOf(run.conclusion),
        startedAt: run.started_at === null || run.started_at === undefined ? null : new Date(run.started_at),
        completedAt:
          run.completed_at === null || run.completed_at === undefined ? null : new Date(run.completed_at),
        detailsUrl: run.details_url ?? null,
        externalId: run.external_id ?? (run.id === undefined ? null : String(run.id)),
      },
      // A re-run of the same check replaces its conclusion: the current state of that check on
      // that commit is what anybody asking "is it green" means.
      update: {
        conclusion: conclusionOf(run.conclusion),
        completedAt:
          run.completed_at === null || run.completed_at === undefined ? null : new Date(run.completed_at),
        detailsUrl: run.details_url ?? null,
      },
    });

    if (existing === null) created += 1;
    else updated += 1;
  }

  return { created, updated };
}

export interface GhRelease {
  readonly tag_name?: string;
  readonly name?: string | null;
  readonly body?: string | null;
  readonly published_at?: string | null;
  readonly prerelease?: boolean;
  readonly draft?: boolean;
}

export async function ingestReleases(
  db: Db,
  repoId: string,
  releases: readonly GhRelease[],
): Promise<IngestResult> {
  let created = 0;
  let updated = 0;

  for (const release of releases) {
    const tag = release.tag_name;
    // A draft has no tag anybody can reach, and publishing it will send its own event.
    if (tag === undefined || release.draft === true) continue;

    const existing = await db.release.findUnique({
      where: { repoId_tag: { repoId, tag } },
      select: { id: true },
    });

    await db.release.upsert({
      where: { repoId_tag: { repoId, tag } },
      create: {
        repoId,
        tag,
        name: release.name ?? null,
        bodyMd: release.body ?? null,
        publishedAt:
          release.published_at === null || release.published_at === undefined
            ? null
            : new Date(release.published_at),
        prerelease: release.prerelease ?? false,
      },
      update: {
        name: release.name ?? null,
        bodyMd: release.body ?? null,
        prerelease: release.prerelease ?? false,
      },
    });

    if (existing === null) created += 1;
    else updated += 1;
  }

  return { created, updated };
}

/** Find the repo a payload names, or null when it is one nothing is linked to. */
export async function repoFor(
  db: Db | TransactionClient,
  fullName: string | undefined,
): Promise<{ id: string; projectId: string; fullName: string } | null> {
  if (fullName === undefined) return null;
  return db.repo.findFirst({
    where: { fullName, deletedAt: null },
    select: { id: true, projectId: true, fullName: true },
  });
}
