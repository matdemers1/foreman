import {
  Card,
  Cluster,
  EmptyState,
  Grid,
  Link,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type FindingRow, type PortfolioRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { percentClosed } from '../lib/completion';
import { BarRow, Donut, Pill, SegmentBar, StatCard } from '../ui/viz';
import { ciTone, relativeDay, SERIES, severityTone } from '../ui/tone';
import { plainText } from '../lib/text';

/**
 * The home screen: the whole portfolio in one look.
 *
 * `/` used to be the project table, and the sidebar listed every project beside it — the same
 * information twice, and neither answered the question you actually arrive with, which is *where
 * should I look today*. The projects moved to `/projects`; this is what replaced them.
 *
 * It is built from figures Foreman already computes for other screens, deliberately: a dashboard
 * whose numbers are derived a second way is a dashboard that will eventually disagree with the
 * screen it links to, and disagreeing with itself is the one thing this tool cannot afford.
 *
 * Everything is a link. A number you can see and cannot follow just moves the search elsewhere.
 */

function totals(rows: readonly PortfolioRow[]) {
  return rows.reduce(
    (acc, row) => ({
      open: acc.open + row.tasks.open,
      blocked: acc.blocked + row.tasks.blocked,
      done: acc.done + row.tasks.done,
      cancelled: acc.cancelled + row.tasks.cancelled,
      criticals: acc.criticals + row.openCriticals,
      drift: acc.drift + row.drift.total,
      failing: acc.failing + (!row.ci.unknown && row.ci.conclusion !== 'success' ? 1 : 0),
      unknownCi: acc.unknownCi + (row.ci.unknown ? 1 : 0),
    }),
    { open: 0, blocked: 0, done: 0, cancelled: 0, criticals: 0, drift: 0, failing: 0, unknownCi: 0 },
  );
}

export function Dashboard() {
  const portfolio = useAsync(() => foreman.portfolio(), []);
  // The inbox is already ranked by severity, so the top of it is the top of this screen.
  const findings = useAsync(() => foreman.findings({ status: 'open' }), []);

  if (portfolio.state.status === 'loading') {
    return (
      <Page>
        <PageHeader title="Dashboard" description="Where everything stands." />
        <Skeleton lines={8} />
      </Page>
    );
  }

  if (portfolio.state.status === 'error') {
    return (
      <Page>
        <PageHeader title="Dashboard" description="Where everything stands." />
        <EmptyState kind="error" heading="The dashboard did not load">
          {portfolio.state.message}
        </EmptyState>
      </Page>
    );
  }

  const rows = portfolio.state.value.items;
  const t = totals(rows);
  const tasks = t.open + t.blocked + t.done + t.cancelled;
  const percent = percentClosed(t.done, t.cancelled, tasks);

  const needsAttention = [...rows]
    .filter((row) => row.openCriticals > 0 || row.tasks.blocked > 0 || row.drift.total > 0)
    .sort((a, b) => b.openCriticals - a.openCriticals || b.drift.total - a.drift.total)
    .slice(0, 6);

  const driftMax = Math.max(1, ...rows.map((row) => row.drift.total));
  // Ranked by severity server-side, so the first six are the six worth showing.
  const openFindings =
    findings.state.status === 'ready' ? findings.state.value.items.slice(0, 6) : [];

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description={`${String(rows.length)} projects, ${String(tasks)} tasks, and what needs looking at.`}
      />

      <Stack gap="24">
        {/* The four figures worth knowing before anything else. Criticals and blocked work are
            tinted; the other two are not, because a wall of coloured numbers has no emphasis. */}
        <Grid minItemWidth="sm">
          <StatCard
            label="Open criticals"
            value={t.criticals}
            tone={t.criticals === 0 ? 'success' : 'danger'}
            detail={t.criticals === 0 ? 'Nothing on fire' : 'Across every project'}
            href="/findings"
          />
          <StatCard
            label="Blocked tasks"
            value={t.blocked}
            tone={t.blocked === 0 ? 'neutral' : 'warning'}
            detail={t.blocked === 0 ? 'Nothing waiting' : 'Work that cannot start'}
          />
          <StatCard
            label="Drift"
            value={t.drift}
            tone={t.drift === 0 ? 'neutral' : 'warning'}
            detail="Plan and reality apart"
          />
          <StatCard
            label="CI"
            value={t.failing === 0 ? 'Green' : `${String(t.failing)} failing`}
            tone={t.failing === 0 ? 'success' : 'danger'}
            detail={
              t.unknownCi === 0
                ? 'Every project reporting'
                : `${String(t.unknownCi)} never reported`
            }
          />
        </Grid>

        <Grid minItemWidth="md">
          <Section title="Work across the portfolio" surface="card">
            <Cluster gap="24" align="center">
              <Donut
                size={128}
                segments={[
                  { label: 'Done', value: t.done, color: SERIES.done },
                  { label: 'Cancelled', value: t.cancelled, color: SERIES.quiet },
                  { label: 'Blocked', value: t.blocked, color: SERIES.blocked },
                  { label: 'Open', value: t.open, color: SERIES.waiting },
                ]}
                label={`${String(percent)}%`}
                caption={`${String(t.done + t.cancelled)} of ${String(tasks)}`}
              />
              <div className="fm-grow">
                <SegmentBar
                  segments={[
                    { label: 'Done', value: t.done, color: SERIES.done },
                    { label: 'Cancelled', value: t.cancelled, color: SERIES.quiet },
                  { label: 'Cancelled', value: t.cancelled, color: SERIES.quiet },
                    { label: 'Blocked', value: t.blocked, color: SERIES.blocked },
                    { label: 'Open', value: t.open, color: SERIES.waiting },
                  ]}
                />
              </div>
            </Cluster>
          </Section>

          <Section
            title="Drift by project"
            surface="card"
            description="Coverage holes, stale tasks, fired tripwires and orphan ADRs."
          >
            {rows.every((row) => row.drift.total === 0) ? (
              <EmptyState kind="empty" size="inline" heading="No drift anywhere">
                Every plan matches what is built.
              </EmptyState>
            ) : (
              <Stack gap="2">
                {[...rows]
                  .sort((a, b) => b.drift.total - a.drift.total)
                  .slice(0, 7)
                  .map((row) => (
                    <BarRow
                      key={row.code}
                      label={row.name}
                      value={row.drift.total}
                      max={driftMax}
                      color={SERIES.warning}
                      href={`/projects/${row.code}/drift`}
                    />
                  ))}
              </Stack>
            )}
          </Section>
        </Grid>

        <Grid minItemWidth="md">
          <Section title="Needs attention" surface="card">
            {needsAttention.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="Nothing is stuck">
                No criticals, no blocked work, no drift.
              </EmptyState>
            ) : (
              <Stack gap="8">
                {needsAttention.map((row) => (
                  <Card key={row.code} padding="sm" href={`/projects/${row.code}`} interactive>
                    <Cluster gap="8" align="center" justify="between">
                      <Stack gap="2">
                        <span className="fm-card__title">{row.name}</span>
                        <span className="fm-muted">
                          {row.phase === null ? 'Not started' : row.phase.name}
                        </span>
                      </Stack>
                      <Cluster gap="6" align="center">
                        {row.openCriticals > 0 && (
                          <Pill tone="danger">
                            {row.openCriticals} critical{row.openCriticals === 1 ? '' : 's'}
                          </Pill>
                        )}
                        {row.tasks.blocked > 0 && (
                          <Pill tone="warning" dot>
                            {row.tasks.blocked} blocked
                          </Pill>
                        )}
                        {row.drift.total > 0 && (
                          <Pill tone="neutral">{row.drift.total} drift</Pill>
                        )}
                      </Cluster>
                    </Cluster>
                  </Card>
                ))}
              </Stack>
            )}
          </Section>

          <Section
            title="Open findings"
            surface="card"
            actions={<Link href="/findings">See all</Link>}
          >
            {findings.state.status === 'loading' ? (
              <Skeleton lines={4} />
            ) : openFindings.length === 0 ? (
              <EmptyState kind="empty" size="inline" heading="The inbox is empty">
                Every finding has been dealt with.
              </EmptyState>
            ) : (
              <Stack gap="8">
                {openFindings.map((finding: FindingRow) => (
                  <Card key={finding.humanId} padding="sm" href={`/findings/${finding.humanId}`} interactive>
                    <Stack gap="4">
                      <Cluster gap="8" align="center">
                        <Pill tone={severityTone(finding.severity)}>{finding.severity}</Pill>
                        <code className="fm-card__code">{finding.humanId}</code>
                        <span className="fm-muted">{finding.project}</span>
                      </Cluster>
                      <span className="fm-finding__title">{plainText(finding.title)}</span>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            )}
          </Section>
        </Grid>

        <Section title="Every project" surface="card" actions={<Link href="/projects">Open</Link>}>
          <Stack gap="2">
            {[...rows]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((row) => (
                <a key={row.code} className="fm-row" href={`/projects/${row.code}`}>
                  <span className="fm-row__name">{row.name}</span>
                  <span className="fm-row__bar">
                    <SegmentBar
                      height={6}
                      showLegend={false}
                      segments={[
                        { label: 'Done', value: row.tasks.done, color: SERIES.done },
                        { label: 'Cancelled', value: row.tasks.cancelled, color: SERIES.quiet },
                        { label: 'Blocked', value: row.tasks.blocked, color: SERIES.blocked },
                        { label: 'Open', value: row.tasks.open, color: SERIES.waiting },
                      ]}
                    />
                  </span>
                  <Pill tone={ciTone(row.ci.conclusion, row.ci.unknown)} dot>
                    {row.ci.unknown ? 'unknown' : (row.ci.conclusion ?? 'unknown')}
                  </Pill>
                  <span className="fm-muted fm-row__when">{relativeDay(row.lastActivityAt)}</span>
                </a>
              ))}
          </Stack>
        </Section>
      </Stack>
    </Page>
  );
}
