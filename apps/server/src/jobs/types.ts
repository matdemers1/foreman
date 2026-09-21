import type { Db } from '../db.js';
import type { Logger } from '../logger.js';

/**
 * A job is an ordered list of named stages. Each stage is recorded separately, keeps its own output,
 * and **can be replayed alone** (FRM-REQ-141) — the reason this is a table and not Redis. When a
 * six-hour backfill fails on its last step, re-running the whole job is a punishment, not a retry.
 */

export interface StageContext {
  readonly db: Db;
  readonly logger: Logger;
  readonly jobId: string;
  /** The job's payload, as enqueued. */
  readonly payload: Record<string, unknown>;
  /** Outputs of the stages that already succeeded, by stage name. */
  readonly priorOutput: Readonly<Record<string, unknown>>;
}

export type StageHandler = (ctx: StageContext) => Promise<unknown>;

/**
 * "There is nothing here to do", raised by a stage — not a failure.
 *
 * Two situations produce it, and both were being dead-lettered. An optional integration that is
 * not configured: `GitHubNotConfigured` already says in its own comment that "not configured is a
 * normal state", and the runner did not know. And a job whose subject has since been deleted: the
 * three `reconcile-repo` rows sitting failed in production name a repo that was removed with the
 * example project at the cutover, and they held `/health` at `ok: false` from that day on.
 *
 * A health endpoint that is permanently red for an expected reason is one nobody reads, which is
 * the same argument as an error filter full of things that then succeed.
 */
export class NothingToDo extends Error {
  constructor(readonly because: string) {
    super(because);
    this.name = 'NothingToDo';
  }
}

export interface StageDefinition {
  readonly name: string;
  readonly run: StageHandler;
}

export interface JobDefinition {
  readonly kind: string;
  readonly stages: readonly StageDefinition[];
}

export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();

  register(definition: JobDefinition): this {
    if (definition.stages.length === 0) {
      throw new Error(`job kind "${definition.kind}" has no stages`);
    }
    const names = new Set(definition.stages.map((s) => s.name));
    if (names.size !== definition.stages.length) {
      // Stage names address rows, so duplicates would make a replay ambiguous.
      throw new Error(`job kind "${definition.kind}" has duplicate stage names`);
    }
    this.definitions.set(definition.kind, definition);
    return this;
  }

  get(kind: string): JobDefinition {
    const definition = this.definitions.get(kind);
    if (definition === undefined) throw new Error(`no job definition registered for "${kind}"`);
    return definition;
  }

  has(kind: string): boolean {
    return this.definitions.has(kind);
  }

  kinds(): string[] {
    return [...this.definitions.keys()];
  }
}
