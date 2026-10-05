// The D3 App contract's conformance suite needs a running Foreman and an account it can sign in to
// (FRM-T-14.4). This boots the server on DATABASE_URL (already migrated) with one person whose TOTP
// secret is generated here, and writes the suite's arguments to CONFORMANCE_OUT:
//
//   DATABASE_URL=… CONFORMANCE_OUT=/tmp/args.json node --import tsx test/conformance-server.ts
//
// Plain http on 127.0.0.1, so the suite runs with --allow-http — for CI and a laptop, never a host.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { setPassword } from '../src/auth/native.js';
import { encryptSecret, generateSecret } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

const url = process.env['DATABASE_URL'];
const out = process.env['CONFORMANCE_OUT'];
const port = Number(process.env['PORT'] ?? '3479');
if (url === undefined || out === undefined) {
  process.stderr.write('DATABASE_URL and CONFORMANCE_OUT are required\n');
  process.exit(2);
}

const origin = `http://127.0.0.1:${String(port)}`;
const kek = randomBytes(32).toString('base64');
const config = loadConfig({
  NODE_ENV: 'test',
  BASE_URL: origin,
  DATABASE_URL: url,
  KEK: kek,
  PEPPER: randomBytes(32).toString('base64'),
  COOKIE_KEYS: randomBytes(32).toString('base64'),
});
const db = createDb(url);
const email = `conformance-${randomBytes(4).toString('hex')}@example.com`;
const password = `conformance ${randomBytes(6).toString('hex')} staple`;
const totpSecret = generateSecret();
const user = await db.user.create({ data: { email, displayName: 'Conformance', status: 'active' } });
await setPassword({ db, config }, user.id, password);
await db.credential.update({ where: { userId: user.id }, data: { totpSecret: encryptSecret(totpSecret, kek), totpConfirmedAt: new Date() } });

const server = createApp({ config, db, verifier: null, oidc: null }).listen(port, '127.0.0.1', () => {
  writeFileSync(out, `${JSON.stringify({ base: origin, product: 'foreman', email, password, totpSecret })}\n`, { mode: 0o600 });
  process.stdout.write(`conformance server on ${origin}\n`);
});
const stop = (): void => {
  server.close();
  void db.$disconnect().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
