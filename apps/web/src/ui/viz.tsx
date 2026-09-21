import type * as React from 'react';
import type { ReactNode } from 'react';
import { Card, Stack } from '@d3cloud/ui';
import type { Tone } from './tone';

/**
 * The charts the console needs, and nothing more.
 *
 * `@d3cloud/ui` has no chart component and should not grow one for this: these are four shapes
 * drawn from numbers Foreman already computes. A charting library would be ~50 KB, a second
 * theming system to keep in step with the tokens, and a Content-Security-Policy conversation.
 *
 * Three rules hold across all of them:
 *
 * - **Colour comes from system tokens**, never a literal, so light and dark follow the console
 *   instead of a second palette. The usage gate refuses a hex, which is the right refusal.
 * - **Every chart states its own numbers**, in a legend, a centre label or a caption. A chart is
 *   a faster way to read a figure, never the only way — and a screen reader gets `role="img"`
 *   with a sentence rather than a shrug.
 * - **Zero is drawn, not hidden.** An empty ring and a bar of one flat colour both say "nothing
 *   here", and a chart that vanishes when its data is zero looks like a chart that failed.
 */

export interface Segment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

const sum = (segments: readonly Segment[]): number =>
  segments.reduce((total, segment) => total + segment.value, 0);

/**
 * A completion ring with the figure in the middle.
 *
 * The number is the point; the ring is how fast you see roughly where it is without reading. Drawn
 * as a stroked circle with `stroke-dasharray` rather than arc paths — one element per segment, no
 * trigonometry to get wrong at 0% and 100%.
 */
