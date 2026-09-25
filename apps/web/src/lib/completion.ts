/**
 * How finished a set of tasks is, as a whole-number percentage.
 *
 * **Done and cancelled are both closed.** A cancelled task is one nobody is going to do, so it
 * cannot hold a phase short of finished: a phase of eighteen done and seven cancelled is 100%, not
 * the 72% it read when only `done` counted over a total that included the cancelled seven. Only
 * `todo`, `in_progress` and `blocked` leave work open.
 *
 * Floored, not rounded, so 199 of 200 reads 99% — 100% is a claim that nothing is left.
 */
export function percentClosed(done: number, cancelled: number, total: number): number {
  if (total === 0) return 0;
  return Math.floor(((done + cancelled) / total) * 100);
}
