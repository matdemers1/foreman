import {
  AttributeInput,
  CreateInput,
  gateForAttribute,
  gateForLink,
  gateForPriority,
  gateForStatus,
  LinkInput,
  parseHumanId,
  SetStatusInput,
  UpdateInput,
  type GateDecision,
} from '@foreman/shared';
import type { ForemanClient } from '../client.js';

/**
 * The write tools (T-2.8), and the gate in front of them (T-2.9).
 *
 * **Forward progress is never gated.** Marking a task done, filing a finding, logging a decision —
 * these are the motions of working, and a confirmation on each is exactly how a confirmation stops
 * being read. What is gated is the small set of changes that lose something: a delete, a regression,
 * an abandonment, a `Won't`, an unlink.
 *
 * The gate rules themselves live in `packages/shared` because "which changes need asking about" is
 * a property of the change and not of the surface making it.
 */

export interface WriteToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema:
    | typeof CreateInput
    | typeof UpdateInput
    | typeof SetStatusInput
    | typeof LinkInput
    | typeof AttributeInput;
  /** Whether this call needs asking about first, decided from the arguments and current state. */
  gate(client: ForemanClient, input: unknown): Promise<GateDecision>;
  run(client: ForemanClient, input: unknown): Promise<unknown>;
}

/** The current status of an entity, so a status change can be judged as forward or backward. */
async function currentStatus(
  client: ForemanClient,
  humanId: string,
): Promise<{ type: string; status: string | null; priority: string | null }> {
  const result = await client.get<{
    type: string;
    entity: { status?: string; priority?: string };
  }>(`/api/entities/${humanId}`, { backlinks: false });
  return {
    type: result.type,
    status: result.entity.status ?? null,
    priority: result.entity.priority ?? null,
  };
}

function projectOf(humanId: string): string {
  const parsed = parseHumanId(humanId);
  if (parsed === null) throw new Error(`${humanId} is not a project-prefixed human ID`);
  return parsed.code;
}

export const WRITE_TOOLS: readonly WriteToolDefinition[] = [
  {
    name: 'foreman_create',
    title: 'Create',
    description: 'Add a requirement, task or phase to a project.',
    inputSchema: CreateInput,
    // Creating loses nothing, so it is never gated.
    gate: () => Promise.resolve({ gated: false }),
    run: async (client, input) => {
      const args = CreateInput.parse(input);
      const body: Record<string, unknown> = {};

      switch (args.kind) {
        case 'requirement':
          body['statement'] = args.text;
          if (args.priority !== undefined) body['priority'] = args.priority;
          break;
        case 'task':
          body['title'] = args.text;
          if (args.doneWhen !== undefined) body['doneWhen'] = args.doneWhen;
          if (args.size !== undefined) body['size'] = args.size;
          break;
        case 'phase':
          body['name'] = args.text;
          body['number'] = args.number ?? 0;
          break;
      }

      return client.post(`/api/projects/${args.project}/${args.kind}s`, body, {
        // A phase is addressed by its human ID; the server resolves it.
        ...(args.phase === undefined ? {} : { phase: args.phase }),
        ...(args.satisfies === undefined ? {} : { satisfies: args.satisfies }),
      });
    },
  },
  {
    name: 'foreman_update',
    title: 'Update',
    description: 'Change an entity’s text, priority, size or phase.',
    inputSchema: UpdateInput,
    gate: (_client, input) => {
      const args = UpdateInput.parse(input);
      // Nothing to look up: the only gated field here is decided by the request itself.
      return Promise.resolve(args.priority === undefined ? { gated: false } : gateForPriority(args.priority));
    },
    run: async (client, input) => {
      const args = UpdateInput.parse(input);
      const kind = kindOf(args.id);
      const body: Record<string, unknown> = {};
      if (args.text !== undefined) body[kind === 'requirements' ? 'statement' : 'title'] = args.text;
      if (args.priority !== undefined) body['priority'] = args.priority;
      if (args.size !== undefined) body['size'] = args.size;
      if (args.doneWhen !== undefined) body['doneWhen'] = args.doneWhen;
      return client.patch(`/api/projects/${projectOf(args.id)}/${kind}/${args.id}`, body);
    },
  },
  {
    name: 'foreman_set_status',
    title: 'Set status',
    description:
      'Move a task, phase or finding to a new status. Blocked needs a reason; going backwards, ' +
      'cancelling and completing a phase are confirmed first.',
    inputSchema: SetStatusInput,
    gate: async (client, input) => {
      const args = SetStatusInput.parse(input);
      const current = await currentStatus(client, args.id);
      return gateForStatus(current.type, current.status, args.status);
    },
    run: async (client, input) => {
      const args = SetStatusInput.parse(input);
      return client.patch(`/api/projects/${projectOf(args.id)}/${kindOf(args.id)}/${args.id}`, {
        status: args.status,
        // Only when it is a *blocked* reason. This used to send it whatever the status was, so a
        // note explaining why something was finished landed in `blockedReason` on a done task —
        // which reads, to anyone who finds it later, as a record of that task being stuck.
        ...(args.reason === undefined || args.status !== 'blocked'
          ? {}
          : { blockedReason: args.reason }),
      });
    },
  },
  {
    name: 'foreman_link',
    title: 'Link',
    description:
      'Cite one entity from another: a task satisfies a requirement, a finding violates one, an ' +
      'ADR supersedes another. Unlinking is confirmed first.',
    inputSchema: LinkInput,
    gate: (_client, input) => Promise.resolve(gateForLink(LinkInput.parse(input).remove)),
    run: async (client, input) => {
      const args = LinkInput.parse(input);
      return client.post('/api/links', args);
    },
  },
  {
    name: 'foreman_attribute',
    title: 'Attribute a commit',
    description:
      'Say which task a commit was work on. This is the strongest signal — the other two guess ' +
      'from the message or the files — so a declaration is recorded as confirmed.',
    inputSchema: AttributeInput,
    gate: (_client, input) => Promise.resolve(gateForAttribute(AttributeInput.parse(input).remove)),
    run: async (client, input) => {
      const args = AttributeInput.parse(input);
      const project = projectOf(args.task);
      const action = args.remove ? 'reject' : 'confirm';
      return client.post(
        `/api/projects/${project}/attributions/${args.sha}/${action}`,
        { task: args.task, ...(args.remove ? {} : { declared: true }) },
      );
    },
  },
];

/** The path segment for an entity's kind, from its human ID. */
function kindOf(humanId: string): string {
  const parsed = parseHumanId(humanId);
  switch (parsed?.type) {
    case 'REQ':
      return 'requirements';
    case 'T':
      return 'tasks';
    case 'P':
      return 'phases';
    default:
      throw new Error(`${humanId} cannot be changed through this tool`);
  }
}
