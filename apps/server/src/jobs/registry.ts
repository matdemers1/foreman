import { createGitHubClient, isConfigured, type GitHubClient } from '../adapters/github.js';
import type { Config } from '../config.js';
import { backfillJob, ingestWebhookJob, reconcileJob } from './ingest.js';
import { JobRegistry } from './types.js';

/**
 * Every job kind Foreman knows.
 *
 * The GitHub client is built once and shared, because it holds the installation token: one client
 * per process refreshes one token, where a client per job would mint a new one every time and turn
 * a rate limit into a mystery.
 */
export interface RegistryDeps {
  readonly config?: Config;
  /** Swapped in tests. */
  readonly github?: GitHubClient | null;
}

export function buildRegistry(deps: RegistryDeps = {}): JobRegistry {
  const registry = new JobRegistry();

  const github =
    deps.github !== undefined
      ? deps.github
      : deps.config !== undefined && isConfigured(deps.config)
        ? createGitHubClient({ config: deps.config })
        : null;

  registry.register({
    kind: 'example',
    stages: [
      { name: 'first', run: () => Promise.resolve({ step: 1 }) },
      {
        name: 'second',
        run: (ctx) => Promise.resolve({ step: 2, sawFirst: ctx.priorOutput['first'] !== undefined }),
      },
      { name: 'third', run: () => Promise.resolve({ step: 3 }) },
    ],
  });

  registry.register(ingestWebhookJob());
  registry.register(backfillJob({ github }));
  registry.register(reconcileJob({ github }));

  return registry;
}
