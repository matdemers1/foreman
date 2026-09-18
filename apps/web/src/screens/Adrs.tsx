import {
  Alert,
  Badge,
  Card,
  CardTitle,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { Markdown } from '../components/Markdown';
import { foreman, type AdrRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-19 and S-20 — the ADRs of a project, and the chain between them.
 *
 * The graph is rendered as Mermaid rather than drawn: the console already renders Mermaid for
 * document previews, and a second diagram engine for one screen is a second thing to maintain.
 */

const STATUS_TONE: Record<string, 'neutral' | 'attention' | 'danger'> = {
  accepted: 'attention',
  proposed: 'neutral',
  superseded: 'neutral',
  rejected: 'danger',
};

export function Adrs({ code }: { code: string }) {
  const adrs = useAsync(() => foreman.adrs(code), [code]);
  const graph = useAsync(() => foreman.adrGraph(code), [code]);

  return (
    <Page>
      <PageHeader
        title="Decision records"
        description="What was decided, why, and what replaced it."
        back={<Link href={`/projects/${code}`}>{code}</Link>}
      />

      {graph.state.status === 'ready' && graph.state.value.edges.length > 0 ? (
        <Card>
          <CardTitle>The chain</CardTitle>
          {graph.state.value.cycle === null ? null : (
            // A cycle rendered silently is a cycle nobody notices. Named, with the loop.
            <Alert tone="danger" title="These supersede each other in a circle">
              {graph.state.value.cycle.join(' → ')}
            </Alert>
          )}
          <Markdown>{mermaidFor(graph.state.value)}</Markdown>
        </Card>
      ) : null}

      {adrs.state.status === 'loading' ? (
        <Skeleton lines={10} />
      ) : adrs.state.status === 'error' ? (
        <EmptyState kind="error" heading="The ADRs did not load">
          {adrs.state.message}
        </EmptyState>
      ) : adrs.state.value.items.length === 0 ? (
        <EmptyState kind="empty" heading="No ADRs">
          Nothing has been written down as a decision yet.
        </EmptyState>
      ) : (
        adrs.state.value.items.map((adr) => <AdrCard key={adr.humanId} adr={adr} />)
      )}
    </Page>
  );
}

function AdrCard({ adr }: { adr: AdrRow }) {
  const supersededBy = adr.relations.filter((r) => r.kind === 'superseded_by');

  return (
    <Card>
      <CardTitle>
        {adr.humanId} — {adr.title}
      </CardTitle>
      <Stack gap="12">
        <div>
          <Badge tone={STATUS_TONE[adr.status] ?? 'neutral'}>{adr.status}</Badge>
          {adr.decidedOn === null ? null : (
            <span className="fm-muted"> decided {adr.decidedOn.slice(0, 10)}</span>
          )}
        </div>

        {supersededBy.length === 0 ? null : (
          <Alert tone="warning" title="Superseded">
            {supersededBy.map((r) => `${r.relatedAdr.humanId} — ${r.relatedAdr.title}`).join('; ')}
          </Alert>
        )}

        {adr.decisionAbstract === null ? null : <strong>{adr.decisionAbstract}</strong>}
        {adr.contextMd === null ? null : <Markdown>{adr.contextMd}</Markdown>}
        {adr.decisionMd === null ? null : <Markdown>{adr.decisionMd}</Markdown>}
        {adr.consequencesMd === null ? null : <Markdown>{adr.consequencesMd}</Markdown>}
        {adr.rejectedMd === null ? null : (
          <Stack gap="4">
            {/* The half of an ADR usually lost: what was considered and turned down. */}
            <span className="fm-muted">What was rejected</span>
            <Markdown>{adr.rejectedMd}</Markdown>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/** The graph as a Mermaid source block, which the markdown renderer already knows how to draw. */
function mermaidFor(graph: {
  nodes: { humanId: string; title: string; status: string }[];
  edges: { from: string; to: string; kind: string }[];
}): string {
  const id = (humanId: string) => humanId.replace(/-/g, '_');
  const lines = [
    'graph TB',
    ...graph.nodes.map(
      (node) => `  ${id(node.humanId)}["${node.humanId}<br/>${escape(node.title)}"]`,
    ),
    ...graph.edges.map((edge) => `  ${id(edge.from)} -->|${edge.kind}| ${id(edge.to)}`),
  ];
  return ['```mermaid', ...lines, '```'].join('\n');
}

/** Quotes and pipes break a Mermaid label; nothing else in a title does. */
function escape(text: string): string {
  return text.replace(/["|]/g, ' ').slice(0, 60);
}
