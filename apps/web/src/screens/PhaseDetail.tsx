import {
  Badge,
  Card,
  CardTitle,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type TaskRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-11 — one phase, and its tasks.
 *
 * A blocked task shows its reason in the row rather than behind a click. The vault's failure was
 * that you could see work had stopped and never why; putting the reason one interaction away is
 * how that happens again.
 */

const STATUS_TONE: Record<string, 'neutral' | 'attention' | 'danger'> = {
  todo: 'neutral',
  in_progress: 'attention',
  blocked: 'danger',
  done: 'neutral',
  cancelled: 'neutral',
};

export function PhaseDetail({ code, phaseHumanId }: { code: string; phaseHumanId: string }) {
  const phases = useAsync(() => foreman.phases(code), [code]);
  const tasks = useAsync(() => foreman.tasks(code, phaseHumanId), [code, phaseHumanId]);

  const phase =
    phases.state.status === 'ready'
      ? phases.state.value.items.find((p) => p.humanId === phaseHumanId)
      : undefined;

  const columns: TableColumn<TaskRow>[] = [
    {
      key: 'humanId',
      header: 'ID',
      width: '9rem',
      sortable: true,
      cell: (row) => (
        <Link href={`/tasks/${row.humanId}`}>
          <code>{row.humanId}</code>
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Task',
      sortable: true,
      cell: (row) => (
        <>
          {row.title}
          {row.status === 'blocked' ? (
            // In the row, not behind a click: "stopped, and nobody recorded why" is the failure
            // this whole product exists to stop repeating.
            <div className="fm-muted">{row.blockedReason ?? 'no reason recorded'}</div>
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '8rem',
      cell: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>,
    },
    { key: 'size', header: 'Size', width: '5rem', cell: (row) => row.size ?? '—' },
    {
      key: 'requirements',
      header: 'Satisfies',
      width: '12rem',
      cell: (row) =>
        row.requirements.length === 0 ? (
          <span className="fm-muted">nothing</span>
        ) : (
          <code>{row.requirements.join(', ')}</code>
        ),
    },
  ];

  if (phases.state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={6} />
      </Page>
    );
  }

  if (phases.state.status === 'ready' && phase === undefined) {
    return (
      <Page>
        <EmptyState kind="no-results" heading={`${code} has no phase ${phaseHumanId}`}>
          Pick one from the phases list.
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={phase === undefined ? phaseHumanId : `${phase.number} — ${phase.name}`}
        description={phase?.objective ?? undefined}
        actions={
          phase === undefined ? undefined : (
            <Badge tone={phase.status === 'active' ? 'attention' : 'neutral'}>{phase.status}</Badge>
          )
        }
      />

      {phase?.exitDemo === undefined || phase.exitDemo === null ? null : (
        <Card>
          <CardTitle>Exit demo</CardTitle>
          <DescriptionList>
            <DescriptionItem term="Done when">{phase.exitDemo}</DescriptionItem>
          </DescriptionList>
        </Card>
      )}

      {tasks.state.status === 'loading' ? (
        <Skeleton lines={5} />
      ) : tasks.state.status === 'error' ? (
        <EmptyState kind="error" heading="The tasks did not load">
          {tasks.state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Tasks in ${phaseHumanId}`}
          captionHidden
          columns={columns}
          rows={tasks.state.value.items}
          rowKey={(row) => row.humanId}
          empty={
            <EmptyState kind="empty" size="inline" heading="No tasks in this phase">
              A phase with no tasks has an objective and no way to reach it.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
