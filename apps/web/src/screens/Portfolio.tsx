import { Badge, EmptyState, Link, Page, PageHeader, Skeleton, Table, type TableColumn } from '@d3cloud/ui';
import { foreman, type PortfolioRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-04 — the portfolio. One row per project: where it is, what is stuck, and whether anything is
 * on fire.
 *
 * **CI unknown renders grey and never blocks the row.** A project nothing has been ingested for is
 * not a project that is failing, and a row that refuses to draw because one column is unknown is
 * a row that hides the nine columns that are known.
 */

function CiCell({ ci }: { ci: PortfolioRow['ci'] }) {
  if (ci.unknown) {
    // Grey, and says so. Never green: "no data" and "passing" are different answers.
    return <span className="fm-muted">unknown</span>;
  }
  return (
    <Badge tone={ci.conclusion === 'success' ? 'neutral' : 'danger'}>
      {ci.conclusion ?? 'unknown'}
    </Badge>
  );
}

const relative = (iso: string | null): string => {
  if (iso === null) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${String(days)}d ago`;
  return `${String(Math.floor(days / 30))}mo ago`;
};

const COLUMNS: TableColumn<PortfolioRow>[] = [
  {
    key: 'name',
    header: 'Project',
    sortable: true,
    cell: (row) => <Link href={`/projects/${row.code}`}>{row.name}</Link>,
  },
  { key: 'code', header: 'Code', width: '5rem', cell: (row) => <code>{row.code}</code> },
  {
    key: 'lifecycle',
    header: 'Lifecycle',
    sortable: true,
    width: '8rem',
    cell: (row) => (
      <Badge tone={row.lifecycle === 'building' ? 'attention' : 'neutral'}>{row.lifecycle}</Badge>
    ),
  },
  {
    key: 'phase',
    header: 'In flight',
    width: '12rem',
    cell: (row) => (row.phase === null ? <span className="fm-muted">—</span> : row.phase.name),
    // Sorted on the phase's number, which is what "how far along" means.
    sortable: (a, b) => Number(a.phase?.number ?? -1) - Number(b.phase?.number ?? -1),
  },
  {
    key: 'open',
    header: 'Open',
    numeric: true,
    width: '5rem',
    sortable: (a, b) => a.tasks.open - b.tasks.open,
    cell: (row) => row.tasks.open,
  },
  {
    key: 'blocked',
    header: 'Blocked',
    numeric: true,
    width: '6rem',
    sortable: (a, b) => a.tasks.blocked - b.tasks.blocked,
    cell: (row) =>
      row.tasks.blocked === 0 ? '—' : <Badge tone="attention">{row.tasks.blocked}</Badge>,
  },
  {
    key: 'openCriticals',
    header: 'Criticals',
    numeric: true,
    width: '6rem',
    sortable: true,
    cell: (row) => (row.openCriticals === 0 ? '—' : <Badge tone="danger">{row.openCriticals}</Badge>),
  },
  { key: 'ci', header: 'CI', width: '7rem', cell: (row) => <CiCell ci={row.ci} /> },
  {
    key: 'drift',
    header: 'Drift',
    numeric: true,
    width: '5rem',
    // The badge reads the drift engine's own total (FRM-REQ-127), not a sum of two of its parts.
    // A badge that adds up a subset is a badge that disagrees with the screen it links to.
    sortable: (a, b) => a.drift.total - b.drift.total,
    cell: (row) =>
      row.drift.total === 0 ? (
        '—'
      ) : (
        <Link href={`/projects/${row.code}/drift`}>{row.drift.total}</Link>
      ),
  },
  {
    key: 'lastActivityAt',
    header: 'Activity',
    width: '7rem',
    sortable: (a, b) =>
      new Date(a.lastActivityAt ?? 0).getTime() - new Date(b.lastActivityAt ?? 0).getTime(),
    cell: (row) => <span className="fm-muted">{relative(row.lastActivityAt)}</span>,
  },
];

export function Portfolio() {
  const { state } = useAsync(() => foreman.portfolio(), []);

  return (
    <Page>
      <PageHeader title="Portfolio" description="Every project, and where each one actually is." />

      {state.status === 'loading' ? (
        // Skeleton rows, not a spinner: the shape of what is coming is itself information.
        <Skeleton lines={6} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The portfolio did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption="Every project Foreman knows about"
          captionHidden
          columns={COLUMNS}
          rows={state.value.items}
          rowKey={(row) => row.code}
          defaultSort={{ column: 'openCriticals', direction: 'desc' }}
          empty={
            <EmptyState kind="empty" size="inline" heading="No projects yet">
              Import the vault, or create a project to start.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
