import type { Db } from '../db.js';
import { NotFound } from './errors.js';

/**
 * Proposing that a finding recurs elsewhere (T-6.7, FRM-REQ-121, FRM-REQ-122).
 *
 * The motivating case is real: Bindery's *"five modal overlays have no dialog semantics"* is a
 * question worth asking of every React app in the ecosystem. Nothing on the market does this,
 * because it only works when one system holds every project's findings at once.
 *
 * **No model is called, and none may be** (FRM-REQ-013, FRM-REQ-122). Not for cost — because the
 * judgement is not Foreman's to make. Whether Bindery's modal problem exists in D3 Auth is a
 * question answered by reading D3 Auth's code, and the thing with that code in front of it is
 * Claude, through the MCP. Foreman's job is to notice the *shape* and hand it over.
 *
 * So the scoring is deterministic arithmetic over three signals, and a test asserts no outbound
 * call exists:
 *
 * | Signal | Weight | Why |
 * |---|:-:|---|
 * | Lens overlap | 0.4 | Two accessibility findings are more alike than two findings that share a word |
 * | Title/observed text overlap | 0.4 | The actual subject, after the words every finding uses |
 * | Path-shape overlap | 0.2 | `web/src/features/**` in both is weak, but not nothing |
 */

/**
 * Words that carry no signal here.
 *
 * The usual English stopwords plus the vocabulary *every* finding in this corpus uses — "finding",
 * "severity", "should", "api". Without them, every pair of findings scores a spurious 0.3 for
 * agreeing that they are findings.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'it', 'its', 'this', 'that',
  'these', 'those', 'has', 'have', 'had', 'no', 'not', 'can', 'could', 'would', 'should', 'shall',
  'will', 'may', 'might', 'do', 'does', 'did', 'if', 'then', 'when', 'where', 'which', 'who',
  'what', 'how', 'why', 'all', 'any', 'each', 'every', 'some', 'one', 'two', 'there', 'their',
  // Corpus-specific: present in nearly every finding, so they discriminate nothing.
  'finding', 'findings', 'severity', 'api', 'app', 'code', 'file', 'files', 'line', 'lines',
  'issue', 'problem', 'fix', 'fixed', 'error', 'errors', 'check', 'checks', 'test', 'tests',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/[\s_-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/** Jaccard: shared over total. Symmetric, bounded, and needs no corpus statistics to compute. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The directory shape of a path, without its filename: `web/src/features/edit`. */
function shapeOf(path: string): string {
  const parts = path.split('/');
  return parts.slice(0, -1).join('/');
}

export interface RecurrenceCandidate {
  readonly humanId: string;
  readonly project: string;
  readonly title: string;
  readonly severity: string;
  readonly status: string;
  readonly score: number;
  /** What matched, so a person — or Claude — can judge rather than trust the number. */
  readonly because: {
    readonly lenses: string[];
    readonly words: string[];
    readonly pathShapes: string[];
  };
}

export interface RecurrenceResult {
  readonly source: { humanId: string; project: string; title: string };
  readonly candidates: readonly RecurrenceCandidate[];
  /**
   * Said in the payload, not just in a comment: the caller is being handed something to judge, and
   * whoever reads this should know no model judged it first.
   */
  readonly method: 'lens, text and path overlap — no model was called';
}

const WEIGHT = { lens: 0.4, text: 0.4, path: 0.2 };

/** Below this, two findings merely share a word. Tuned so a typical pair scores nothing. */
const THRESHOLD = 0.12;

