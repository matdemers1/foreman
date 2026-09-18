import { Badge, Card, Link, Stack } from '@d3cloud/ui';
import type { TaskRow } from '../lib/api';
import { StatusControl } from './StatusControl';

/**
 * The board view of one phase (T-1.12, FRM-REQ-134).
 *
 * A column per status, and **no dragging** (FRM-REQ-135). Each card carries the same status control
 * the list does, so the board shows the shape of the work without becoming the only place it can be
 * changed.
 */

const COLUMNS: { status: string; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
];

export interface PhaseBoardProps {
  tasks: TaskRow[];
  code: string;
  onChanged: () => void;
}

export function PhaseBoard({ tasks, code, onChanged }: PhaseBoardProps) {
  return (
    <div className="fm-board">
      {COLUMNS.map((column) => {
        const inColumn = tasks.filter((task) => task.status === column.status);
        return (
          <section key={column.status} className="fm-board__column" aria-label={column.label}>
            <h3 className="fm-board__heading">
              {column.label}{' '}
              <span className="fm-muted">{inColumn.length}</span>
            </h3>

            <Stack gap="8">
              {inColumn.length === 0 ? (
                <p className="fm-muted">Nothing here.</p>
              ) : (
                inColumn.map((task) => (
                  <Card key={task.humanId}>
                    <Stack gap="8">
                      <div>
                        <Link href={`/tasks/${task.humanId}`}>
                          <code>{task.humanId}</code>
                        </Link>{' '}
                        {task.title}
                      </div>

                      {task.status === 'blocked' ? (
                        <div className="fm-muted">{task.blockedReason ?? 'no reason recorded'}</div>
                      ) : null}

                      <div>
                        {task.size === null ? null : <Badge tone="neutral">{task.size}</Badge>}
                      </div>

                      {/* The same control the list uses: the board is a view, not a second way in. */}
                      <StatusControl task={task} code={code} onChanged={onChanged} />
                    </Stack>
                  </Card>
                ))
              )}
            </Stack>
          </section>
        );
      })}
    </div>
  );
}
