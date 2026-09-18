import {
  Alert,
  Badge,
  Card,
  CardTitle,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Page,
  PageHeader,
  Skeleton,
  Stack,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type HealthReport, type TechRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-26 and S-07 — is Foreman itself well, and what is everything made of.
 *
 * The health half exists so an alert has somewhere to point (T-7.4 before T-7.5): an email saying
 * "the queue has stalled" is only useful if there is a screen that shows what it stalled on.
 */

const when = (iso: string | null): string =>
  iso === null ? 'never' : new Date(iso).toLocaleString();

function Problems({ report }: { report: HealthReport }) {
  if (report.ok) {
    return (
      <Alert tone="success" title="Everything is running">
        The queue is moving, the nightly dump is current, and the restore drill has been performed.
      </Alert>
    );
  }
  return (
    <Alert
      tone="danger"
      title={
        report.problems.length === 1
          ? 'One thing needs attention'
          : `${String(report.problems.length)} things need attention`
      }
    >
      <Stack gap="4" as="ul">
        {report.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </Stack>
    </Alert>
  );
}

export function Health() {
  const health = useAsync(() => foreman.healthReport(), []);
  const tech = useAsync(() => foreman.tech(), []);

  const columns: TableColumn<TechRow>[] = [
    { key: 'name', header: 'Technology', width: '14rem', sortable: true, cell: (row) => row.name },
    { key: 'category', header: 'Kind', width: '9rem', cell: (row) => row.category },
    {
      key: 'projects',
      header: 'Used by',
      cell: (row) =>
        row.projects
          .map((p) => `${p.code}${p.version === null ? '' : ` ${p.version}`}`)
          .join(' · '),
    },
    {
      key: 'spread',
      header: 'Versions',
      width: '7rem',
      numeric: true,
      cell: (row) => {
        const versions = new Set(row.projects.map((p) => p.version ?? 'unknown'));
        return versions.size > 1 ? (
          // Four projects on three versions of one thing is a fact nobody notices until one of
          // them cannot be upgraded.
          <Badge tone="attention">{versions.size}</Badge>
        ) : (
          versions.size
        );
      },
    },
  ];

  return (
    <Page>
      <PageHeader title="Health" description="Foreman's own state, and what everything is built on." />

      {health.state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : health.state.status === 'error' ? (
        <EmptyState kind="error" heading="Health did not load">
          {health.state.message}
        </EmptyState>
      ) : (
        <>
          <Problems report={health.state.value} />

          <Card>
            <CardTitle>The queue</CardTitle>
            <DescriptionList>
              <DescriptionItem term="Waiting" numeric>
                {health.state.value.queue.queued}
                {health.state.value.queue.stalled ? (
                  <>
                    {' '}
                    <Badge tone="danger">stalled</Badge>
                  </>
                ) : null}
              </DescriptionItem>
              <DescriptionItem term="Running" numeric>
                {health.state.value.queue.running}
              </DescriptionItem>
              <DescriptionItem term="Failed" numeric>
                {health.state.value.queue.failed}
              </DescriptionItem>
              <DescriptionItem term="Oldest waiting">
                {when(health.state.value.queue.oldestQueuedAt)}
              </DescriptionItem>
            </DescriptionList>
          </Card>

          <Card>
            <CardTitle>Last seen</CardTitle>
            <DescriptionList>
              <DescriptionItem term="Ingest">{when(health.state.value.lastIngest)}</DescriptionItem>
              <DescriptionItem term="Reconcile">
                {when(health.state.value.lastReconcile)}
              </DescriptionItem>
              <DescriptionItem term="Backup">
                {health.state.value.lastBackup === null
                  ? 'never'
                  : `${when(health.state.value.lastBackup.at)} · ${String(
                      Math.round(health.state.value.lastBackup.bytes / 1024),
                    )} KiB`}
              </DescriptionItem>
              <DescriptionItem term="Restore drill">
                {/* The one that matters: an untested backup is not a backup (R-04). */}
                {when(health.state.value.lastRestoreDrill)}
              </DescriptionItem>
            </DescriptionList>
          </Card>

          {health.state.value.stageFailures.length === 0 ? null : (
            <Card>
              <CardTitle>Recent stage failures</CardTitle>
              <Stack gap="8" as="ul">
                {health.state.value.stageFailures.map((failure) => (
                  <li key={`${failure.jobKind}:${failure.stage}:${failure.at}`}>
                    <code>
                      {failure.jobKind} / {failure.stage}
                    </code>{' '}
                    <span className="fm-muted">{when(failure.at)}</span>
                    <div className="fm-muted">{failure.error}</div>
                  </li>
                ))}
              </Stack>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardTitle>What everything is built on</CardTitle>
        {tech.state.status !== 'ready' ? (
          <Skeleton lines={5} />
        ) : (
          <Stack gap="12">
            {tech.state.value.disagreements.length === 0 ? null : (
              <Alert
                tone="warning"
                title={`${String(tech.state.value.disagreements.length)} technologies are on different versions`}
              >
                {tech.state.value.disagreements.map((row) => row.name).join(', ')}
              </Alert>
            )}
            <Table
              caption="Technologies across every project"
              captionHidden
              density="compact"
              columns={columns}
              rows={tech.state.value.items}
              rowKey={(row) => row.name}
              empty={
                <EmptyState kind="empty" size="inline" heading="Nothing inventoried yet">
                  No project has recorded what it is built on.
                </EmptyState>
              }
            />
          </Stack>
        )}
      </Card>
    </Page>
  );
}
