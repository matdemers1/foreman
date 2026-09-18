import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import type { Config } from '../config.js';
import { handler } from './helpers.js';
import type { Db } from '../db.js';
import { enqueue, type JobRegistry } from '../jobs/index.js';
import { logger } from '../logger.js';

/**
 * The GitHub webhook receiver (T-5.2, FRM-REQ-029, FRM-REQ-100).
 *
 * Two rules, and both are about what this endpoint does **not** do:
 *
 * 1. **It verifies before it reads.** An unsigned or mis-signed payload is 401 and nothing else —
 *    no parse, no enqueue, no log of its contents. The signature is over the raw bytes, which is
 *    why this router parses `raw` and is mounted before `express.json`.
 * 2. **It never processes inline.** It enqueues and answers 202. A handler that does the work
 *    takes seconds, GitHub times out at ten, and a timed-out delivery is *retried* — so slow
 *    processing does not merely delay the data, it duplicates it.
 */

/** Events worth a job. Anything else is acknowledged and dropped, on purpose. */
const HANDLED = new Set(['push', 'check_run', 'check_suite', 'release', 'ping']);

/**
 * **There is no `pull_request` here, and there must not be** (FRM-REQ-099).
 *
 * Foreman ingests what landed, not what was proposed. A PR is a conversation about work; a commit
 * is work. `test/unit/no-pull-requests.test.ts` fails the build if this changes.
 */
export const REFUSED_EVENTS = ['pull_request', 'pull_request_review', 'issues', 'issue_comment'];

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith('sha256=')) return false;

  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    'utf8',
  );
  const presented = Buffer.from(header, 'utf8');

  // Length first: `timingSafeEqual` throws on a mismatch, and the throw would itself be a
  // side channel as well as a 500.
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

export function webhookRoutes({
  db,
  config,
  registry,
}: {
  db: Db;
  config: Config;
  registry: JobRegistry;
}): Router {
  const router = Router();

  // Raw, not JSON: the signature covers the exact bytes GitHub sent, and a re-serialised object is
  // not those bytes.
  router.use(express.raw({ type: '*/*', limit: '25mb' }));

  router.post('/github', handler(async (req: Request, res) => {
    const secret = config.GITHUB_WEBHOOK_SECRET;
    if (secret === undefined) {
      // Unconfigured is not "accept everything". A receiver that cannot verify must not pretend to.
      res.status(503).json({ error: 'no webhook secret is configured' });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.header('x-hub-signature-256');

    if (!verifySignature(secret, body, signature)) {
      // No detail: which half was wrong is information an attacker can use to iterate.
      res.status(401).json({ error: 'signature did not verify' });
      return;
    }

    const event = req.header('x-github-event') ?? 'unknown';
    const delivery = req.header('x-github-delivery') ?? '';

    if (delivery === '') {
      res.status(400).json({ error: 'no delivery id' });
      return;
    }

    if (!HANDLED.has(event) || event === 'ping') {
      logger.debug({ event, delivery }, 'webhook event acknowledged and dropped');
      // Acknowledged rather than refused: a 4xx makes GitHub retry an event we will never want.
      res.status(202).json({ accepted: true, event, delivery, queued: false });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      logger.warn({ event, delivery }, 'webhook payload was not JSON');
      res.status(400).json({ error: 'payload was not JSON' });
      return;
    }

    /**
     * **Enqueue, then answer.**
     *
     * The first version answered first and enqueued after, which reads as the faster thing to do
     * and is wrong: a 202 tells GitHub the delivery is safe, and GitHub does not retry a 202. A
     * crash in the window between the two loses the delivery permanently, and the only trace is a
     * gap a reconcile has to find days later.
     *
     * The enqueue is one insert. Answering after it still leaves the *processing* asynchronous,
     * which is what FRM-REQ-100 is actually about.
     */
    await enqueue(db, registry, 'ingest-webhook', {
      payload: { event, delivery, body: payload },
      // GitHub's own idempotency key: a redelivery carries the same one, which is what makes
      // "replayed delivery produces no duplicate rows" true at the queue as well as in the
      // stages (FRM-REQ-101).
      idempotencyKey: `gh:${delivery}`,
    });

    res.status(202).json({ accepted: true, event, delivery, queued: true });
  }));

  return router;
}
