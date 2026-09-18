import { useState } from 'react';
import {
  Badge,
  EmptyState,
  FilterBar,
  FormField,
  Link,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Table,
  type TableColumn,
} from '@d3cloud/ui';
import { foreman, type FindingRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-05 — every open finding, every project, ranked (FRM-REQ-120).
 *
 * The screen that justifies the phase. 127 findings lived four directory levels deep across two
 * vault folders, and "what is the worst thing outstanding anywhere" was not a question anybody
 * could ask without opening files one at a time.
 */

const SEVERITY_TONE: Record<string, 'danger' | 'attention' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'attention',
  low: 'neutral',
};

const LENSES = [
  'architecture',
  'security',
  'correctness',
  'performance',
  'accessibility',
  'data',
  'testing',
  'maintainability',
  'dependencies',
  'operability',
];

const ANY = '';

export function Findings({ search }: { search: string }) {
  const initial = new URLSearchParams(search);
  const [severity, setSeverity] = useState(initial.get('severity') ?? ANY);
  const [lens, setLens] = useState(initial.get('lens') ?? ANY);
  const [status, setStatus] = useState(initial.get('status') ?? 'open');

  const findings = useAsync(
    () => foreman.findings({ severity, lens, status }),
    [severity, lens, status],
  );

  const columns: TableColumn<FindingRow>[] = [
    {
      key: 'severity',
      header: 'Severity',
      width: '6.5rem',
      cell: (row) => (
        <Badge tone={SEVERITY_TONE[row.severity] ?? 'neutral'}>{row.severity}</Badge>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      width: '6rem',
      sortable: true,
      cell: (row) => <Link href={`/projects/${row.project}`}>{row.project}</Link>,
    },
    {
      key: 'humanId',
      header: 'ID',
      width: '8rem',
      cell: (row) => <Link href={`/findings/${row.humanId}`}>{row.humanId}</Link>,
    },
    { key: 'title', header: 'Finding', cell: (row) => row.title },
    {
      key: 'lenses',
      header: 'Lenses',
      width: '11rem',
      cell: (row) =>
        row.lenses.length === 0 ? <span className="fm-muted">—</span> : row.lenses.join(', '),
    },
    {
      key: 'verified',
      header: 'Verified',
      width: '7rem',
      cell: (row) =>
        row.verified === 'confirmed' ? (
          <Badge tone="neutral">confirmed</Badge>
        ) : (
          // Said out loud rather than left blank: 123 of 127 real findings were never
          // independently verified, and a blank reads as "fine".
          <span className="fm-muted">{row.verified}</span>
        ),
    },
    {
      key: 'location',
      header: 'Where',
      cell: (row) =>
        row.locations.length === 0 ? (
          <span className="fm-muted">not pinned</span>
        ) : (
          <code>
            {row.locations[0]?.path}
            {row.locations.length > 1 ? ` +${String(row.locations.length - 1)}` : ''}
          </code>
        ),
    },
  ];

  const criticals =
    findings.state.status === 'ready'
      ? findings.state.value.items.filter((f) => f.severity === 'critical').length
      : 0;

  return (
    <Page>
      <PageHeader
        title="Findings"
        description="Every project at once, worst first — the question the vault could not answer."
        {...(findings.state.status === 'ready'
          ? {
              count: findings.state.value.items.length,
              countNoun: { one: 'finding', other: 'findings' },
            }
          : {})}
      />

      <FilterBar
        aria-label="Filter the findings"
        trailing={
          criticals > 0 ? (
            <Badge tone="danger">
              {criticals} critical{criticals === 1 ? '' : 's'} open
            </Badge>
          ) : null
        }
      >
        <FormField label="Severity">
          <Select
            value={severity}
            onValueChange={setSeverity}
            options={[
              { value: ANY, label: 'Any severity' },
              { value: 'critical', label: 'Critical' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
            ]}
          />
        </FormField>
        <FormField label="Lens">
          <Select
            value={lens}
            onValueChange={setLens}
            options={[
              { value: ANY, label: 'Any lens' },
              ...LENSES.map((l) => ({ value: l, label: l })),
            ]}
          />
        </FormField>
        <FormField label="Status">
          <Select
            value={status}
            onValueChange={setStatus}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'fixed', label: 'Fixed' },
              { value: 'deferred', label: 'Deferred' },
              { value: 'wont_fix', label: "Won't fix" },
            ]}
          />
        </FormField>
      </FilterBar>

      {findings.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : findings.state.status === 'error' ? (
        <EmptyState kind="error" heading="The findings did not load">
          {findings.state.message}
        </EmptyState>
      ) : (
        <Table
          caption="Findings across every project"
          captionHidden
          density="compact"
          columns={columns}
          rows={findings.state.value.items}
          rowKey={(row) => row.humanId}
          maxHeight="70vh"
          stickyHeader
          empty={
            <EmptyState
              kind={status === 'open' ? 'empty' : 'no-results'}
              heading={status === 'open' ? 'Nothing open anywhere' : 'Nothing matches'}
            >
              {status === 'open'
                ? 'Every finding in every project has been dealt with — which is a success state.'
                : 'Widen the filters.'}
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
