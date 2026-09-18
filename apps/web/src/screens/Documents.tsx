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
import { foreman, type DocumentRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-21 — the documents of one project, by kind.
 *
 * The five registers are deliberately absent: they are views, not documents (ADR-006), and there is
 * no document kind to author one under. What is here is what somebody actually wrote.
 */

export function Documents({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.documents(code), [code]);

  const columns: TableColumn<DocumentRow>[] = [
    {
      key: 'title',
      header: 'Document',
      sortable: true,
      cell: (row) => <Link href={`/projects/${code}/documents/${row.id}`}>{row.title}</Link>,
    },
    {
      key: 'kind',
      header: 'Kind',
      width: '10rem',
      sortable: true,
      cell: (row) => <Badge tone="neutral">{row.kind.replace(/_/g, ' ')}</Badge>,
    },
    {
      key: 'sections',
      header: 'Sections',
      width: '6rem',
      numeric: true,
      cell: (row) => row.sections.length,
    },
    {
      key: 'phase',
      header: 'Phase',
      width: '8rem',
      cell: (row) => row.phase?.humanId ?? <span className="fm-muted">—</span>,
    },
    {
      key: 'updatedAt',
      header: 'Last edited',
      width: '10rem',
      sortable: true,
      cell: (row) => new Date(row.updatedAt).toLocaleDateString(),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Everything authored for this project, addressable by section."
        back={<Link href={`/projects/${code}`}>{code}</Link>}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The documents did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption={`Documents of ${code}`}
          captionHidden
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.id}
          empty={
            <EmptyState kind="empty" size="inline" heading="Nothing authored yet">
              The registers — scope of work, requirements, risks, glossary — are generated views
              and do not appear here.
            </EmptyState>
          }
        />
      )}
    </Page>
  );
}
