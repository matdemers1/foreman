import { Prisma, type Db } from '../db.js';
import type { ActorKind, AuditAction, EntityType } from '../generated/prisma/enums.js';

/**
 * Every mutation writes an `audit_event` — MCP writes and importer writes included, no exceptions
 * (Data Model invariant 4). It is also the substrate for undo: `before` is what a reversal replays.
 *
 * Two rules this file enforces rather than hopes for:
 *   1. The event is written **in the same transaction** as the change, so a mutation cannot exist
 *      without its record.
 *   2. Nothing sensitive reaches the snapshot — a password hash or a TOTP secret in an audit trail
 *      is a second copy of the secret, in a table built for reading.
 */

/** Field names never recorded in a before/after snapshot, whatever entity they appear on. */
const REDACTED = new Set([
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totp_secret',
  'tokenHash',
  'token_hash',
  'password',
  'token',
  'clientSecret',
]);

export function scrub(value: unknown): unknown {
  // BigInt first: it does not survive JSON.stringify, and it is not an object to fall through to.
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value instanceof Date) return value.toISOString();

  // Anything that is not a plain object is a value, not a bag of fields: Prisma's `Decimal` is the
  // one that matters here, and walking into it serialises its internals — including a `constructor`
  // the database rightly refuses. A phase number is `8.5`, not `{ s: 1, e: 0, d: [85] }`.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    const candidate = value as { toJSON?: unknown; toString?: unknown };
    if (typeof candidate.toJSON === 'function') {
      return scrub((candidate.toJSON as () => unknown).call(value));
    }
    // Only a `toString` the class actually wrote. Object's default would record the useless
    // "[object Object]" and quietly lose whatever the value was.
    if (typeof candidate.toString === 'function' && candidate.toString !== Object.prototype.toString) {
      return (candidate.toString as () => string).call(value);
    }
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name;
    return `[${name ?? 'object'}]`;
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED.has(key) ? '[redacted]' : scrub(inner);
  }
  return out;
}

export interface Actor {
  readonly actor: string;
  readonly actorKind: ActorKind;
  readonly requestId?: string | undefined;
}

export interface AuditInput extends Actor {
  readonly action: AuditAction;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly entityHumanId?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** What a `$transaction` callback is handed: the client without the connection-level methods. */
export type TransactionClient = Parameters<Parameters<Db['$transaction']>[0]>[0];

export async function record(db: TransactionClient, input: AuditInput): Promise<string> {
  const event = await db.auditEvent.create({
    data: {
      actor: input.actor,
      actorKind: input.actorKind,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.entityHumanId !== undefined ? { entityHumanId: input.entityHumanId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      before:
        input.before === undefined
          ? Prisma.JsonNull
          : (scrub(input.before) as Prisma.InputJsonValue),
      after:
        input.after === undefined ? Prisma.JsonNull : (scrub(input.after) as Prisma.InputJsonValue),
    },
    select: { id: true },
  });
  return event.id;
}

/**
 * Run a mutation and its audit event as one transaction. If the event cannot be written, the change
 * does not happen — which is the only way "no exceptions" can be true.
 */
export async function withAudit<T>(
  db: Db,
  input: Omit<AuditInput, 'entityId'> & { entityId?: string },
  mutate: (tx: TransactionClient) => Promise<{ entity: T; entityId: string; after?: unknown }>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const { entity, entityId, after } = await mutate(tx);
    await record(tx, { ...input, entityId, after: after ?? entity });
    return entity;
  });
}
