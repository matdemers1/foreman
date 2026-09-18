import { useState } from 'react';
import { Select } from '@d3cloud/ui';
import { api, ApiError, type TaskRow } from '../lib/api';

/**
 * Changing a task's status — **by control, never by dragging** (FRM-REQ-135).
 *
 * Drag-and-drop is a recorded anti-feature, and not for taste: a drag is invisible to a keyboard,
 * awkward on a phone, and impossible to undo halfway. A select says what the options are, works
 * everywhere, and reads its current value aloud.
 *
 * The same control appears on the list and on the board, so the board is a *view* rather than the
 * only place state can be changed.
 */

const OPTIONS = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

export interface StatusControlProps {
  task: TaskRow;
  code: string;
  onChanged: () => void;
}

export function StatusControl({ task, code, onChanged }: StatusControlProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (status: string) => {
    if (status === task.status) return;

    // Blocked without a reason is refused by the server, and asking here is kinder than showing
    // that refusal — the reason is the whole value of recording that something is stuck.
    let reason: string | null = null;
    if (status === 'blocked') {
      reason = window.prompt('What is blocking it?', task.blockedReason ?? '');
      if (reason === null || reason.trim().length === 0) return;
    }

    setBusy(true);
    setError(null);

    void api
      .patch(`/api/projects/${code}/tasks/${task.humanId}`, {
        status,
        ...(reason === null ? {} : { blockedReason: reason }),
      })
      .then(onChanged)
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError ? caught.message : 'That change did not go through.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <Select
        options={OPTIONS}
        value={task.status}
        onValueChange={change}
        size="sm"
        disabled={busy}
        aria-label={`Status of ${task.humanId}`}
      />
      {error === null ? null : <div className="fm-error">{error}</div>}
    </>
  );
}
