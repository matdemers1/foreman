import type { GitHubClient } from '../adapters/github.js';
import { GitHubNotConfigured } from '../adapters/github.js';
import type { Db } from '../db.js';
import { proposalsFor, proposeAttributions } from '../domain/attribution.js';
import {
  ingestCheckRuns,
  ingestCommits,
  ingestReleases,
  normalizeCommit,
  repoFor,
  type GhCheckRun,
  type GhCommit,
  type GhRelease,
} from '../domain/ingest.js';
import type { JobDefinition, StageContext } from './types.js';

/**
 * The ingest jobs (T-5.3 … T-5.7).
 *
 * Every one is a sequence of named stages so a failure re-runs *alone* (FRM-REQ-141). A backfill
 * that ingests three thousand commits and then fails on releases must not re-ingest the commits —
 * not because it would be wrong (the writes are idempotent) but because it would take an hour and
 * people stop retrying things that take an hour.
 */

export interface IngestDeps {
  /** Absent when the App is not configured. The webhook path still works; backfill does not. */
  readonly github: GitHubClient | null;
}

function githubOf(deps: IngestDeps): GitHubClient {
  if (deps.github === null) throw new GitHubNotConfigured();
  return deps.github;
}

/** The payload a webhook job carries, as the receiver enqueued it. */
interface WebhookPayload {
  readonly event: string;
  readonly delivery: string;
  readonly body: Record<string, unknown>;
}

function webhookPayload(ctx: StageContext): WebhookPayload {
  const { event, delivery, body } = ctx.payload as Partial<WebhookPayload>;
  return {
    event: event ?? 'unknown',
    delivery: delivery ?? '',
    body: body ?? {},
  };
}

function repoFullName(body: Record<string, unknown>): string | undefined {
  const repository = body['repository'];
  if (typeof repository !== 'object' || repository === null) return undefined;
  const fullName = (repository as { full_name?: unknown }).full_name;
  return typeof fullName === 'string' ? fullName : undefined;
}

// ─── One webhook delivery ────────────────────────────────────────────────────

/**
 * The webhook path takes no GitHub client on purpose: the delivery carries everything it needs.
 * An ingest that called back to the API to read what the payload already said would turn a rate
 * limit into missing commits.
 */
export function ingestWebhookJob(): JobDefinition {
  return {
    kind: 'ingest-webhook',
    stages: [
      {
        name: 'store',
        async run(ctx) {
          const { event, body } = webhookPayload(ctx);
          const repo = await repoFor(ctx.db, repoFullName(body));

          if (repo === null) {
            // A webhook for a repository nothing is linked to is not an error. Recorded so the
            // reason is visible rather than looking like a dropped delivery.
            return { skipped: 'no linked repo', fullName: repoFullName(body) ?? null };
          }

          switch (event) {
            case 'push':
              return ingestPush(ctx.db, repo.id, body);
            case 'check_run':
            case 'check_suite':
              return ingestCheckRunEvent(ctx.db, repo.id, body);
            case 'release':
              return ingestReleaseEvent(ctx.db, repo.id, body);
            default:
              return { skipped: `unhandled event ${event}` };
          }
        },
      },
      {
        /**
         * Attribution runs as its own stage, after the commits are stored.
         *
         * Separate because it is the part most likely to change: when the ranking is wrong, the
         * fix is to re-run this stage over stored commits, not to re-fetch anything from GitHub.
         */
        name: 'attribute',
        async run(ctx) {
          const { event, body } = webhookPayload(ctx);
          if (event !== 'push') return { skipped: 'not a push' };

          const repo = await repoFor(ctx.db, repoFullName(body));
          if (repo === null) return { skipped: 'no linked repo' };

          const shas = commitsIn(body)
            .map((c) => normalizeCommit(c)?.sha)
            .filter((sha): sha is string => sha !== undefined);

          return attributeShas(ctx.db, repo.id, repo.projectId, shas);
        },
      },
    ],
  };
}

