import { randomBytes } from 'node:crypto';
import { hashToken } from '../auth/sessions.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { record } from '../domain/audit.js';

/**
 * Issue a scoped API token for the MCP shim.
 *
 *   pnpm --filter foreman-server exec tsx src/cli/issue-token.ts "matt's laptop"
 *
 * **Shown once.** Only the SHA-256 is stored, so a stolen database row is not a usable token and
 * there is no "show me it again" — losing it means issuing another, which is the correct cost.
 */

const name = process.argv[2];
if (name === undefined || name.trim().length === 0) {
  process.stderr.write('usage: issue-token <name>   e.g. issue-token "matt\'s laptop"\n');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const token = `frm_${randomBytes(32).toString('base64url')}`;
  // A short, non-secret prefix so a token can be recognised in a list without revealing it.
  const prefix = token.slice(0, 12);

  const row = await db.apiToken.create({
    data: {
      name: name.trim(),
      tokenHash: hashToken(token),
      prefix,
      scopes: ['read'],
      createdBy: 'cli',
    },
  });

  await record(db, {
    actor: 'cli',
    actorKind: 'system',
    action: 'create',
    entityType: 'api_token',
    entityId: row.id,
    entityHumanId: prefix,
    // The token itself never reaches the audit trail — `scrub` would redact it anyway.
    after: { name: row.name, prefix, scopes: row.scopes },
  });

  process.stdout.write(
    `\nIssued "${row.name}" (${prefix}…). This is the only time it is shown:\n\n    ${token}\n\n` +
      'Give it to the shim:\n\n' +
      `    FOREMAN_URL=${config.BASE_URL} FOREMAN_TOKEN=${token} foreman-mcp\n\n`,
  );
} finally {
  await db.$disconnect();
}
