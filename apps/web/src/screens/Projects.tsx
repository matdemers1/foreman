import { useState } from 'react';
import {
  Card,
  Cluster,
  EmptyState,
  Grid,
  Page,
  PageHeader,
  SegmentedControl,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type PortfolioRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Donut, Pill, SegmentBar } from '../ui/viz';
import { ciTone, lifecycleTone, relativeDay, SERIES } from '../ui/tone';

/**
 * Every project, as a card each.
 *
 * This was a ten-column table, which is the right shape for comparing one number across projects
 * and the wrong shape for the question actually asked here — *how is this project doing* — because
 * answering it meant reading across a row and holding ten headers in your head.
 *
 * A card answers it in one look: how far through its phase, what the task mix is, and whether
 * anything is red. The numbers are all still there; they are arranged by project rather than by
 * column.
 *
 * Sorting lives in the control above rather than in column headers, because there are only three
 * orders anybody wants and naming them is clearer than teaching people to click twice on "Criticals".
 */

type Order = 'attention' | 'name' | 'activity';

const ORDERS = [
  { value: 'attention', label: 'Needs attention' },
  { value: 'name', label: 'Name' },
  { value: 'activity', label: 'Recent' },
];

/** Criticals first, then blocked work, then drift. The row you should look at is the top row. */
function byAttention(a: PortfolioRow, b: PortfolioRow): number {
  return (
    b.openCriticals - a.openCriticals ||
    b.tasks.blocked - a.tasks.blocked ||
    b.drift.total - a.drift.total ||
    a.name.localeCompare(b.name)
  );
}

function byActivity(a: PortfolioRow, b: PortfolioRow): number {
  return new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime();
}

function ProjectCard({ row }: { row: PortfolioRow }) {
  const total = row.tasks.open + row.tasks.blocked + row.tasks.done;
  const percent = total === 0 ? 0 : Math.round((row.tasks.done / total) * 100);

  return (
    <Card padding="md" href={`/projects/${row.code}`} interactive>
      <Stack gap="16">
        <Cluster gap="8" align="center" justify="between">
          <Stack gap="2">
            <span className="fm-card__title">{row.name}</span>
            <code className="fm-card__code">{row.code}</code>
          </Stack>
          <Pill tone={lifecycleTone(row.lifecycle)}>{row.lifecycle}</Pill>
        </Cluster>

        <Cluster gap="16" align="center">
          <Donut
            size={88}
            segments={[
              { label: 'Done', value: row.tasks.done, color: SERIES.done },
              { label: 'Blocked', value: row.tasks.blocked, color: SERIES.blocked },
              { label: 'Open', value: row.tasks.open, color: SERIES.waiting },
            ]}
            label={total === 0 ? '—' : `${String(percent)}%`}
            caption={total === 0 ? 'no tasks' : `${String(row.tasks.done)}/${String(total)}`}
          />
          <Stack gap="8" className="fm-card__facts">
            <Fact
              label="In flight"
              value={row.phase === null ? 'Not started' : row.phase.name}
            />
            <Fact
              label="Criticals"
              value={row.openCriticals === 0 ? 'None' : String(row.openCriticals)}
              tone={row.openCriticals === 0 ? undefined : 'danger'}
            />
            <Fact
              label="Drift"
              value={row.drift.total === 0 ? 'None' : String(row.drift.total)}
              tone={row.drift.total === 0 ? undefined : 'warning'}
            />
          </Stack>
        </Cluster>

        {total > 0 && (
          <SegmentBar
            showLegend={false}
            segments={[
              { label: 'Done', value: row.tasks.done, color: SERIES.done },
              { label: 'Blocked', value: row.tasks.blocked, color: SERIES.blocked },
              { label: 'Open', value: row.tasks.open, color: SERIES.waiting },
            ]}
          />
        )}

        <Cluster gap="8" align="center" justify="between">
          <Pill tone={ciTone(row.ci.conclusion, row.ci.unknown)} dot>
            {row.ci.unknown ? 'CI unknown' : `CI ${row.ci.conclusion ?? 'unknown'}`}
          </Pill>
          <span className="fm-muted">{relativeDay(row.lastActivityAt)}</span>
        </Cluster>
      </Stack>
    </Card>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  // `exactOptionalPropertyTypes` is on: a prop that is sometimes undefined has to say so, rather
  // than the caller having to spread it in conditionally at three call sites.
  tone?: 'danger' | 'warning' | undefined;
}) {
  return (
    <div className="fm-fact">
      <span className="fm-fact__label">{label}</span>
      <span className={tone === undefined ? 'fm-fact__value' : `fm-fact__value fm-fact__value--${tone}`}>
        {value}
      </span>
    </div>
  );
}

export function Projects() {
  const { state } = useAsync(() => foreman.portfolio(), []);
  const [order, setOrder] = useState<Order>('attention');

  const rows =
    state.status === 'ready'
      ? [...state.value.items].sort(
          order === 'name'
            ? (a, b) => a.name.localeCompare(b.name)
            : order === 'activity'
              ? byActivity
              : byAttention,
        )
      : [];

  return (
    <Page>
      <PageHeader
        title="Projects"
        description="Every project Foreman tracks, and where each one actually is."
        {...(state.status === 'ready'
          ? { count: rows.length, countNoun: { one: 'project', other: 'projects' } }
          : {})}
        actions={
          <SegmentedControl
            aria-label="Order projects by"
            size="sm"
            items={ORDERS}
            value={order}
            onValueChange={(value) => { setOrder(value as Order); }}
          />
        }
      />

      {state.status === 'loading' ? (
        <Skeleton lines={6} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The projects did not load">
          {state.message}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState kind="empty" heading="No projects yet">
          Import the vault, or create a project to start.
        </EmptyState>
      ) : (
        <Grid minItemWidth="sm">
          {rows.map((row) => (
            <ProjectCard key={row.code} row={row} />
          ))}
        </Grid>
      )}
    </Page>
  );
}
