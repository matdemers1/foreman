// The relay adapter (FRM-T-15.4, d3-app-contract spec/push.md): registrations, and sending. Foreman
// posts a sealed envelope to <relay>/v1/push/<registration>, signed with the registration's send key;
// the relay hands it to APNs. A 410 means the device is gone or signed out, and the registration is
// forgotten. A push is best effort: nothing here may fail the request that caused it.
import { createHmac, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { record } from '../domain/audit.js';
import { logger } from '../logger.js';
import { decryptSecret, encryptSecret } from '../auth/totp.js';
import { sealEnvelope } from './envelope.js';

/** notification.v1 — what the device opens. */
export interface Notification {
  v: 1;
  category: string;
  title: string;
  body?: string;
  thread?: string;
  link?: string;
  sentAt: string;
}

export interface Registration {
  id: string;
  devicePublicKey: Uint8Array;
  relayUrl: string;
  registration: string;
  sendKeySealed: string;
}

/** base64url(HMAC-SHA256(sendKey, "<timestamp>.<body>")), as the relay checks it. */
export function signRelayRequest(sendKey: string, timestamp: string, body: string): string {
  return createHmac('sha256', sendKey).update(`${timestamp}.${body}`).digest('base64url');
}

export type Owner = { readonly sessionId: string } | { readonly identityId: string };

/**
 * Store a registration — replacing the session's earlier one, or the same relay slot — with its send
 * key sealed under the KEK, and audit it in the same transaction.
 */
export async function register(
  db: Db,
  kek: string,
  input: {
    userId: string;
    actor: string;
    owner: Owner;
    devicePublicKey: Uint8Array;
    relayUrl: string;
    registration: string;
    sendKey: string;
    categories: string[];
  },
): Promise<Registration> {
  return db.$transaction(async (tx) => {
    await tx.relayRegistration.deleteMany({
      where: { OR: [...('sessionId' in input.owner ? [{ sessionId: input.owner.sessionId }] : []), { relayUrl: input.relayUrl, registration: input.registration }] },
    });
    const saved = await tx.relayRegistration.create({
      data: {
        id: randomUUID(),
        userId: input.userId,
        ...input.owner,
        devicePublicKey: new Uint8Array(input.devicePublicKey),
        relayUrl: input.relayUrl,
        registration: input.registration,
        sendKeySealed: encryptSecret(input.sendKey, kek),
        categories: input.categories,
      },
    });
    await record(tx, {
      actor: input.actor,
      actorKind: 'user',
      action: 'create',
      entityType: 'user',
      entityId: input.userId,
      after: { event: 'push_registered', relay: input.relayUrl, categories: input.categories, owner: 'sessionId' in input.owner ? 'session' : 'identity' },
    });
    return saved;
  });
}

export type PushResult = 'sent' | 'gone' | 'failed';

export async function push(db: Db, kek: string, registration: Registration, notification: Notification, collapseId?: string): Promise<PushResult> {
  try {
    const sendKey = decryptSecret(registration.sendKeySealed, kek);
    const ciphertext = sealEnvelope(registration.devicePublicKey, Buffer.from(JSON.stringify(notification)));
    const body = JSON.stringify({ ciphertext, priority: 'high', ...(collapseId === undefined ? {} : { collapseId: collapseId.slice(0, 64) }) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${registration.relayUrl}/v1/push/${encodeURIComponent(registration.registration)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-d3-relay-timestamp': timestamp, 'x-d3-relay-signature': signRelayRequest(sendKey, timestamp, body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 410) {
      await db.relayRegistration.deleteMany({ where: { id: registration.id } });
      return 'gone';
    }
    if (!res.ok) {
      logger.warn({ status: res.status, registration: registration.id }, 'relay refused a push');
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    logger.warn({ registration: registration.id, err: error instanceof Error ? error.message : String(error) }, 'push failed');
    return 'failed';
  }
}
