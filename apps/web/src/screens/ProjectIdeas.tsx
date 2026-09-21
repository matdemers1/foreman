import { useCallback, useMemo, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Grid,
  Input,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { foreman, ApiError, type ProjectIdeaRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Pill, SegmentBar, StatCard } from '../ui/viz';
import { relativeDay, SERIES, type Tone } from '../ui/tone';

/**
 * Project ideas — something that might become a project, before it is one
 * (FRM-REQ-159 … FRM-REQ-164, FRM-ADR-015).
 *
 * Top-level, beside Projects rather than inside one, because that is what these are: the list of
 * things that are not projects yet. A project's own ideas live at `/projects/<code>/ideas` and are
 * a different question — "what else could this grow" versus "what else could we build".
 *
 * **The code is asked for at conversion and nowhere else.** A project code is immutable and
 * embedded in every human ID the project will ever have (ADR-008), so demanding one to write down
 * "maybe a fuel tracker someday" asks a permanent question at the moment there is least
 * information to answer it. `PI-007` costs nothing.
 */

const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'considering', label: 'Considering' },
  { value: 'parked', label: 'Parked' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'converted', label: 'Built' },
] as const;

type Status = (typeof STATUSES)[number]['value'];

/** Set by converting, never by hand — so it is not on the form. */
const EDITABLE = STATUSES.filter((s) => s.value !== 'converted');

const NEEDS_REASON: readonly string[] = ['parked', 'rejected'];

function ideaTone(status: string): Tone {
  switch (status) {
    case 'converted':
      return 'success';
    case 'considering':
      return 'accent';
    case 'parked':
      return 'warning';
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

const SERIES_FOR: Record<Status, string> = {
  new: SERIES.waiting,
  considering: SERIES.active,
  parked: SERIES.warning,
  rejected: SERIES.blocked,
  converted: SERIES.done,
};

const MEANING: Record<Status, string> = {
  new: 'Written down, not yet weighed',
  considering: 'Actively being thought about',
  parked: 'Good, deliberately not now',
  rejected: 'Decided against — do not re-litigate',
  converted: 'Became a project',
};

export function ProjectIdeas() {
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState<Status | null>(null);
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);

  const { state } = useAsync(() => foreman.projectIdeas(), [nonce]);
  const items = state.status === 'ready' ? state.value.items : [];

  const counts = useMemo(() => {
    const by: Record<string, number> = {};
    for (const status of STATUSES) by[status.value] = 0;
    for (const item of items) by[item.status] = (by[item.status] ?? 0) + 1;
    return by;
  }, [items]);

  const shown = filter === null ? items : items.filter((item) => item.status === filter);

  return (
    <Page>
      <PageHeader
        title="Project ideas"
        description="Things that might become projects. A code is chosen when one does, not before."
        count={items.length}
        countNoun={{ one: 'idea', other: 'ideas' }}
        actions={<ProjectIdeaForm onSaved={refresh} />}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={8} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The project ideas did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Stack gap="24">
          <Grid minItemWidth="sm">
            {STATUSES.map((status) => (
              <StatCard
                key={status.value}
                label={status.label}
                value={counts[status.value] ?? 0}
                detail={MEANING[status.value]}
                tone={ideaTone(status.value)}
                selected={filter === status.value}
                onClick={() => {
                  setFilter((current) => (current === status.value ? null : status.value));
                }}
              />
            ))}
          </Grid>

          {items.length > 0 && (
            <SegmentBar
              segments={STATUSES.map((status) => ({
                label: status.label,
                value: counts[status.value] ?? 0,
                color: SERIES_FOR[status.value],
              }))}
            />
          )}

          {shown.length === 0 ? (
            <EmptyState
              kind="empty"
              heading={filter === null ? 'No project ideas yet' : `Nothing is ${filter}`}
            >
              {filter === null
                ? 'Write one down from here, or from a session with foreman_create.'
                : 'Press the card again to see them all.'}
            </EmptyState>
          ) : (
            <Grid minItemWidth="md">
              {shown.map((idea) => (
                <ProjectIdeaCard key={idea.id} idea={idea} onChanged={refresh} />
              ))}
            </Grid>
          )}
        </Stack>
      )}
    </Page>
  );
}

function ProjectIdeaCard({ idea, onChanged }: { idea: ProjectIdeaRow; onChanged: () => void }) {
  const converted = idea.status === 'converted';

  return (
    <Card padding="md" role="group" aria-label={`${idea.humanId}: ${idea.title}`}>
      <Stack gap="12">
        <Cluster gap="8" align="center" justify="between">
          <span className="fm-item__id">{idea.humanId}</span>
          <Pill tone={ideaTone(idea.status)}>
            {STATUSES.find((s) => s.value === idea.status)?.label ?? idea.status}
          </Pill>
        </Cluster>

        <strong className="fm-item__title">{idea.title}</strong>
        {idea.pitch !== null && idea.pitch.length > 0 && (
          <p className="fm-item__body">{idea.pitch}</p>
        )}

        {idea.reason !== null && idea.reason.length > 0 && (
          <p className="fm-item__reason">
            <span className="fm-muted">Because </span>
            {idea.reason}
          </p>
        )}

        {idea.project !== null && (
          // The whole point of keeping a converted idea: it is the record of where a project came
          // from, so it has to lead there.
          <p className="fm-item__reason">
            <span className="fm-muted">Became </span>
            <a href={`/projects/${idea.project.code}`}>
              {idea.project.code} — {idea.project.name}
            </a>
          </p>
        )}

        <Cluster gap="8" align="center" justify="between">
          <span className="fm-muted">
            {converted
              ? `Built ${relativeDay(idea.convertedAt)}`
              : idea.decidedAt === null
                ? `Added ${relativeDay(idea.createdAt)}`
                : `Decided ${relativeDay(idea.decidedAt)}`}
          </span>
          {!converted && (
            <Cluster gap="8" align="center">
              <ConvertIdea idea={idea} onConverted={onChanged} />
              <ProjectIdeaForm idea={idea} onSaved={onChanged} />
              <DeleteProjectIdea idea={idea} onDeleted={onChanged} />
            </Cluster>
          )}
        </Cluster>
      </Stack>
    </Card>
  );
}

