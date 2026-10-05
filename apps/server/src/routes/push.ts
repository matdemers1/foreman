import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { isDevicePublicKey } from '../push/envelope.js';
import { push, register, type Owner } from '../push/relay.js';
import { problem } from './native.js';

/**
 * Push registration (FRM-T-15.4, the D3 App contract's push), mounted at `/api/push`: D3
 * Constellation registers this connection at the relay, then tells Foreman where to send and the key
 * to seal to. Answered 204, then one foreman.registered notification so the person knows push works.
 * Only a native session or an app token registers — never the console's cookie or an `frm_` token.
 */

const Register = z.object({
  devicePublicKey: z.string().min(1).max(200),
  relay: z.object({ url: z.string().min(1).max(500), registration: z.string().min(1).max(200), sendKey: z.string().min(16).max(200) }),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9]*\.[a-z_]+$/)).max(20),
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function pushRoutes(db: Db, config: Config): Router {
  const router = Router();

  /** https, or a loopback http relay where the test configuration allows one — never in production. */
  const relayUrlOk = (raw: string): boolean => {
    try {
      const url = new URL(raw);
      if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && config.RELAY_ALLOW_LOOPBACK_HTTP === '1' && LOOPBACK.has(url.hostname);
    } catch {
      return false;
    }
  };

  router.post('/native/register', (req, res, next) => {
    void (async () => {
      const auth = req.auth;
      // Whose it is: a native session keeps it until it ends; an app token's belongs to its identity.
      const owner: Owner | null =
        auth?.native === true && auth.sessionId !== undefined
          ? { sessionId: auth.sessionId }
          : auth?.appToken === true && auth.identityId !== undefined
            ? { identityId: auth.identityId }
            : null;
      if (owner === null || auth?.userId === undefined || auth.userId === null) {
        problem(res, 401, 'session_revoked', 'Sign in again');
        return;
      }
      const parsed = Register.safeParse(req.body);
      const devicePublicKey = parsed.success ? Buffer.from(parsed.data.devicePublicKey, 'base64') : null;
      if (!parsed.success || devicePublicKey === null || !isDevicePublicKey(devicePublicKey) || !relayUrlOk(parsed.data.relay.url)) {
        problem(res, 400, null, 'That is not a relay registration');
        return;
      }
      const saved = await register(db, config.KEK, {
        userId: auth.userId,
        actor: auth.actor,
        owner,
        devicePublicKey,
        relayUrl: parsed.data.relay.url.replace(/\/$/, ''),
        registration: parsed.data.relay.registration,
        sendKey: parsed.data.relay.sendKey,
        categories: parsed.data.categories,
      });
      res.status(204).end();
      // After the answer, never instead of it: a relay that is down must not fail the registration.
      void push(db, config.KEK, saved, {
        v: 1,
        category: 'foreman.registered',
        title: 'Notifications are on',
        body: 'Foreman will tell this device what needs it.',
        sentAt: new Date().toISOString(),
      });
    })().catch(next);
  });

  return router;
}
