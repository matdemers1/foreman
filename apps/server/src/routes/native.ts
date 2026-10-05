import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { record } from '../domain/audit.js';
import { logger } from '../logger.js';
import { canonicalAppUri, type Verifier } from '../auth/resource-server.js';
import * as native from '../auth/native.js';
import * as sessions from '../auth/sessions.js';
import * as throttle from '../auth/throttle.js';
import { requestDeletion } from '../domain/account-deletion.js';
import { acceptInvite } from '../domain/members.js';

/**
 * The D3 App contract's native sessions (FRM-P-14), mounted at `/auth/native`: D3 Constellation
 * signs in without a browser. The password and code are checked by the console login's own steps —
 * the same throttle-before-hash, decoy, rehash and burned TOTP step — and what differs is the
 * envelope: tokens in JSON, never a cookie, and every refusal as problem+json with the contract's
 * registered type.
 */

const PROBLEMS = 'https://d3cloud.io/problems/';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

export function problem(res: Response, status: number, name: string | null, title: string, extra: Record<string, unknown> = {}): void {
  res
    .status(status)
    .type('application/problem+json')
    .send(JSON.stringify({ type: name === null ? 'about:blank' : `${PROBLEMS}${name}`, title, status, ...extra }));
}

const DeviceShape = z.object({ name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(40) });
const SignIn = z.union([
  z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), device: DeviceShape.optional() }),
  z.object({ challenge: z.string().min(1).max(200), totp: z.string().min(1).max(16) }),
]);
const Refresh = z.object({ refreshToken: z.string().min(1).max(200) });
const InviteStep = z.union([
  z.object({
    token: z.string().min(1).max(200),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(1024),
    device: DeviceShape.optional(),
  }),
  z.object({ challenge: z.string().min(1).max(200), enrolTotp: z.string().min(1).max(16) }),
]);
const DeleteAccount = z.object({ confirmation: z.string().max(253), totp: z.string().min(1).max(16) });
/** The contract asks for at least ten minutes to type the first code into a new authenticator. */
const ENROL_TTL_MS = 15 * 60 * 1000;
/** The same floor as the console's invitation (`InviteAccept`), and said the same way. */
const PASSWORD_MIN = 12;
const Link = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), totp: z.string().min(1).max(16) });

interface Pending {
  readonly userId: string;
  readonly email: string;
  readonly device: sessions.Device | null;
  readonly expiresAt: number;
  attempts: number;
}

export interface NativeRouteDeps {
  readonly db: Db;
  readonly config: Config;
  readonly verifier?: Verifier | null;
}

const tokensBody = (t: sessions.NativeTokens) => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresIn: t.expiresIn,
  session: { id: t.sessionId },
});

