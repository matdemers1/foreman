import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Conflict } from '../domain/errors.js';

/**
 * Optimistic concurrency with `If-Match` (FRM-REQ-146).
 *
 * Two surfaces write to Foreman — the console and the MCP shim, often in the same minute — and a
 * last-write-wins update between them loses an edit silently. `If-Match` makes that collision
 * visible instead: the client says which version it read, and a write against a stale one is
 * refused with **412 and the current state**, so the caller can see what changed rather than having
 * to go and look.
 *
 * It is opt-in. A request with no `If-Match` writes unconditionally, because requiring it would
 * make every simple call a two-step, and the collision it guards against is rare enough that the
 * cost belongs on the careful caller rather than on everyone.
 */

/** A version for an entity: its `updatedAt`, hashed so it carries no meaning to guess at. */
export function etagFor(entity: { updatedAt: Date | string } | null | undefined): string | null {
  if (entity === null || entity === undefined) return null;
  const updatedAt =
    entity.updatedAt instanceof Date ? entity.updatedAt.toISOString() : entity.updatedAt;
  return `"${createHash('sha256').update(updatedAt).digest('hex').slice(0, 16)}"`;
}

/** Put the version on a response, so the next writer has something to send back. */
export function setEtag(res: Response, entity: { updatedAt: Date | string } | null): void {
  const etag = etagFor(entity);
  if (etag !== null) res.setHeader('ETag', etag);
}

export class StaleWrite extends Conflict {
  constructor(
    readonly current: unknown,
    readonly currentEtag: string,
  ) {
    super('that entity has changed since you read it');
    this.name = 'StaleWrite';
  }
}

/**
 * Check `If-Match` against an entity's current version. A mismatch throws, and the route turns it
 * into 412 carrying the current state.
 */
export function assertFresh(req: Request, entity: { updatedAt: Date | string }): void {
  const header = req.headers['if-match'];
  if (header === undefined) return;
  // A repeated header arrives as an array; either way the values are comma-separated.
  const presented = Array.isArray(header) ? header.join(',') : header;

  const current = etagFor(entity);
  if (current === null) return;

  // `*` means "it must exist", which it does, or we would not be here.
  const values = presented
    .split(',')
    .map((v) => v.trim());
  if (values.includes('*') || values.includes(current)) return;

  throw new StaleWrite(entity, current);
}
