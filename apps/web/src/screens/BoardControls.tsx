import { useCallback, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  FormActions,
  FormField,
  Input,
  Modal,
  SegmentedControl,
  Skeleton,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { foreman, ApiError, type ProjectIdeaRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useMoney, useReviews, useSession } from '../lib/session';
import { Pill } from '../ui/viz';
import { relativeDay } from '../ui/tone';

/**
 * The three things a fund board does to a submission (FRM-ADR-016).
 *
 * Kept out of `ProjectIdeas.tsx` because none of it exists on a solo instance, and a screen that
 * is mostly `board && …` is a screen whose two readings are both hard to follow.
 */

const SCALE = [1, 2, 3, 4, 5];

/**
 * Scoring: impact and effort, each 1–5.
 *
 * Two numbers rather than one, because the board's actual question is what it gets for what it
 * costs. A single score averages those together and produces a ranking nobody can argue with,
 * which sounds like agreement and is the absence of one.
 */
export function ScoreIdea({
  idea,
  onScored,
}: {
  idea: ProjectIdeaRow;
  onScored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { user } = useSession();
  const { state } = useAsync(
    () => (open ? foreman.scores(idea.humanId) : Promise.resolve(null)),
    [idea.humanId, open],
  );

  const existing =
    state.status === 'ready' && state.value !== null
      ? state.value.scores.find((s) => s.user.id === user.id)
      : undefined;

  const [impact, setImpact] = useState(3);
  const [effort, setEffort] = useState(3);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Seed the sliders from this reviewer's existing score, once, so reopening shows what they said
  // rather than resetting them to the middle and inviting an accidental re-score.
  if (existing !== undefined && !loaded) {
    setImpact(existing.impact);
    setEffort(existing.effort);
    setNote(existing.note ?? '');
    setLoaded(true);
  }

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void foreman
      .setScore(idea.humanId, { impact, effort, ...(note.trim().length === 0 ? {} : { note }) })
      .then(() => {
        setOpen(false);
        onScored();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That score did not save.');
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setLoaded(false);
          setError(null);
        }
      }}
      trigger={<Button>{idea.score !== null && idea.score.count > 0 ? 'Rescore' : 'Score'}</Button>}
      title={`Score ${idea.humanId}`}
      description="Only the board sees this, until the decision is made."
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not save" dynamic>
              {error}
            </Alert>
          )}

          <FormField label="Impact" help="1 is marginal. 5 changes how the work is done.">
            <SegmentedControl
              aria-label="Impact, one to five"
              items={SCALE.map((n) => ({ value: String(n), label: String(n) }))}
              value={String(impact)}
              onValueChange={(v) => { setImpact(Number(v)); }}
            />
          </FormField>

          <FormField label="Effort" help="1 is an afternoon. 5 is a team for a quarter.">
            <SegmentedControl
              aria-label="Effort, one to five"
              items={SCALE.map((n) => ({ value: String(n), label: String(n) }))}
              value={String(effort)}
              onValueChange={(v) => { setEffort(Number(v)); }}
            />
          </FormField>

          <FormField label="Why" optional help="The most useful field here, and the one nobody fills in.">
            <Textarea
              name="note"
              rows={3}
              value={note}
              maxLength={1000}
              onChange={(e) => { setNote(e.target.value); }}
            />
          </FormField>

          {state.status === 'ready' && state.value !== null && state.value.scores.length > 0 && (
            <Stack gap="8">
              <span className="fm-stat__label">What the rest of the board said</span>
              {state.value.scores
                .filter((s) => s.user.id !== user.id)
                .map((s) => (
                  <p key={s.id} className="fm-item__reason">
                    <strong>
                      {s.user.displayName}: {s.impact}↑ / {s.effort}↓
                    </strong>
                    {s.note !== null && ` — ${s.note}`}
                  </p>
                ))}
            </Stack>
          )}

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save score'}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * Discussion, with the internal half that makes it usable for a board.
 *
 * Without somewhere to deliberate out of sight, the board deliberates somewhere else and what
 * lands here is a press release. The toggle is only offered to a reviewer, and the server refuses
 * an internal note from anyone who could not read it back.
 */