function commitsIn(body: Record<string, unknown>): GhCommit[] {
  const commits = body['commits'];
  return Array.isArray(commits) ? (commits as GhCommit[]) : [];
}

async function ingestPush(db: Db, repoId: string, body: Record<string, unknown>) {
  const normalized = commitsIn(body)
    .map((c) => normalizeCommit(c))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const result = await ingestCommits(db, repoId, normalized);
  return { ...result, shas: normalized.map((c) => c.sha.slice(0, 12)) };
}

async function ingestCheckRunEvent(db: Db, repoId: string, body: Record<string, unknown>) {
  const run = body['check_run'] ?? body['check_suite'];
  if (typeof run !== 'object' || run === null) return { skipped: 'no check run in payload' };
  return ingestCheckRuns(db, repoId, [run]);
}

async function ingestReleaseEvent(db: Db, repoId: string, body: Record<string, unknown>) {
  const release = body['release'];
  if (typeof release !== 'object' || release === null) return { skipped: 'no release in payload' };
  return ingestReleases(db, repoId, [release]);
}

/** Propose attributions for a set of stored commits. Shared by webhook, backfill and reconcile. */
export async function attributeShas(
  db: Db,
  repoId: string,
  projectId: string,
  shas: readonly string[],
): Promise<{ examined: number; proposed: number }> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { code: true },
  });

  let proposed = 0;
  const commits = await db.commit.findMany({
    where: { repoId, sha: { in: [...shas] } },
    include: { files: { select: { path: true } } },
  });

  for (const commit of commits) {
    const proposals = await proposalsFor(db, projectId, project.code, {
      id: commit.id,
      sha: commit.sha,
      message: commit.message,
      files: commit.files.map((f) => f.path),
    });
    proposed += await proposeAttributions(db, commit.id, proposals);
  }

  return { examined: commits.length, proposed };
}

// ─── Backfill (T-5.4) ────────────────────────────────────────────────────────

interface RepoPayload {
  readonly repoId?: string;
}

async function linkedRepo(ctx: StageContext) {
  const { repoId } = ctx.payload as RepoPayload;
  if (repoId === undefined) throw new Error('this job needs a repoId in its payload');
  return ctx.db.repo.findUniqueOrThrow({
    where: { id: repoId },
    select: { id: true, projectId: true, fullName: true, backfilledAt: true },
  });
}

export function backfillJob(deps: IngestDeps): JobDefinition {
  return {
    kind: 'backfill-repo',
    stages: [
      {
        name: 'commits',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const github = githubOf(deps);

          // The list endpoint gives no file lists, and fetching each commit individually would be
          // one request per commit. The list is what the mappers run on; a commit's files arrive
          // with its push, or from the file-overlap signal being absent for old history — which
          // is honest, since nobody declared files for work done a year ago either.
          const raw = await github.paginate<GhCommit>(`/repos/${repo.fullName}/commits`);
          const normalized = raw
            .map((c) => normalizeCommit(c))
            .filter((c): c is NonNullable<typeof c> => c !== null);

          const result = await ingestCommits(ctx.db, repo.id, normalized);
          return { ...result, fetched: raw.length };
        },
      },
      {
        name: 'releases',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const raw = await githubOf(deps).paginate<GhRelease>(`/repos/${repo.fullName}/releases`);
          return ingestReleases(ctx.db, repo.id, raw);
        },
      },
      {
        name: 'check-runs',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const github = githubOf(deps);

          // Check runs are per-commit, and history is long. The recent window is what "is it
          // green" is asked about; the rest is archaeology nobody performs.
          const recent = await ctx.db.commit.findMany({
            where: { repoId: repo.id },
            orderBy: { committedAt: 'desc' },
            take: 100,
            select: { sha: true },
          });

          let created = 0;
          let updated = 0;
          for (const commit of recent) {
            const body = await github.get<{ check_runs?: GhCheckRun[] }>(
              `/repos/${repo.fullName}/commits/${commit.sha}/check-runs`,
            );
            const result = await ingestCheckRuns(ctx.db, repo.id, body.check_runs ?? []);
            created += result.created;
            updated += result.updated;
          }
          return { created, updated, commitsExamined: recent.length };
        },
      },
      {
        name: 'attribute',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const commits = await ctx.db.commit.findMany({
            where: { repoId: repo.id },
            select: { sha: true },
          });
          return attributeShas(ctx.db, repo.id, repo.projectId, commits.map((c) => c.sha));
        },
      },
      {
        name: 'mark-backfilled',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          // Last, and only on success: a half-finished backfill that claimed to be complete would
          // leave a permanent hole that no reconcile knows to look for.
          await ctx.db.repo.update({
            where: { id: repo.id },
            data: { backfilledAt: new Date() },
          });
          return { backfilledAt: new Date().toISOString() };
        },
      },
    ],
  };
}

