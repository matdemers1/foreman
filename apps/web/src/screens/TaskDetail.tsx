import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  DescriptionItem,
  DescriptionList,
  EmptyState,
  Link,
  Page,
  PageHeader,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { EditForm, SIZES } from './EditForms';

/**
 * S-12 — one task: what it is for, what it declares, what it satisfies, and what cites it.
 */

interface TaskEntity {
  humanId: string;
  title: string;
  status: string;
  blockedReason: string | null;
  size: string | null;
  doneWhen: string | null;
  idSynthesized: boolean;
  startedAt: string | null;
  completedAt: string | null;
  files: string[];
  requirements: { humanId: string; statement: string }[];
  phase: { humanId: string; name: string } | null;
}

export function TaskDetail({ humanId }: { humanId: string }) {
  const { state, reload } = useAsync(() => foreman.entity(humanId), [humanId]);

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
          heading={state.notFound ? `Nothing here is called ${humanId}` : 'That task did not load'}
        >
          {state.notFound ? 'Check the ID, or find it from its phase.' : state.message}
        </EmptyState>
      </Page>
    );
  }

  const task = state.value.entity as unknown as TaskEntity;
  const { backlinks, projectCode } = state.value;

  return (
    <Page>
      <PageHeader
        title={task.title}
        description={humanId}
        actions={
          <>
            <Badge tone={task.status === 'blocked' ? 'danger' : 'neutral'}>{task.status}</Badge>
            <EditForm
              title={`Edit ${humanId}`}
              path={`/api/projects/${projectCode}/tasks/${humanId}`}
              trigger={<Button>Edit</Button>}
              onSaved={reload}
              initial={{
                title: task.title,
                size: task.size ?? '',
                doneWhen: task.doneWhen ?? '',
                ...(task.status === 'blocked'
                  ? { blockedReason: task.blockedReason ?? '' }
                  : {}),
              }}
              fields={[
                { name: 'title', label: 'Title', kind: 'text' },
                { name: 'size', label: 'Size', kind: 'select', options: SIZES, optional: true },
                {
                  name: 'doneWhen',
                  label: 'Done when',
                  kind: 'textarea',
                  optional: true,
                  help: 'What would show this task is finished.',
                },
                // Offered only while the task is blocked: a reason with nothing to explain is
                // a field nobody knows how to fill in.
                ...(task.status === 'blocked'
                  ? [
                      {
                        name: 'blockedReason',
                        label: 'What is blocking it',
                        kind: 'textarea' as const,
                        help: 'Required while the task is blocked.',
                      },
                    ]
                  : []),
              ]}
            />
          </>
        }
      />

      {task.status === 'blocked' ? (
        <Alert tone="danger" title="Blocked">
          {task.blockedReason ?? 'No reason was recorded, which should not be possible.'}
        </Alert>
      ) : null}

      {task.idSynthesized ? (
        <Alert tone="warning" title="This ID was synthesized">
          The importer invented it from the task&rsquo;s phase and position, because the source had
          none. It is not a canonical ID somebody chose.
        </Alert>
      ) : null}

      <Card>
        <CardTitle>What it is</CardTitle>
        <DescriptionList>
          <DescriptionItem term="Project">
            <Link href={`/projects/${projectCode}`}>{projectCode}</Link>
          </DescriptionItem>
          {task.phase === null ? null : (
            <DescriptionItem term="Phase">
              <Link href={`/projects/${projectCode}/phases/${task.phase.humanId}`}>
                {task.phase.name}
              </Link>
            </DescriptionItem>
          )}
          <DescriptionItem term="Size">{task.size ?? '—'}</DescriptionItem>
          {task.doneWhen === null ? null : (
            <DescriptionItem term="Done when">{task.doneWhen}</DescriptionItem>
          )}
          <DescriptionItem term="Started">
            {task.startedAt === null ? 'not yet' : new Date(task.startedAt).toLocaleDateString()}
          </DescriptionItem>
          <DescriptionItem term="Completed">
            {task.completedAt === null ? 'not yet' : new Date(task.completedAt).toLocaleDateString()}
          </DescriptionItem>
        </DescriptionList>
      </Card>

      <Card>
        <CardTitle>Satisfies</CardTitle>
        {task.requirements.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading="No requirements">
            A task satisfying nothing is work with no stated reason — which is what a coverage hole
            looks like from the other side.
          </EmptyState>
        ) : (
          <Stack gap="8" as="ul">
            {task.requirements.map((requirement) => (
              <li key={requirement.humanId}>
                <code>{requirement.humanId}</code> — {requirement.statement}
              </li>
            ))}
          </Stack>
        )}
      </Card>

      <Card>
        <CardTitle>Declared files</CardTitle>
        {task.files.length === 0 ? (
          <EmptyState kind="empty" size="inline" heading="No files declared">
            Declared paths are the weakest attribution signal, and the only one that works before a
            commit mentions the task by ID.
          </EmptyState>
        ) : (
          <Stack gap="4" as="ul">
            {task.files.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </Stack>
        )}
      </Card>

      {backlinks.length === 0 ? null : (
        <Card>
          <CardTitle>Cited by</CardTitle>
          <Stack gap="8" as="ul">
            {backlinks.map((link) => (
              <li key={`${link.fromType}:${link.humanId ?? link.title}`}>
                <code>{link.humanId ?? link.fromType}</code> — {link.title}{' '}
                <span className="fm-muted">({link.kind})</span>
              </li>
            ))}
          </Stack>
        </Card>
      )}
    </Page>
  );
}
