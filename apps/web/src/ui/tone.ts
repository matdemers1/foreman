/**
 * One place that decides what colour a status is.
 *
 * Colour is the fastest thing on a screen to read, and it only works if it means the same thing
 * everywhere. These mappings were written down because they were previously made up per screen:
 * `lifecycle === 'building' ? 'attention' : 'neutral'` appeared in three files, so `deployed` and
 * `scrapped` rendered identically — the two states furthest apart in meaning.
 *
 * **Colour is never the only signal.** Every badge carries its word, every chart segment has a
 * legend, and the charts below label their own totals. Someone who cannot separate green from red
 * loses speed here, not information (WCAG 1.4.1).
 */

/**
 * The console's status tones.
 *
 * `@d3cloud/ui`'s `Badge` offers three — neutral, attention, danger — which is right for a library
 * that must stay legible everywhere and wrong for a screen whose whole job is "is this healthy".
 * There is no green in it, so `deployed` and `scrapped` render identically. `Pill` in `viz.tsx`
 * takes these five and paints from tokens; `Badge` is still correct wherever three is enough.
 */
export type Tone = 'neutral' | 'success' | 'accent' | 'warning' | 'danger';

/** The chart palette, as CSS custom properties. Tokens only — the usage gate refuses a hex. */
export const SERIES = {
  done: 'var(--color-success)',
  active: 'var(--color-accent)',
  waiting: 'var(--color-fg-faint)',
  blocked: 'var(--color-danger)',
  warning: 'var(--color-warning)',
  info: 'var(--color-info)',
  quiet: 'var(--color-border)',
} as const;

export function lifecycleTone(lifecycle: string): Tone {
  switch (lifecycle) {
    case 'deployed':
      return 'success';
    case 'building':
      return 'accent';
    case 'scaffolded':
    case 'planned':
      return 'neutral';
    case 'parked':
      return 'warning';
    case 'scrapped':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function phaseStatusTone(status: string): Tone {
  switch (status) {
    case 'complete':
      return 'success';
    case 'active':
      return 'accent';
    case 'parked':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function taskStatusTone(status: string): Tone {
  switch (status) {
    case 'done':
      return 'success';
    case 'in_progress':
      return 'accent';
    case 'blocked':
      return 'danger';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function severityTone(severity: string): Tone {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function findingStatusTone(status: string): Tone {
  switch (status) {
    case 'fixed':
      return 'success';
    case 'open':
      return 'danger';
    case 'deferred':
      return 'warning';
    default:
      return 'neutral';
  }
}

/**
 * CI, where the third answer matters most.
 *
 * `unknown` is not `success`. A project nothing has been ingested for has not passed; it has not
 * been asked. Rendering the two the same is the single most misleading thing this console could do.
 */
export function ciTone(conclusion: string | null, unknown: boolean): Tone {
  if (unknown) return 'neutral';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
      return 'danger';
    case 'cancelled':
    case 'skipped':
      return 'neutral';
    default:
      return 'warning';
  }
}

/** Human-readable age. `null` is an em dash, never "just now". */
export function relativeDay(iso: string | null): string {
  if (iso === null) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)}d ago`;
  if (days < 365) return `${String(Math.floor(days / 30))}mo ago`;
  return `${String(Math.floor(days / 365))}y ago`;
}
