import {
  Badge,
  Button,
  Card,
  CardTitle,
  Cluster,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Grid,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type Brief } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { EditForm, LIFECYCLES } from './EditForms';

/**
 * S-09 — a project's overview: pitch, lifecycle, how far the phase in flight has got, CI, and what
 * is stuck.
 *
 * It is the brief, rendered. The same call a Claude session makes answers this screen, which is the
 * point of both surfaces being peers: they cannot disagree, because there is only one answer.
 */

function Ci({ ci }: { ci: Brief['ci'] }) {
  if (ci.unknown) return <span className="fm-muted">unknown — nothing ingested yet</span>;
  return (
    <Cluster gap="8">
      <Badge tone={ci.conclusion === 'success' ? 'neutral' : 'danger'}>{ci.conclusion}</Badge>
      {ci.commitSha === null ? null : <code>{ci.commitSha.slice(0, 7)}</code>}
    </Cluster>
  );
}

export function ProjectOverview({ code }: { code: string }) {
  const { state, reload } = useAsync(() => foreman.brief(code), [code]);

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
        <EmptyState
          kind={state.notFound ? 'no-results' : 'error'}
          heading={state.notFound ? `No project called ${code}` : 'That project did not load'}
        >
          {state.notFound ? 'Check the code, or pick one from the portfolio.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const brief = state.value;
  const phase = brief.activePhase;

  return (
    <Page>
      <PageHeader
        title={brief.project.name}
        description={brief.project.pitch ?? undefined}
        actions={
          <>
            <Badge tone={brief.project.lifecycle === 'building' ? 'attention' : 'neutral'}>
              {brief.project.lifecycle}
            </Badge>
            <EditForm
              title={`Edit ${brief.project.name}`}
              // The code is absent on purpose: it is immutable, and every human ID embeds it.
              description="A project's code cannot change — every ID in it embeds the code."
              path={`/api/projects/${code}`}
              trigger={<Button>Edit</Button>}
              onSaved={reload}
              initial={{
                name: brief.project.name,
                lifecycle: brief.project.lifecycle,
                pitch: brief.project.pitch ?? '',
              }}
              fields={[
                { name: 'name', label: 'Name', kind: 'text' },
                { name: 'lifecycle', label: 'Lifecycle', kind: 'select', options: LIFECYCLES },
                { name: 'pitch', label: 'Pitch', kind: 'textarea', optional: true },
              ]}
            />
          </>
        }
      />

      <nav className="fm-sections" aria-label="Sections of this project">
        <Link href={`/projects/${code}/phases`}>Phases</Link>
        <Link href={`/projects/${code}/requirements`}>Requirements</Link>
        <Link href={`/projects/${code}/scope-of-work`}>Scope of work</Link>
        <Link href={`/projects/${code}/register`}>Register</Link>
        <Link href={`/projects/${code}/documents`}>Documents</Link>
        <Link href={`/projects/${code}/adrs`}>Decisions</Link>
        <Link href={`/projects/${code}/risks`}>Risks</Link>
        <Link href={`/projects/${code}/glossary`}>Glossary</Link>
      </nav>

      <Grid minItemWidth="md">
        <Card>
          <CardTitle>In flight</CardTitle>
          {phase === null ? (
            <EmptyState kind="empty" size="inline" heading="No phase is active">
              Add a phase, or mark one active.
            </EmptyState>
          ) : (
            <Stack gap="12">
              <DescriptionList>
                <DescriptionItem term="Phase">
                  <Link href={`/projects/${code}/phases/${phase.humanId}`}>
                    {phase.number} — {phase.name}
                  </Link>
                </DescriptionItem>
                <DescriptionItem term="Tasks" numeric>
                  {phase.tasks.done} of {phase.tasks.total} done
                </DescriptionItem>
                {phase.objective === null ? null : (
                  <DescriptionItem term="Objective">{phase.objective}</DescriptionItem>
                )}
                {phase.exitDemo === null ? null : (
                  <DescriptionItem term="Exit demo">{phase.exitDemo}</DescriptionItem>
                )}
              </DescriptionList>
            </Stack>
          )}
        </Card>

        <Card>
          <CardTitle>State</CardTitle>
          <DescriptionList>
            <DescriptionItem term="CI">
              <Ci ci={brief.ci} />
            </DescriptionItem>
            <DescriptionItem term="Uncovered requirements" numeric>
              {brief.drift.uncoveredRequirements === 0 ? (
                'none'
              ) : (
                // A count somebody has to go looking for is a count nobody acts on: the number
                // is the link, and it lands on exactly those rows.
                <Link href={`/projects/${code}/requirements?uncovered=true`}>
                  {brief.drift.uncoveredRequirements}
                </Link>
              )}
            </DescriptionItem>
            {/* Named for what they are: proposals, not progress. */}
            <DescriptionItem term="Attributions to review" numeric>
              {brief.drift.unconfirmedAttributions === 0
                ? 'none'
                : `${String(brief.drift.unconfirmedAttributions)} awaiting confirmation`}
            </DescriptionItem>
            <DescriptionItem term="Fired tripwires" numeric>
              {brief.drift.firedRisks === 0 ? 'none' : brief.drift.firedRisks}
            </DescriptionItem>
          </DescriptionList>
        </Card>
      </Grid>

      <Grid minItemWidth="md">
        <Card>
          <CardTitle>Next up</CardTitle>
          {brief.nextTasks.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="Nothing ready to pick up">
              {brief.blocked.length > 0
                ? 'Everything open is blocked — see below.'
                : 'Add a task to the active phase.'}
            </EmptyState>
          ) : (
            <Stack gap="8" as="ul">
              {brief.nextTasks.map((task) => (
                <li key={task.humanId}>
                  <Link href={`/tasks/${task.humanId}`}>{task.humanId}</Link> — {task.title}
                </li>
              ))}
            </Stack>
          )}
        </Card>

        {brief.blocked.length === 0 ? null : (
          <Card>
            {/* Blocked work is listed apart from next tasks on purpose: it is a thing to unblock,
                not a thing to do. */}
            <CardTitle>Blocked</CardTitle>
            <Stack gap="8" as="ul">
              {brief.blocked.map((task) => (
                <li key={task.humanId}>
                  <Link href={`/tasks/${task.humanId}`}>{task.humanId}</Link> — {task.title}
                  <div className="fm-muted">{task.reason ?? 'no reason recorded'}</div>
                </li>
              ))}
            </Stack>
          </Card>
        )}
      </Grid>

      {brief.openCriticals.length === 0 ? null : (
        <Card>
          <CardTitle>Open criticals</CardTitle>
          <Stack gap="8" as="ul">
            {brief.openCriticals.map((finding) => (
              <li key={finding.humanId}>
                <Badge tone="danger">{finding.severity}</Badge>{' '}
                <Link href={`/findings/${finding.humanId}`}>{finding.humanId}</Link> — {finding.title}
                {finding.location === null ? null : (
                  <div className="fm-muted">
                    <code>{finding.location}</code>
                  </div>
                )}
              </li>
            ))}
          </Stack>
        </Card>
      )}
    </Page>
  );
}