export function Donut({
  segments,
  label,
  caption,
  size = 104,
}: {
  segments: readonly Segment[];
  /** The figure in the centre. Usually a percentage or a count. */
  label: ReactNode;
  /** The small line under it. */
  caption?: ReactNode;
  size?: number;
}) {
  const total = sum(segments);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const described = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => `${segment.label}: ${String(segment.value)}`)
    .join(', ');

  let offset = 0;

  return (
    <div className="fm-donut" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        role="img"
        aria-label={described === '' ? 'Nothing recorded yet' : described}
      >
        {/* The track. Always drawn, so an empty chart reads as empty rather than as broken. */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="10"
        />
        {total > 0 &&
          segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${String(length)} ${String(circumference - length)}`;
            // -90deg so the first segment starts at twelve o'clock, which is where a reader
            // expects a ring to begin.
            const rotation = (offset / circumference) * 360 - 90;
            offset += length;
            if (segment.value === 0) return null;
            return (
              <circle
                key={segment.label}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth="10"
                strokeDasharray={dash}
                transform={`rotate(${String(rotation)} 50 50)`}
              />
            );
          })}
      </svg>
      <div className="fm-donut__centre">
        <span className="fm-donut__label">{label}</span>
        {caption !== undefined && <span className="fm-donut__caption">{caption}</span>}
      </div>
    </div>
  );
}

/**
 * A stacked bar with a legend, for a distribution across a handful of states.
 *
 * Better than a ring when the question is "what is the mix" rather than "how far along", and it
 * carries its own counts so the legend is the table you would otherwise have written.
 */
export function SegmentBar({
  segments,
  height = 8,
  showLegend = true,
}: {
  segments: readonly Segment[];
  height?: number;
  showLegend?: boolean;
}) {
  const total = sum(segments);
  const present = segments.filter((segment) => segment.value > 0);
  const described =
    present.length === 0
      ? 'Nothing recorded yet'
      : present.map((s) => `${s.label}: ${String(s.value)}`).join(', ');

  return (
    <Stack gap="8">
      <div
        className="fm-bar"
        style={{ height }}
        role="img"
        aria-label={described}
      >
        {total === 0 ? (
          <span className="fm-bar__empty" />
        ) : (
          present.map((segment) => (
            <span
              key={segment.label}
              className="fm-bar__segment"
              style={{
                width: `${String((segment.value / total) * 100)}%`,
                background: segment.color,
              }}
            />
          ))
        )}
      </div>
      {showLegend && (
        <ul className="fm-legend">
          {segments.map((segment) => (
            <li key={segment.label} className="fm-legend__item">
              <span className="fm-legend__swatch" style={{ background: segment.color }} />
              {segment.label}
              <span className="fm-legend__value">{segment.value}</span>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

/**
 * Activity over time, as a row of bars.
 *
 * Deliberately unlabelled on the x axis: the shape is the message — steady, spiky, or stopped —
 * and dates under fourteen bars are noise. The `aria-label` carries the total and the span.
 */
export function ActivityBars({
  values,
  label,
  height = 36,
}: {
  values: readonly number[];
  label: string;
  height?: number;
}) {
  const peak = Math.max(1, ...values);

  return (
    <div className="fm-spark" style={{ height }} role="img" aria-label={label}>
      {values.map((value, index) => (
        <span
          key={index}
          className="fm-spark__bar"
          style={{
            height: `${String(Math.max(value === 0 ? 2 : 8, (value / peak) * 100))}%`,
            background: value === 0 ? 'var(--color-border)' : 'var(--color-accent)',
          }}
        />
      ))}
    </div>
  );
}

/**
 * A labelled horizontal bar, for comparing projects against each other.
 *
 * The value sits at the end of the row rather than inside the bar, so a bar too short to hold its
 * own number still reads — which is every row with a small value, i.e. the interesting ones.
 */
export function BarRow({
  label,
  value,
  max,
  color = 'var(--color-accent)',
  href,
}: {
  label: ReactNode;
  value: number;
  max: number;
  color?: string;
  href?: string;
}) {
  const width = max <= 0 ? 0 : (value / max) * 100;
  const body = (
    <>
      <span className="fm-barrow__label">{label}</span>
      <span className="fm-barrow__track">
        <span className="fm-barrow__fill" style={{ width: `${String(width)}%`, background: color }} />
      </span>
      <span className="fm-barrow__value">{value}</span>
    </>
  );

  return href === undefined ? (
    <div className="fm-barrow">{body}</div>
  ) : (
    <a className="fm-barrow fm-barrow--link" href={href}>
      {body}
    </a>
  );
}

/**
 * One number, said loudly.
 *
 * `tone` tints the number alone, never the card: a wall of red-bordered cards is a wall nobody
 * reads, and the figure is what carries the meaning. A `href` makes the whole card the target,
 * because a statistic you cannot click is a statistic you have to go and find.
 */
export function StatCard({
  label,
  value,
  detail,
  tone = 'neutral',
  href,
  onClick,
  selected = false,
  chart,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: Tone;
  href?: string;
  /** Makes the card a button — a figure that is also the control that filters to it. */
  onClick?: () => void;
  selected?: boolean;
  /** An optional visual under the figure — a bar, a sparkline. */
  chart?: ReactNode;
}) {
  const behaviour =
    href !== undefined
      ? { href, interactive: true as const }
      : onClick !== undefined
        ? {
            interactive: true as const,
            selected,
            onClick,
            role: 'button',
            tabIndex: 0,
            'aria-pressed': selected,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            },
          }
        : {};

  return (
    <Card padding="md" {...behaviour}>
      <Stack gap="4">
        <span className="fm-stat__label">{label}</span>
        <span className={`fm-stat__value fm-stat__value--${tone}`}>{value}</span>
        {detail !== undefined && <span className="fm-stat__detail">{detail}</span>}
        {chart !== undefined && <div className="fm-stat__chart">{chart}</div>}
      </Stack>
    </Card>
  );
}

/**
 * A status pill, in the five tones the console actually needs.
 *
 * `@d3cloud/ui`'s `Badge` has three — neutral, attention, danger — and no green, so `deployed`
 * and `planned` were rendering the same grey on the one screen whose purpose is telling them
 * apart. This is the same shape in tokens, with success and accent added. `Badge` is still the
 * right choice wherever three tones are enough; this is for status.
 *
 * The word is always present. The colour is how fast you read it, never how you know what it says.
 */
export function Pill({
  tone = 'neutral',
  children,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  /** A leading dot, for a pill sitting in running text where a full tint would shout. */
  dot?: boolean;
}) {
  return (
    <span className={`fm-pill fm-pill--${tone}${dot ? ' fm-pill--dot' : ''}`}>
      {dot && <span className="fm-pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
