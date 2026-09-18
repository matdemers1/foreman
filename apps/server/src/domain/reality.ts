import type { Db } from '../db.js';
import { NotFound } from './errors.js';
import { findProject } from './projects.js';

/**
 * What is actually running, and what happened lately (T-5.11, T-5.12).
 *
 * The questions these answer are the ones asked out loud: "is it green", "what is deployed", "what
 * went into that release", "has anybody touched this in a month".
 */

export interface CiState {
  readonly conclusion: string | null;
  readonly commitSha: string | null;
  readonly name: string | null;
  readonly at: string | null;
  /**
   * True when nothing is known. **A third state, not a green** (FRM-REQ-111): a project with no
   * check runs ingested is not passing, and rendering it green is the single most expensive lie a
   * dashboard can tell.
   */
  readonly unknown: boolean;
}

export async function ciFor(db: Db, projectId: string): Promise<CiState> {
  const latest = await db.checkRun.findFirst({
    where: { repo: { projectId, deletedAt: null }, completedAt: { not: null } },
    orderBy: { completedAt: 'desc' },
  });

  if (latest === null) {
    return { conclusion: null, commitSha: null, name: null, at: null, unknown: true };
  }
  return {
    conclusion: latest.conclusion,
    commitSha: latest.commitSha,
    name: latest.name,
    at: latest.completedAt?.toISOString() ?? null,
    unknown: latest.conclusion === null,
  };
}

export interface Cadence {
  readonly lastCommitAt: string | null;
  readonly commitsLast7: number;
  readonly commitsLast30: number;
  /** Days since the last commit. Null when nothing has ever been ingested. */
  readonly dormantDays: number | null;
}

/**
 * Commit cadence per project (T-5.12, FRM-REQ-113).
 *
 * The requirement is "a dormant project is visibly dormant". A count of commits says a project is
 * busy; only the *gap* says one has stopped, and stopping is the thing worth seeing across a
 * portfolio of nineteen projects.
 */
export async function cadenceFor(db: Db, projectId: string): Promise<Cadence> {
  const where = { repo: { projectId, deletedAt: null }, orphanedAt: null };
  const now = Date.now();
  const since = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);

  const [latest, last7, last30] = await Promise.all([
    db.commit.findFirst({ where, orderBy: { committedAt: 'desc' }, select: { committedAt: true } }),
    db.commit.count({ where: { ...where, committedAt: { gte: since(7) } } }),
    db.commit.count({ where: { ...where, committedAt: { gte: since(30) } } }),
  ]);

  return {
    lastCommitAt: latest?.committedAt.toISOString() ?? null,
    commitsLast7: last7,
    commitsLast30: last30,
    dormantDays:
      latest === null
        ? null
        : Math.floor((now - latest.committedAt.getTime()) / (24 * 60 * 60 * 1000)),
  };
}

export interface ReleaseNotes {
  readonly from: string | null;
  readonly to: string;
  readonly tasks: { humanId: string; title: string; status: string }[];
  readonly commits: number;
  /** Commits in the range that no confirmed attribution explains. Said, not hidden. */
  readonly unattributed: number;
}

/**
 * Release notes from the tasks whose commits landed between two tags (T-5.12, FRM-REQ-112).
 *
 * **Confirmed attributions only.** Notes assembled from proposals would list work somebody has not
 * agreed was done — which is exactly the claim ADR-005 exists to prevent, and a release note is
 * the worst place to make it.
 *
 * The unattributed count ships with the notes rather than being quietly dropped: "these fourteen
 * tasks, and thirty commits we cannot explain" is an honest release note. The first half alone is
 * not.
 */
export async function releaseNotes(db: Db, code: string, tag: string): Promise<ReleaseNotes> {
  const project = await findProject(db, code);

  const release = await db.release.findFirst({
    where: { tag, repo: { projectId: project.id, deletedAt: null } },
    include: { repo: { select: { id: true } } },
  });
  if (release === null) throw new NotFound(`release ${tag}`);

  // The previous release on the same repo, by publication date. Null for the first one, where the
  // range is the whole history.
  const previous = await db.release.findFirst({
    where: {
      repoId: release.repo.id,
      publishedAt: { lt: release.publishedAt ?? new Date() },
    },
    orderBy: { publishedAt: 'desc' },
  });

  const commits = await db.commit.findMany({
    where: {
      repoId: release.repo.id,
      orphanedAt: null,
      committedAt: {
        ...(previous === null || previous.publishedAt === null
          ? {}
          : { gt: previous.publishedAt }),
        ...(release.publishedAt === null ? {} : { lte: release.publishedAt }),
      },
    },
    include: {
      attributions: {
        where: { confirmed: true },
        include: { task: { select: { humanId: true, title: true, status: true } } },
      },
    },
  });

  const tasks = new Map<string, { humanId: string; title: string; status: string }>();
  let unattributed = 0;
  for (const commit of commits) {
    if (commit.attributions.length === 0) unattributed += 1;
    for (const attribution of commit.attributions) tasks.set(attribution.task.humanId, attribution.task);
  }

  return {
    from: previous?.tag ?? null,
    to: release.tag,
    tasks: [...tasks.values()].sort((a, b) => a.humanId.localeCompare(b.humanId)),
    commits: commits.length,
    unattributed,
  };
}
