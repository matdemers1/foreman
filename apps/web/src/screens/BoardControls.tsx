import { useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  FormActions,
  FormField,
  Input,
  Modal,
  Stack,
  Textarea,
} from '@d3cloud/ui';
import { foreman, ApiError, type ProjectIdeaRow } from '../lib/api';
import { useMoney, useSession } from '../lib/session';

/**
 * Funding: the one thing on an idea's page that only a fund board does (FRM-ADR-016).
 *
 * Scoring and discussion used to live here as modals on the list's cards. They moved onto the
 * idea's own page when it gained one (FRM-ADR-017), inline and in both modes, which left money as
 * the only board-only control — and so the only thing in this file.
 */

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