export function nativeRoutes({ db, config, verifier }: NativeRouteDeps): Router {
  const router = Router();
  const challenges = new Map<string, Pending>();
  const deps = { db, config };

  const throttled = (res: Response, retryAfterMs: number): void => {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    problem(res, 429, 'throttled', 'Too many attempts', { retryAfter });
  };

  const audit = (actor: string, entityId: string, after: Record<string, unknown>) =>
    record(db, { actor, actorKind: 'user', action: 'create', entityType: 'user', entityId, after: { ...after, via: 'native' } });

  const signedIn = async (req: Request, res: Response, userId: string, email: string, device: sessions.Device | null): Promise<void> => {
    // As the console's login does: a sign-in that succeeded forgives the fumbles before it.
    await throttle.clear(db, { account: email, ip: req.ip ?? 'unknown' });
    const tokens = await sessions.issueNative(db, userId, 'password', { device, ip: req.ip, userAgent: req.get('user-agent') });
    await audit(email, userId, { event: 'login', method: 'password', device: device?.name ?? null, sessionId: tokens.sessionId });
    logger.info({ userId, method: 'password', native: true }, 'login');
    res.setHeader('Cache-Control', 'no-store');
    res.json(tokensBody(tokens));
  };

  router.post('/signin', (req, res, next) => {
    void (async () => {
      const parsed = SignIn.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a sign-in');
        return;
      }
      const body = parsed.data;
      const ip = req.ip ?? 'unknown';
      const now = Date.now();
      for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);

      if ('email' in body) {
        const first = await native.passwordStep(deps, { email: body.email, password: body.password, ip });
        if (first.kind === 'throttled') {
          throttled(res, first.retryAfterMs);
          return;
        }
        if (first.kind === 'rejected') {
          problem(res, 401, 'invalid_credentials', 'The email or password is wrong');
          return;
        }
        // No second factor enrolled: the contract gives the session at the password step.
        if (!first.totpEnrolled) {
          await signedIn(req, res, first.userId, first.email, body.device ?? null);
          return;
        }
        const challenge = randomBytes(32).toString('base64url');
        challenges.set(challenge, { userId: first.userId, email: first.email, device: body.device ?? null, expiresAt: now + CHALLENGE_TTL_MS, attempts: 0 });
        res.status(202).json({ next: 'totp', challenge });
        return;
      }

      const pending = challenges.get(body.challenge);
      if (pending === undefined) {
        problem(res, 401, 'invalid_code', 'This sign-in has expired', { detail: 'Start again with your email and password.' });
        return;
      }
      // Counted before anything slow, and the challenge dies at the cap: a challenge is not a way
      // to guess codes without the throttle noticing.
      pending.attempts += 1;
      if (pending.attempts >= MAX_CODE_ATTEMPTS) challenges.delete(body.challenge);
      if (!(await native.codeStep(deps, { userId: pending.userId, email: pending.email, code: body.totp, ip }))) {
        problem(res, 401, 'invalid_code', 'That code didn’t work');
        return;
      }
      challenges.delete(body.challenge);
      await signedIn(req, res, pending.userId, pending.email, pending.device);
    })().catch(next);
  });

  router.post('/refresh', (req, res, next) => {
    void (async () => {
      const parsed = Refresh.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a refresh');
        return;
      }
      const rotation = await sessions.rotateNative(db, parsed.data.refreshToken);
      if (rotation.kind === 'ended') {
        problem(res, 401, 'session_revoked', 'This sign-in has ended');
        return;
      }
      if (rotation.kind === 'reused') {
        // A rotated token came back: it leaked, or a client replayed it. The session ends.
        await sessions.revoke(db, rotation.sessionId);
        await audit(rotation.userId, rotation.userId, { event: 'refresh_reused', sessionId: rotation.sessionId });
        problem(res, 401, 'refresh_reused', 'This sign-in was used twice and has been ended');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ accessToken: rotation.tokens.accessToken, refreshToken: rotation.tokens.refreshToken, expiresIn: rotation.tokens.expiresIn });
    })().catch(next);
  });

  router.post('/revoke', (req, res, next) => {
    void (async () => {
      const auth = req.auth;
      if (auth?.native !== true || auth.sessionId === undefined) {
        problem(res, 401, 'session_revoked', 'This sign-in has ended');
        return;
      }
      await sessions.revoke(db, auth.sessionId);
      await record(db, { actor: auth.actor, actorKind: 'user', action: 'delete', entityType: 'user', entityId: auth.userId ?? auth.sessionId, after: { event: 'logout', via: 'native' } });
      res.status(204).end();
    })().catch(next);
  });

  /**
   * Link the D3 Auth identity in the Bearer token (the app's audience) to a Foreman account, once.
   * The account is proven with its own password and code, throttled as a sign-in. Never by email.
   */
  router.post('/link', (req, res, next) => {
    void (async () => {
      const parsed = Link.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a link');
        return;
      }
      const header = req.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      let token;
      try {
        if (verifier === null || verifier === undefined || presented === '') throw new Error('no token');
        token = await verifier.verify(presented, 'app');
      } catch {
        problem(res, 401, 'session_revoked', "This D3 Auth sign-in isn't valid here");
        return;
      }
      const ip = req.ip ?? 'unknown';
      const first = await native.passwordStep(deps, { email: parsed.data.email, password: parsed.data.password, ip });
      if (first.kind === 'throttled') {
        throttled(res, first.retryAfterMs);
        return;
      }
      if (first.kind === 'rejected') {
        problem(res, 401, 'invalid_credentials', 'The email or password is wrong');
        return;
      }
      if (first.totpEnrolled && !(await native.codeStep(deps, { userId: first.userId, email: first.email, code: parsed.data.totp, ip }))) {
        problem(res, 401, 'invalid_code', 'That code didn’t work');
        return;
      }
      const linked = await native.linkIdentity(deps, { userId: first.userId, email: first.email, iss: token.iss, sub: token.sub });
      if (linked.kind === 'elsewhere') {
        problem(res, 409, null, 'This D3 Auth account is linked to another Foreman account', { detail: 'Unlink it there first.' });
        return;
      }
      res.json({ linked: true, accountId: first.userId });
    })().catch(next);
  });

  /**
   * Accept an invitation from the app (FRM-T-15.2): the account, then its second factor, then a
   * native session — a board deployment's only way in, so a solo Foreman answers 404. The
   * invitation is spent by the console's own `acceptInvite`; what differs is that the app enrols
   * the authenticator in the same breath, and signs in only once a code proves it.
   */
  const enrolments = new Map<string, Pending>();
  router.post('/invite', (req, res, next) => {
    void (async () => {
      if (config.FOREMAN_MODE !== 'board') {
        problem(res, 404, null, 'This Foreman does not take invitations');
        return;
      }
      const parsed = InviteStep.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not an invitation');
        return;
      }
      const body = parsed.data;
      const ip = req.ip ?? 'unknown';
      const now = Date.now();
      for (const [key, value] of enrolments) if (value.expiresAt <= now) enrolments.delete(key);

      if ('token' in body) {
        // Keyed by the token's hash, so every guess is its own account key and only the IP adds up.
        const keys = { account: `invite:${sessions.hashToken(body.token).slice(0, 24)}`, ip };
        const decision = await throttle.check(db, keys);
        if (!decision.allowed) {
          throttled(res, decision.retryAfterMs);
          return;
        }
        const invitation = await db.invite.findUnique({ where: { tokenHash: sessions.hashToken(body.token) }, select: { acceptedAt: true, expiresAt: true } });
        // One answer for unknown, spent and lapsed: telling them apart says which guess was real.
        if (invitation === null || invitation.acceptedAt !== null || invitation.expiresAt.getTime() <= now) {
          await throttle.recordFailure(db, keys);
          problem(res, 410, 'invite_invalid', 'This invite can’t be used', { detail: 'It has been used or has expired. Ask for a new one.' });
          return;
        }
        if (body.password.length < PASSWORD_MIN) {
          problem(res, 422, 'weak_password', 'Choose a longer password', { detail: `Use at least ${String(PASSWORD_MIN)} characters.` });
          return;
        }
        let accepted: { email: string; userId: string };
        try {
          accepted = await acceptInvite(db, config, { token: body.token, password: body.password, displayName: body.displayName });
        } catch {
          // Spent between the look and the write: the same answer as any other unusable token.
          problem(res, 410, 'invite_invalid', 'This invite can’t be used', { detail: 'It has been used or has expired. Ask for a new one.' });
          return;
        }
        const user = { id: accepted.userId, email: accepted.email };
        const { secret, uri } = await native.beginTotpEnrolment(deps, user.id);
        const challenge = randomBytes(32).toString('base64url');
        enrolments.set(challenge, { userId: user.id, email: user.email, device: body.device ?? null, expiresAt: now + ENROL_TTL_MS, attempts: 0 });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ challenge, enrolment: { secret, otpauthUri: uri, digits: 6, period: 30 } });
        return;
      }

      const pending = enrolments.get(body.challenge);
      if (pending === undefined) {
        problem(res, 401, 'invalid_code', 'This setup has expired', { detail: 'Your account exists: sign in with your email and password.' });
        return;
      }
      const keys = { account: pending.email, ip };
      const decision = await throttle.check(db, keys);
      if (!decision.allowed) {
        throttled(res, decision.retryAfterMs);
        return;
      }
      // A wrong code leaves the challenge valid until it expires, as the contract has it; the
      // throttle on the account is what stops it being a way to guess.
      if (!(await native.confirmTotpEnrolment(deps, pending.userId, body.enrolTotp))) {
        await throttle.recordFailure(db, keys);
        problem(res, 401, 'invalid_code', 'That code didn’t work', { detail: 'Check the time on your device, then try the current code.' });
        return;
      }
      enrolments.delete(body.challenge);
      await signedIn(req, res, pending.userId, pending.email, pending.device);
    })().catch(next);
  });

  /**
   * Delete your own account from the app (FRM-T-15.3, FRM-ADR-022): the host name typed out and a
   * current code, then a grace period. Only a person can ask — a native session or a D3 Auth token
   * for the app's audience — never an API token, which is not anybody.
   */
  router.post('/delete-account', (req, res, next) => {
    void (async () => {
      const auth = req.auth;
      if (auth === undefined || auth.userId === null || (auth.native !== true && auth.appToken !== true)) {
        problem(res, 401, 'session_revoked', 'Sign in again to delete this account');
        return;
      }
      if (config.FOREMAN_MODE !== 'board') {
        problem(res, 404, null, 'This Foreman has one operator, whose account is not deleted from an app');
        return;
      }
      const parsed = DeleteAccount.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a deletion');
        return;
      }
      const host = new URL(canonicalAppUri(config)).hostname;
      if (parsed.data.confirmation.trim().toLowerCase() !== host.toLowerCase()) {
        problem(res, 422, null, 'The confirmation doesn’t match', { detail: `Type ${host} exactly to confirm.` });
        return;
      }
      const user = await db.user.findUnique({ where: { id: auth.userId }, select: { email: true, credential: { select: { totpConfirmedAt: true } } } });
      if (user === null) {
        problem(res, 401, 'session_revoked', 'Sign in again to delete this account');
        return;
      }
      if ((user.credential?.totpConfirmedAt ?? null) === null) {
        problem(res, 422, null, 'This account has no authenticator', { detail: 'Set one up in Foreman’s console first: deleting an account needs a current code.' });
        return;
      }
      const ip = req.ip ?? 'unknown';
      const keys = { account: user.email, ip };
      const decision = await throttle.check(db, keys);
      if (!decision.allowed) {
        throttled(res, decision.retryAfterMs);
        return;
      }
      if (!(await native.codeStep(deps, { userId: auth.userId, email: user.email, code: parsed.data.totp, ip }))) {
        problem(res, 401, 'invalid_code', 'That code didn’t work');
        return;
      }
      const outcome = await requestDeletion(db, auth.userId);
      if (outcome.kind === 'last_owner') {
        problem(res, 409, 'last_owner', 'You’re the last admin', { detail: 'Make someone else an admin in Foreman first, then delete this account.' });
        return;
      }
      if (outcome.kind === 'gone') {
        problem(res, 401, 'session_revoked', 'This account is already being deleted');
        return;
      }
      logger.info({ userId: auth.userId }, 'account deletion scheduled');
      res.status(202).json({ graceUntil: outcome.graceUntil.toISOString() });
    })().catch(next);
  });

  return router;
}