export async function recurrencesOf(
  db: Db,
  humanId: string,
  limit = 10,
): Promise<RecurrenceResult> {
  const source = await db.finding.findFirst({
    where: { humanId, deletedAt: null },
    include: {
      project: { select: { id: true, code: true } },
      locations: { select: { path: true } },
    },
  });
  if (source === null) throw new NotFound(humanId);

  // Every other project's findings. Same-project recurrence is a duplicate, which is a different
  // problem and not this one.
  const others = await db.finding.findMany({
    where: {
      deletedAt: null,
      projectId: { not: source.projectId },
      project: { deletedAt: null },
    },
    include: {
      project: { select: { code: true } },
      locations: { select: { path: true } },
    },
  });

  const sourceLenses = new Set(source.lenses);
  const sourceWords = tokens(`${source.title} ${source.observedMd ?? ''}`);
  const sourceShapes = new Set(source.locations.map((l) => shapeOf(l.path)).filter((s) => s !== ''));

  const candidates: RecurrenceCandidate[] = [];
  for (const other of others) {
    const otherLenses = new Set(other.lenses);
    const otherWords = tokens(`${other.title} ${other.observedMd ?? ''}`);
    const otherShapes = new Set(other.locations.map((l) => shapeOf(l.path)).filter((s) => s !== ''));

    const lens = jaccard(sourceLenses, otherLenses);
    const text = jaccard(sourceWords, otherWords);
    const path = jaccard(sourceShapes, otherShapes);
    const score = lens * WEIGHT.lens + text * WEIGHT.text + path * WEIGHT.path;

    if (score < THRESHOLD) continue;

    candidates.push({
      humanId: other.humanId,
      project: other.project.code,
      title: other.title,
      severity: other.severity,
      status: other.status,
      score: Math.round(score * 1000) / 1000,
      because: {
        lenses: [...sourceLenses].filter((l) => otherLenses.has(l)),
        words: [...sourceWords].filter((w) => otherWords.has(w)).slice(0, 12),
        pathShapes: [...sourceShapes].filter((s) => otherShapes.has(s)),
      },
    });
  }

  return {
    source: { humanId: source.humanId, project: source.project.code, title: source.title },
    candidates: candidates
      .sort((a, b) => b.score - a.score || a.humanId.localeCompare(b.humanId))
      .slice(0, limit),
    method: 'lens, text and path overlap — no model was called',
  };
}

// ─── The regression watch (T-6.8, FRM-REQ-123) ─────────────────────────────

export interface RegressionFlag {
  readonly humanId: string;
  readonly project: string;
  readonly title: string;
  readonly path: string;
  readonly changedBy: { sha: string; message: string; at: string }[];
}

/**
 * Fixed findings whose location file has changed since the fix (FRM-REQ-123).
 *
 * Deliberately a flag and not an alarm: a file changing after a fix is normal, and most of these
 * are nothing. It is worth surfacing because the ones that are not nothing are invisible otherwise
 * — a fix undone by a later refactor leaves no trace at all.
 */
export async function regressionWatch(db: Db, code?: string): Promise<RegressionFlag[]> {
  const fixed = await db.finding.findMany({
    where: {
      deletedAt: null,
      status: 'fixed',
      fixedCommitSha: { not: null },
      project: { deletedAt: null, ...(code === undefined ? {} : { code }) },
    },
    include: {
      project: { select: { id: true, code: true } },
      locations: { select: { id: true, path: true } },
    },
  });

  const flags: RegressionFlag[] = [];
  for (const finding of fixed) {
    if (finding.fixedCommitSha === null) continue;

    const fixCommit = await db.commit.findFirst({
      where: {
        sha: { startsWith: finding.fixedCommitSha },
        repo: { projectId: finding.project.id, deletedAt: null },
      },
      select: { committedAt: true },
    });
    // Not ingested: nothing to compare against, and guessing would produce a flag on every fix.
    if (fixCommit === null) continue;

    for (const location of finding.locations) {
      const since = await db.commit.findMany({
        where: {
          repo: { projectId: finding.project.id, deletedAt: null },
          orphanedAt: null,
          committedAt: { gt: fixCommit.committedAt },
          files: { some: { path: location.path } },
        },
        orderBy: { committedAt: 'desc' },
        take: 5,
        select: { sha: true, message: true, committedAt: true },
      });
      if (since.length === 0) continue;

      flags.push({
        humanId: finding.humanId,
        project: finding.project.code,
        title: finding.title,
        path: location.path,
        changedBy: since.map((c) => ({
          sha: c.sha.slice(0, 12),
          message: c.message.split('\n')[0]?.slice(0, 120) ?? '',
          at: c.committedAt.toISOString(),
        })),
      });
    }
  }

  return flags;
}
