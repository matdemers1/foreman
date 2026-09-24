import { randomBytes } from 'node:crypto';
import { setPassword } from '../auth/native.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { record } from '../domain/audit.js';

/**
 * The first admin of a board deployment (FRM-ADR-016).
 *
 * **A chicken-and-egg this feature shipped with and should not have.** Inviting somebody requires
 * an admin, and a fresh board database has no accounts at all — nothing seeds `OPERATOR_EMAIL` at
 * boot, despite the runbook once claiming it did. The first board instance was bootstrapped by
 * copying a script into the container, which is exactly the kind of step that gets done once,
 * badly, at the wrong moment.
 *
 * Deliberately **not** `seed-example`: that creates the EXMP demo project too, and a fund board
 * with a disposable software project in it is a fund board somebody has to explain.
 *
 *     docker compose exec server node dist/cli/bootstrap-admin.js you@example.com
 *
 * Idempotent on the account and not on the password: running it again promotes an existing
 * account to `admin` and sets a new password, which is also the answer to "the only admin is
 * locked out". Takes the password from `BOOTSTRAP_PASSWORD` when set, and otherwise generates one
 * and prints it — printed once, never stored, and never written to the audit trail.
 */

const email = process.argv[2]?.trim().toLowerCase();
if (email === undefined || !email.includes('@')) {
  process.stderr.write('usage: node dist/cli/bootstrap-admin.js <email>\n');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

if (config.FOREMAN_MODE !== 'board') {
  // A solo instance has one operator and no roles to hand out; making an admin there is a
  // meaningless act that would still set somebody's password.
  process.stderr.write('this instance is not running in board mode (FOREMAN_MODE=board)\n');
  process.exit(1);
}

const password = process.env['BOOTSTRAP_PASSWORD'] ?? randomBytes(18).toString('base64url');

try {
  const existing = await db.user.findUnique({ where: { email }, select: { id: true, role: true } });
  const user = await db.user.upsert({
    where: { email },
    update: { role: 'admin', status: 'active' },
    create: {
      email,
      displayName: config.OPERATOR_DISPLAY_NAME ?? email,
      role: 'admin',
      status: 'active',
    },
  });

  await setPassword({ db, config }, user.id, password);
  await db.$transaction(async (tx) => {
    await record(tx, {
      actor: 'bootstrap-admin',
      actorKind: 'system',
      action: existing === null ? 'create' : 'update',
      entityType: 'user',
      entityId: user.id,
      entityHumanId: email,
      // The password is absent on purpose: an audit trail that carries a live credential is a
      // second copy of it, in the one place designed to be kept forever.
      after: { role: 'admin', status: 'active' },
    });
  });

  process.stdout.write(
    existing === null ? `created ${email} as an admin\n` : `promoted ${email} to admin\n`,
  );
  if (process.env['BOOTSTRAP_PASSWORD'] === undefined) {
    process.stdout.write(`\n  password: ${password}\n\n  Shown once. Change it after signing in.\n`);
  } else {
    process.stdout.write('password set from BOOTSTRAP_PASSWORD\n');
  }
} finally {
  await db.$disconnect();
}
