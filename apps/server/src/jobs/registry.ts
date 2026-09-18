import { JobRegistry } from './types.js';

/**
 * Every job kind Foreman knows. Phase 0 registers only what it can prove: a queue with no jobs is
 * untestable, so `example` exists to exercise multi-stage replay, and the later phases add ingest,
 * attribution, scans, reconcile and backup beside it.
 */
export function buildRegistry(): JobRegistry {
  const registry = new JobRegistry();

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

  return registry;
}
