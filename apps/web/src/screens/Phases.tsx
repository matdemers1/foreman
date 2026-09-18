import {
  Badge,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type PhaseRow, type TaskRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-10 — the phases of one project.
 *
 * **Ordered by build order, not by number**, and it defaults to that. Bindery built 0 through 8.5,
 * then 9 to 11, then 13 to 16, with 12 still ahead: sorting these numerically would put a phase
 * nobody has started in the middle of the finished ones.
 */

const statusTone = (status: string): 'neutral' | 'attention' =>
  status === 'active' ? 'attention' : 'neutral';

export function Phases({ code }: { code: string }) {
  const phases = useAsync(() => foreman.phases(code), [code]);
  const tasks = useAsync(() => foreman.tasks(code), [code]);

  const columns: TableColumn<PhaseRow>[] = [
    {
      key: 'number',
      header: '#',
      width: '4rem',
      numeric: true,
      sortable: (a, b) => Number(a.number) - Number(b.number),
      cell: (row) => row.number,
    },
    {
      key: 'name',
      header: 'Phase',
      sortable: true,
      cell: (row) => <Link href={`/projects/${code}/phases/${row.humanId}`}>{row.name}</Link>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '8rem',
      cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
    },
    {
      key: 'tasks',
      header: 'Tasks',
      width: '8rem',
      numeric: true,
      cell: (row) => {
        if (tasks.state.status !== 'ready') return '—';
        const mine = tasks.state.value.items.filter((task: TaskRow) => task.phaseId === row.id);
        if (mine.length === 0) return '—';
        const done = mine.filter((task) => task.status === 'done').length;
        return `${String(done)} / ${String(mine.length)}`;
      },
    },
    { key: 'size', header: 'Size', width: '5rem', cell: (row) => row.size ?? '—' },
    {
      key: 'exitDemo',
      header: 'Exit demo',
      cell: (row) =>
        row.exitDemo === null ? (
          // Worth saying out loud: a phase with no exit demo has no definition of done.
          <span className="fm-muted">none set</span>
        ) : (
          row.exitDemo
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Phases"
        description="In the order they are being built, which is not the order they are numbered."
      />

      {phases.state.status === 'loading' ? (
        <Skeleton lines={5} />
      ) : phases.state.status === 'error' ? (
        <EmptyState kind="error" heading="The phases did not load">
          {phases.state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Phases of ${code}`}
          captionHidden
          columns={columns}
          rows={phases.state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No phases yet">
              A project without phases has no plan to compare reality against.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
