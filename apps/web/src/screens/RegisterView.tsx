import {
  Alert,
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
import { foreman, type MatrixRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * The Requirements Register, generated (T-3.9, FRM-REQ-057, FRM-REQ-055, ADR-006).
 *
 * The same rows as S-13, read the other way round: every requirement beside what satisfies it, with
 * the coverage arithmetic at the top. This is the traceability matrix — and it is generated on
 * demand rather than stored, so it cannot be out of date by the time anybody reads it.
 */

const PRIORITY_LABEL: Record<string, string> = {
  M: 'Must',
  S: 'Should',
  C: 'Could',
  W: "Won't",
};

export function RegisterView({ code }: { code: string }) {
  const matrix = useAsync(() => foreman.matrix(code), [code]);
  const coverage = useAsync(() => foreman.coverage(code), [code]);

  const columns: TableColumn<MatrixRow>[] = [
    {
      key: 'humanId',
      header: 'ID',
      width: '8.5rem',
      cell: (row) => <Link href={`/requirements/${row.humanId}`}>{row.humanId}</Link>,
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '5.5rem',
      cell: (row) => (
        <Badge tone={row.priority === 'M' ? 'danger' : 'neutral'}>
          {PRIORITY_LABEL[row.priority] ?? row.priority}
        </Badge>
      ),
    },
    { key: 'statement', header: 'Requirement', cell: (row) => row.statement },
    {
      key: 'phase',
      header: 'Phase',
      width: '7.5rem',
      cell: (row) =>
        row.phase === null ? <span className="fm-muted">backlog</span> : row.phase.humanId,
    },
    {
      key: 'acceptanceTest',
      header: 'Proved by',
      cell: (row) =>
        row.acceptanceTest === null || row.acceptanceTest.trim() === '' ? (
          <span className="fm-muted">nothing stated</span>
        ) : (
          row.acceptanceTest
        ),
    },
    {
      key: 'satisfiedBy',
      header: 'Satisfied by',
      width: '12rem',
      cell: (row) =>
        row.satisfiedBy.length === 0 ? (
          // An empty row, kept rather than omitted: a matrix that hides its holes is the matrix
          // that was maintained by hand.
          <Badge tone="danger">nothing</Badge>
        ) : (
          row.satisfiedBy.map((task) => task.humanId).join(', ')
        ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Requirements register"
        description={`Generated for ${code}: every requirement, and what satisfies it.`}
        back={<Link href={`/projects/${code}`}>{code}</Link>}
      />

      {coverage.state.status === 'ready' ? (
        <Card>
          <CardTitle>Coverage</CardTitle>
          <DescriptionList>
            <DescriptionItem term="Requirements" numeric>
              {coverage.state.value.requirements.total}
            </DescriptionItem>
            <DescriptionItem term="Covered" numeric>
              {coverage.state.value.requirements.covered} of{' '}
              {coverage.state.value.requirements.total}
            </DescriptionItem>
            <DescriptionItem term="Musts covered" numeric>
              {coverage.state.value.requirements.mustsCovered} of{' '}
              {coverage.state.value.requirements.musts}
            </DescriptionItem>
            <DescriptionItem term="Without an acceptance test" numeric>
              {coverage.state.value.withoutAcceptanceTest.length}
            </DescriptionItem>
          </DescriptionList>

          {coverage.state.value.uncoveredMusts.length === 0 ? null : (
            <Alert
              tone="danger"
              title={`${String(coverage.state.value.uncoveredMusts.length)} Musts nothing covers`}
            >
              {coverage.state.value.uncoveredMusts.map((r) => r.humanId).join(', ')}
            </Alert>
          )}
        </Card>
      ) : null}

      {matrix.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : matrix.state.status === 'error' ? (
        <EmptyState kind="error" heading="The register did not load">
          {matrix.state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`The requirements register for ${code}`}
          captionHidden
          density="compact"
          columns={columns}
          rows={matrix.state.value.items}
          rowKey={(row) => row.humanId}
          maxHeight="70vh"
          stickyHeader
          empty={
            <EmptyState kind="empty" size="inline" heading="No requirements yet">
              There is nothing to trace against.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
