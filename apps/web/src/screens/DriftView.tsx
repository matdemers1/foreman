import {
  Alert,
  Badge,
  Card,
  CardTitle,
  Cluster,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type DriftItem } from '../lib/api';
import { useAsync } from '../lib/useAsync';

/**
 * S-23 — drift: where the plan and reality have come apart (FRM-REQ-126).
 *
 * **Designed as a success state.** An empty drift screen is the thing to aim for, so the empty
 * state here reads as an achievement rather than as a screen that failed to load — which is the
 * usual accident when "no results" is written once for every table in an app.
 */

const CATEGORIES: { key: DriftItem['category']; label: string; blurb: string }[] = [
  {
    key: 'coverage-hole',
    label: 'Coverage holes',
    blurb: 'A Must with no task, or work citing no requirement.',
  },
  {
    key: 'stale-task',
    label: 'Stale tasks',
    blurb: 'In progress, with nothing touching it for a fortnight.',
  },
  {
    key: 'fired-tripwire',
    label: 'Fired tripwires',
    blurb: 'A risk whose named condition has been met.',
  },
  {
    key: 'failed-exit-gate',
    label: 'Exit gates',
    blurb: 'A phase marked complete that would not pass its gate today.',
  },
  {
    key: 'orphan-adr',
    label: 'Orphan ADRs',
    blurb: 'Accepted and uncited, or a chain that loops.',
  },
];

/** Where a drifting entity lives, so a row is a link rather than an instruction to go looking. */
function hrefFor(code: string, item: DriftItem): string {
  switch (item.category) {
    case 'coverage-hole':
      return item.humanId.includes('-REQ-')
        ? `/requirements/${item.humanId}`
        : `/tasks/${item.humanId}`;
    case 'stale-task':
      return `/tasks/${item.humanId}`;
    case 'fired-tripwire':
      return `/projects/${code}/risks`;
    case 'failed-exit-gate':
      return `/projects/${code}/phases/${item.humanId}`;
    case 'orphan-adr':
      return `/projects/${code}/adrs`;
  }
}

export function DriftView({ code }: { code: string }) {
  const { state } = useAsync(() => foreman.drift(code), [code]);

  if (state.status === 'loading') {
    return (
      <Page>
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (state.status === 'error') {
    return (
      <Page>
        <EmptyState kind="error" heading="Drift did not load">
          {state.message}
        </EmptyState>
      </Page>
    );
  }

  const drift = state.value;

  return (
    <Page>
      <PageHeader
        title="Drift"
        description="Where the plan and what is actually true have come apart."
        back={<Link href={`/projects/${code}`}>{code}</Link>}
      />

      {drift.total === 0 ? (
        <Alert tone="success" title="No drift">
          Every Must has a task, nothing is stale, no tripwire has fired, every completed phase
          would still pass its gate, and every accepted decision is cited.
        </Alert>
      ) : (
        <Cluster gap="8">
          {CATEGORIES.map((category) => (
            <Badge
              key={category.key}
              tone={(drift.counts[category.key] ?? 0) > 0 ? 'attention' : 'neutral'}
            >
              {category.label}: {drift.counts[category.key] ?? 0}
            </Badge>
          ))}
        </Cluster>
      )}

      {CATEGORIES.map((category) => {
        const items = drift.items.filter((item) => item.category === category.key);
        if (items.length === 0) return null;

        return (
          <Card key={category.key}>
            <CardTitle>{category.label}</CardTitle>
            <Stack gap="12">
              <span className="fm-muted">{category.blurb}</span>
              <Stack gap="8" as="ul" aria-label={category.label}>
                {items.map((item) => (
                  <li key={`${item.category}:${item.humanId}:${item.detail}`}>
                    <Link href={hrefFor(code, item)}>{item.humanId}</Link> — {item.title}
                    {/* Named and explained: "there is drift" sends somebody looking. */}
                    <div className="fm-muted">{item.detail}</div>
                  </li>
                ))}
              </Stack>
            </Stack>
          </Card>
        );
      })}
    </Page>
  );
}
