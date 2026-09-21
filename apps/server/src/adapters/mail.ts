import type { Config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Alert email, through D3 Auth's mail-relay Worker (T-7.5, FRM-REQ-143).
 *
 * **Reused, not rebuilt.** D3 Auth already runs a Cloudflare Worker that holds the sending
 * credential and speaks to the mail provider; Foreman posts to it with a shared token. A second
 * mail integration would mean a second credential to rotate and a second thing to be wrong at 3am.
 *
 * Alerts are for the four conditions nobody will otherwise notice: ingestion failing, the queue
 * stalling, a backup failing, and a reconcile gap that cannot be healed. Not for anything a person
 * would see on the screen anyway — an alert that fires on things you already know is an alert you
 * filter to a folder.
 */

export type AlertKind = 'ingest-failed' | 'queue-stalled' | 'backup-failed' | 'unhealable-gap';

export interface Alert {
  readonly kind: AlertKind;
  readonly subject: string;
  readonly body: string;
}

export interface MailResult {
  readonly sent: boolean;
  /** Why it was not sent, when it was not. Silence about a failed alert is its own incident. */
  readonly reason?: string;
}

export interface Mailer {
  send(alert: Alert): Promise<MailResult>;
}

/**
 * Alerts are deduplicated in memory for this long.
 *
 * A stalled queue is still stalled a minute later, and an alert that repeats every minute trains
 * its reader to ignore it. One an hour per condition is enough to stay noticed.
 */
const REPEAT_AFTER_MS = 60 * 60 * 1000;

export function createMailer(
  config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'ALERT_TO' | 'BASE_URL'>,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Mailer {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const lastSent = new Map<AlertKind, number>();

  return {
    async send(alert) {
      const { MAIL_RELAY_URL: url, MAIL_RELAY_TOKEN: token, ALERT_TO: to } = config;

      if (url === undefined || token === undefined || to === undefined) {
        // Not configured is not an error: a clone with no relay still runs, and the health screen
        // shows the same problems the email would have described.
        return { sent: false, reason: 'no mail relay is configured' };
      }

      const previous = lastSent.get(alert.kind);
      if (previous !== undefined && now().getTime() - previous < REPEAT_AFTER_MS) {
        return { sent: false, reason: 'already alerted about this recently' };
      }

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            to,
            subject: `[Foreman] ${alert.subject}`,
            // Plain text. An alert is read on a phone at an awkward moment.
            text: `${alert.body}\n\n— ${config.BASE_URL}/health`,
          }),
        });

        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          logger.error({ kind: alert.kind, status: res.status, detail }, 'alert email refused');
          return { sent: false, reason: `the relay answered ${String(res.status)}` };
        }

        lastSent.set(alert.kind, now().getTime());
        logger.info({ kind: alert.kind }, 'alert sent');
        return { sent: true };
      } catch (error) {
        // An alert that cannot be sent must not take down what was trying to send it.
        const reason = error instanceof Error ? error.message : String(error);
        logger.error({ kind: alert.kind, err: reason }, 'alert email failed');
        return { sent: false, reason };
      }
    },
  };
}

/**
 * Mail to a named person, rather than an alert to the operator (FRM-ADR-016).
 *
 * Three differences from `send`, and each one matters:
 *
 * - **`to` is an argument.** An alert always goes to `ALERT_TO`; a decision goes to whoever
 *   submitted the thing that was decided.
 * - **Never deduplicated.** Two people funded on the same afternoon must both be told. The hourly
 *   suppression that keeps a stalled queue from shouting would silently drop the second one.
 * - **Never throws.** A relay that is down must not fail the funding decision that had already
 *   been committed to the database by the time this runs. It returns why, and the caller carries
 *   on — which is why every route that sends one also returns the information another way.
 */
export async function notifyDecision(
  config: Pick<Config, 'MAIL_RELAY_URL' | 'MAIL_RELAY_TOKEN' | 'BASE_URL'>,
  message: { to: string; subject: string; body: string },
  deps: { fetch?: typeof fetch } = {},
): Promise<MailResult> {
  const { MAIL_RELAY_URL: url, MAIL_RELAY_TOKEN: token } = config;
  if (url === undefined || token === undefined) {
    return { sent: false, reason: 'no mail relay is configured' };
  }

  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: message.to, subject: message.subject, text: message.body }),
    });
    if (!res.ok) {
      // The address is logged, the body is not: a decision's wording is nobody's business but the
      // people it was sent to, and a log is the one place it would sit forever.
      logger.error({ to: message.to, status: res.status }, 'notification refused');
      return { sent: false, reason: `the relay answered ${String(res.status)}` };
    }
    return { sent: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error({ to: message.to, err: reason }, 'notification failed');
    return { sent: false, reason };
  }
}

/** The four conditions, worded so the subject line alone says what happened. */
export const ALERTS = {
  ingestFailed: (detail: string): Alert => ({
    kind: 'ingest-failed',
    subject: 'Ingest is failing',
    body: `A GitHub ingest job failed and has exhausted its retries.\n\n${detail}`,
  }),
  queueStalled: (depth: number, oldest: string): Alert => ({
    kind: 'queue-stalled',
    subject: `The job queue has stalled (${String(depth)} waiting)`,
    body:
      `Nothing has been claimed since ${oldest}. The worker may be down, or a job may be ` +
      `holding a lease it cannot finish.`,
  }),
  backupFailed: (detail: string): Alert => ({
    kind: 'backup-failed',
    subject: 'The nightly database dump failed',
    body:
      `After cutover the dump is the only recovery path there is (ADR-007).\n\n${detail}`,
  }),
  unhealableGap: (repo: string, detail: string): Alert => ({
    kind: 'unhealable-gap',
    subject: `A reconcile gap in ${repo} could not be healed`,
    body: `The reconcile found history it could not read back.\n\n${detail}`,
  }),
} as const;