// ─── Reconcile (T-5.5) and orphan detection (T-5.6) ──────────────────────────

export function reconcileJob(deps: IngestDeps): JobDefinition {
  return {
    kind: 'reconcile-repo',
    stages: [
      {
        /**
         * Re-read recent history and store whatever is missing (FRM-REQ-103).
         *
         * This is what heals a dropped webhook. It is deliberately cheap and frequent rather than
         * exhaustive and rare: a gap that takes a month to notice is a gap nobody trusts the data
         * through.
         */
        name: 'recent-commits',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const github = githubOf(deps);

          const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
          const raw = await github.paginate<GhCommit>(`/repos/${repo.fullName}/commits`, { since });
          const normalized = raw
            .map((c) => normalizeCommit(c))
            .filter((c): c is NonNullable<typeof c> => c !== null);

          const result = await ingestCommits(ctx.db, repo.id, normalized);
          return {
            ...result,
            since,
            // `created` on a reconcile means a delivery was dropped. Worth reporting as a number
            // somebody can watch rather than buried in a log line.
            healed: result.created,
          };
        },
      },
      {
        /**
         * Commits Foreman holds that the remote no longer has (T-5.6, FRM-REQ-105).
         *
         * **Marked, never deleted.** An attribution, a fix-commit reference or a release note may
         * already cite the SHA, and deleting the row turns a rewritten history into a wrong one.
         */
        name: 'orphans',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const github = githubOf(deps);

          const recent = await ctx.db.commit.findMany({
            where: { repoId: repo.id, orphanedAt: null },
            orderBy: { committedAt: 'desc' },
            take: 200,
            select: { id: true, sha: true },
          });

          const orphaned: string[] = [];
          for (const commit of recent) {
            try {
              await github.get(`/repos/${repo.fullName}/commits/${commit.sha}`);
            } catch (error) {
              // Only a 404 means "gone". A 403 or a timeout means "ask again later", and marking
              // on those would orphan a repository's whole history during a rate limit.
              if (error instanceof Error && 'status' in error && error.status === 404) {
                await ctx.db.commit.update({
                  where: { id: commit.id },
                  data: { orphanedAt: new Date() },
                });
                orphaned.push(commit.sha.slice(0, 12));
              } else {
                throw error;
              }
            }
          }
          return { examined: recent.length, orphaned };
        },
      },
      {
        name: 'attribute',
        async run(ctx) {
          const repo = await linkedRepo(ctx);
          const commits = await ctx.db.commit.findMany({
            where: {
              repoId: repo.id,
              orphanedAt: null,
              // Only what nothing has proposed for yet: re-proposing over the whole history on
              // every reconcile would re-offer everything somebody has already worked through.
              attributions: { none: {} },
            },
            select: { sha: true },
          });
          return attributeShas(ctx.db, repo.id, repo.projectId, commits.map((c) => c.sha));
        },
      },
    ],
  };
}