function ProjectIdeaForm({ idea, onSaved }: { idea?: ProjectIdeaRow; onSaved: () => void }) {
  const editing = idea !== undefined;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(idea?.title ?? '');
  const [pitch, setPitch] = useState(idea?.pitch ?? '');
  const [status, setStatus] = useState<string>(idea?.status ?? 'new');
  const [reason, setReason] = useState(idea?.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsReason = editing && NEEDS_REASON.includes(status);

  const reset = () => {
    setTitle(idea?.title ?? '');
    setPitch(idea?.pitch ?? '');
    setStatus(idea?.status ?? 'new');
    setReason(idea?.reason ?? '');
    setError(null);
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (needsReason && reason.trim().length === 0) {
      setError(`A project idea that is ${status} has to say why.`);
      return;
    }
    setBusy(true);
    setError(null);

    const request = editing
      ? foreman.updateProjectIdea(idea.humanId, {
          title,
          pitch,
          status,
          ...(reason.trim().length === 0 ? {} : { reason }),
        })
      : foreman.createProjectIdea({
          title,
          ...(pitch.trim().length === 0 ? {} : { pitch }),
        });

    void request
      .then(() => {
        setOpen(false);
        onSaved();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not save.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
      trigger={
        <Button {...(editing ? {} : { variant: 'primary' as const })}>
          {editing ? 'Edit' : 'New project idea'}
        </Button>
      }
      title={editing ? `Edit ${idea.humanId}` : 'New project idea'}
      description={
        editing
          ? undefined
          : 'No code yet — that is decided when it becomes a project, and it is permanent.'
      }
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not save" dynamic>
              {error}
            </Alert>
          )}

          <FormField label="Title">
            <Input
              name="title"
              value={title}
              maxLength={300}
              onChange={(e) => { setTitle(e.target.value); }}
            />
          </FormField>

          <FormField
            label="Pitch"
            optional
            help="What it is and who it is for. This becomes the project's pitch when it converts."
          >
            <Textarea
              name="pitch"
              rows={5}
              value={pitch}
              maxLength={4000}
              onChange={(e) => { setPitch(e.target.value); }}
            />
          </FormField>

          {editing && (
            <FormField label="Status">
              <Select
                options={EDITABLE.map((s) => ({ value: s.value, label: s.label }))}
                value={status}
                onValueChange={setStatus}
              />
            </FormField>
          )}

          {needsReason && (
            <FormField
              label="Why"
              help={`Required. This is what stops ${idea.humanId} being raised again in six months.`}
            >
              <Textarea
                name="reason"
                rows={2}
                value={reason}
                maxLength={1000}
                onChange={(e) => { setReason(e.target.value); }}
              />
            </FormField>
          )}

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || title.trim().length === 0}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * The moment an idea becomes a project, and the only place a code is asked for.
 *
 * The form says the code is permanent, because it is: it is embedded in every requirement, task,
 * ADR and citation the project will ever have, and there is no rename (ADR-008).
 */
function ConvertIdea({ idea, onConverted }: { idea: ProjectIdeaRow; onConverted: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState(idea.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void foreman
      .convertProjectIdea(idea.humanId, { code: code.toUpperCase(), name })
      .then((result) => {
        setOpen(false);
        onConverted();
        // Straight to the thing that now exists. Converting and then having to go and find it is
        // the sort of small friction that makes a feature feel unfinished.
        window.location.assign(`/projects/${result.project.code}`);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not convert.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setCode('');
          setName(idea.title);
          setError(null);
        }
      }}
      trigger={<Button variant="primary">Convert</Button>}
      title={`Make ${idea.humanId} a project`}
      description="The pitch comes across. The idea stays, as the record of where this began."
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not convert" dynamic>
              {error}
            </Alert>
          )}

          <FormField
            label="Code"
            help="2–8 letters or digits. Permanent: every ID in the project embeds it, and there is no rename."
          >
            <Input
              name="code"
              value={code}
              maxLength={8}
              autoCapitalize="characters"
              onChange={(e) => { setCode(e.target.value.toUpperCase()); }}
            />
          </FormField>

          <FormField label="Name">
            <Input
              name="name"
              value={name}
              maxLength={200}
              onChange={(e) => { setName(e.target.value); }}
            />
          </FormField>

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || code.trim().length < 2 || name.trim().length === 0}
            >
              {busy ? 'Converting…' : 'Convert to project'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

function DeleteProjectIdea({
  idea,
  onDeleted,
}: {
  idea: ProjectIdeaRow;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    setError(null);
    void foreman
      .deleteProjectIdea(idea.humanId)
      .then(() => {
        setOpen(false);
        onDeleted();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not delete.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>Delete</Button>}
      title={`Delete ${idea.humanId}?`}
      description="Hidden, not destroyed — the audit event can undo it, and the number is never reused."
    >
      <Stack gap="16">
        {error !== null && (
          <Alert tone="danger" title="That did not delete" dynamic>
            {error}
          </Alert>
        )}
        <p>
          If this was considered and turned down, mark it <strong>rejected</strong> with a reason
          instead — that is what stops it coming back.
        </p>
        <FormActions>
          <Button type="button" onClick={() => { setOpen(false); }}>
            Cancel
          </Button>
          <Button type="button" variant="danger" disabled={busy} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}