export function IdeaDiscussion({
  idea,
  onChanged,
}: {
  idea: ProjectIdeaRow;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reviews = useReviews();
  const { user } = useSession();
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);

  const { state } = useAsync(
    () => (open ? foreman.comments(idea.humanId) : Promise.resolve(null)),
    [idea.humanId, open, nonce],
  );

  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void foreman
      .addComment(idea.humanId, { body, internal })
      .then(() => {
        setBody('');
        setInternal(false);
        refresh();
        onChanged();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That comment did not post.');
      })
      .finally(() => { setBusy(false); });
  };

  const count = idea._count.comments;

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>{count > 0 ? `Discuss (${String(count)})` : 'Discuss'}</Button>}
      title={`${idea.humanId} — ${idea.title}`}
    >
      <Stack gap="16">
        {state.status === 'loading' ? (
          <Skeleton lines={4} />
        ) : state.status === 'ready' && state.value !== null ? (
          <Stack gap="12">
            {state.value.items.length === 0 && (
              <p className="fm-muted">Nothing said yet.</p>
            )}
            {state.value.items.map((c) => (
              <div key={c.id} className={c.internal ? 'fm-comment fm-comment--internal' : 'fm-comment'}>
                <Stack gap="4">
                  <span className="fm-item__id">
                    {c.user.displayName} · {relativeDay(c.createdAt)}
                    {c.internal && (
                      <>
                        {' '}
                        <Pill tone="warning">board only</Pill>
                      </>
                    )}
                  </span>
                  <p className="fm-item__body-full">{c.body}</p>
                  {c.user.id === user.id && (
                    <Button
                      onClick={() => {
                        void foreman.deleteComment(c.id).then(refresh).catch(() => undefined);
                      }}
                    >
                      Withdraw
                    </Button>
                  )}
                </Stack>
              </div>
            ))}
          </Stack>
        ) : (
          <Alert tone="danger" title="The discussion did not load">
            Close this and try again.
          </Alert>
        )}

        <form onSubmit={submit}>
          <Stack gap="12">
            {error !== null && (
              <Alert tone="danger" title="That did not post" dynamic>
                {error}
              </Alert>
            )}
            <FormField label="Add a comment">
              <Textarea
                name="body"
                rows={3}
                value={body}
                maxLength={4000}
                onChange={(e) => { setBody(e.target.value); }}
              />
            </FormField>
            {reviews && (
              <Checkbox
                label="Board only — the submitter will not see this"
                checked={internal}
                onCheckedChange={(checked) => { setInternal(checked === true); }}
              />
            )}
            <FormActions>
              <Button type="submit" variant="primary" disabled={busy || body.trim().length === 0}>
                {busy ? 'Posting…' : 'Post'}
              </Button>
            </FormActions>
          </Stack>
        </form>
      </Stack>
    </Modal>
  );
}

/**
 * Funding.
 *
 * The reason is required and it is **public**. This is the half most boards never write down, and
 * the half that stops the same proposal arriving again next quarter — and the person who wrote it
 * is told, which is the other thing most boards never do.
 */
export function FundIdea({ idea, onFunded }: { idea: ProjectIdeaRow; onFunded: () => void }) {
  const [open, setOpen] = useState(false);
  const money = useMoney();
  const { currency } = useSession();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Whole currency units in, minor units out. The conversion happens once, here, because a number
  // that is sometimes dollars and sometimes cents reaches somebody as an email off by a hundred.
  const cents = Math.round(Number(amount.replace(/[^0-9.]/g, '')) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && reason.trim().length > 0;

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    void foreman
      .fundIdea(idea.humanId, { amountCents: cents, reason })
      .then(() => {
        setOpen(false);
        onFunded();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not go through.');
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setAmount('');
          setReason('');
          setError(null);
        }
      }}
      trigger={<Button variant="primary">Fund</Button>}
      title={`Fund ${idea.humanId}`}
      description={
        idea.submittedBy === null
          ? 'Nobody is recorded as having submitted this, so nobody will be emailed.'
          : `${idea.submittedBy.displayName} will be emailed the amount and the reason.`
      }
    >
      <form onSubmit={submit}>
        <Stack gap="16">
          {error !== null && (
            <Alert tone="danger" title="That did not go through" dynamic>
              {error}
            </Alert>
          )}

          <FormField label={`Amount (${currency})`}>
            <Input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); }}
            />
          </FormField>
          {cents > 0 && <p className="fm-muted">{money(cents)}</p>}

          <FormField
            label="Why"
            help="Public. The submitter reads it, and so does everyone considering the same idea next quarter."
          >
            <Textarea
              name="reason"
              rows={4}
              value={reason}
              maxLength={2000}
              onChange={(e) => { setReason(e.target.value); }}
            />
          </FormField>

          <FormActions>
            <Button type="button" onClick={() => { setOpen(false); }}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !valid}>
              {busy ? 'Recording…' : `Fund ${money(cents > 0 ? cents : null)}`}
            </Button>
          </FormActions>
        </Stack>
      </form>
    </Modal>
  );
}