/** The manifest (FRM-T-14.1), at the origin's root, unauthenticated. */
export function manifestRoutes(config: Config, d3authAvailable: boolean): Router {
  const router = Router();
  router.get('/.well-known/d3-app.json', (_req, res) => {
    const base = canonicalAppUri(config);
    const issuer = d3authAvailable ? config.D3AUTH_ISSUER : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      product: 'foreman',
      name: 'Foreman',
      version: process.env['FOREMAN_VERSION'] ?? '0.0.0',
      revision: process.env['FOREMAN_REVISION'] ?? null,
      contract: 1,
      capabilities: ['foreman.brief', 'foreman.tasks', 'foreman.findings', 'foreman.documents'],
      signIn: {
        methods: issuer === undefined ? ['password', 'totp'] : ['password', 'totp', 'd3auth'],
        // The app's audience, not /mcp's: they are different resources (FRM-T-14.3).
        ...(issuer === undefined ? {} : { d3auth: { issuer, resource: base } }),
      },
      endpoints: {
        nativeSignIn: `${base}/auth/native/signin`,
        nativeRefresh: `${base}/auth/native/refresh`,
        nativeRevoke: `${base}/auth/native/revoke`,
        me: `${base}/auth/me`,
        link: issuer === undefined ? null : `${base}/auth/native/link`,
        // A board deployment invites people, so it can delete them too (CON-ADR-011); a solo
        // Foreman has one operator and neither.
        inviteAccept: config.FOREMAN_MODE === 'board' ? `${base}/auth/native/invite` : null,
        deleteAccount: config.FOREMAN_MODE === 'board' ? `${base}/auth/native/delete-account` : null,
        relayRegister: `${base}/api/push/native/register`,
      },
    });
  });
  return router;
}
