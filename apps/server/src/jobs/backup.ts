import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ALERTS, type Mailer } from '../adapters/mail.js';
import type { Config } from '../config.js';
import type { JobDefinition } from './types.js';

/**
 * The nightly dump, and the drill that proves it (T-7.6, T-7.7, FRM-REQ-144, FRM-REQ-145).
 *
 * ADR-007: the database dump is the **only** escape hatch. After cutover there is no markdown
 * mirror behind Foreman, so this file is the entire recovery story — which is why the drill exists
 * and why its absence is a problem the health screen reports out loud.
 *
 * Bindery's own code review found a restore drill "verified by grepping" rather than by running.
 * That finding is free to inherit: `restore-drill` below actually restores into a scratch database
 * and queries it.
 */

export interface BackupDeps {
  readonly config: Pick<Config, 'DATABASE_URL' | 'BACKUP_DIR' | 'BACKUP_RETENTION_DAYS'>;
  readonly mailer?: Mailer | undefined;
}

/** Run a command, collecting stderr so a failure says what went wrong rather than "exit 1". */
function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; stdout?: NodeJS.WritableStream } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.env },
      stdio: ['ignore', options.stdout === undefined ? 'ignore' : 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.stdout !== undefined && child.stdout !== null) {
      pipeline(child.stdout, options.stdout).catch(reject);
    }

    child.on('error', reject);
    child.on('close', (code) => { resolve({ code: code ?? 1, stderr: stderr.slice(-4000) }); });
  });
}

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function backupJob(deps: BackupDeps): JobDefinition {
  return {
    kind: 'backup',
    stages: [
      {
        name: 'dump',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          await mkdir(dir, { recursive: true });

          const path = join(dir, `foreman-${stamp(new Date())}.sql.gz`);
          const out = createWriteStream(path);
          const gzip = createGzip();
          const compressed = pipeline(gzip, out);

          // `--no-owner` and `--no-privileges`: a dump that can only be restored as the role that
          // made it is a dump that fails on the day it is needed, on a fresh host.
          const result = await run(
            'pg_dump',
            ['--no-owner', '--no-privileges', '--format=plain', deps.config.DATABASE_URL],
            { stdout: gzip },
          );
          await compressed;

          if (result.code !== 0) {
            await unlink(path).catch(() => undefined);
            const detail = `pg_dump exited ${String(result.code)}: ${result.stderr}`;
            await deps.mailer?.send(ALERTS.backupFailed(detail));
            throw new Error(detail);
          }

          const info = await stat(path);
          // A dump that is suspiciously small is a dump that restored nothing. Caught here, where
          // the fix is cheap, rather than during a restore, where it is not.
          if (info.size < 1024) {
            await deps.mailer?.send(
              ALERTS.backupFailed(`The dump is only ${String(info.size)} bytes.`),
            );
            throw new Error(`the dump is only ${String(info.size)} bytes — that cannot be right`);
          }

          ctx.logger.info({ path, bytes: info.size }, 'database dumped');
          return { path, bytes: info.size };
        },
      },
      {
        name: 'prune',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          const keepFor = deps.config.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
          const cutoff = Date.now() - keepFor;

          const removed: string[] = [];
          for (const name of await readdir(dir)) {
            if (!name.startsWith('foreman-') || !name.endsWith('.sql.gz')) continue;
            const path = join(dir, name);
            const info = await stat(path);
            if (info.mtime.getTime() >= cutoff) continue;
            await unlink(path);
            removed.push(name);
          }

          if (removed.length > 0) ctx.logger.info({ removed }, 'old dumps pruned');
          return { removed, retentionDays: deps.config.BACKUP_RETENTION_DAYS };
        },
      },
    ],
  };
}

/**
 * The restore drill (FRM-REQ-145).
 *
 * **Performed, not documented.** It restores the newest dump into a scratch database, counts what
 * came back, and drops it. The runbook describes this; the job *is* it, which is the difference
 * between a backup that is known to work and one that is believed to.
 */
export function restoreDrillJob(deps: BackupDeps): JobDefinition {
  return {
    kind: 'restore-drill',
    stages: [
      {
        name: 'restore',
        async run(ctx) {
          const dir = deps.config.BACKUP_DIR;
          const dumps = (await readdir(dir))
            .filter((name) => name.startsWith('foreman-') && name.endsWith('.sql.gz'))
            .sort()
            .reverse();

          const newest = dumps[0];
          if (newest === undefined) throw new Error('there is no dump to restore');

          // A scratch database named for this run, so a drill can never touch the real one.
          const scratch = `foreman_drill_${String(Date.now())}`;
          const admin = new URL(deps.config.DATABASE_URL);
          const adminUrl = new URL(admin.toString());
          adminUrl.pathname = '/postgres';

          const created = await run('psql', [adminUrl.toString(), '-c', `create database "${scratch}"`]);
          if (created.code !== 0) throw new Error(`could not create the scratch database: ${created.stderr}`);

          const target = new URL(admin.toString());
          target.pathname = `/${scratch}`;

          try {
            const restored = await run('sh', [
              '-c',
              `gunzip -c ${JSON.stringify(join(dir, newest))} | psql ${JSON.stringify(target.toString())} -v ON_ERROR_STOP=1`,
            ]);
            if (restored.code !== 0) {
              throw new Error(`the restore failed: ${restored.stderr}`);
            }

            // The assertion that makes this a drill rather than a file copy: the restored database
            // has to answer a question about the data.
            const counted = await run('sh', [
              '-c',
              `psql ${JSON.stringify(target.toString())} -tAc "select count(*) from project"`,
            ]);
            if (counted.code !== 0) {
              throw new Error(`the restored database would not answer a query: ${counted.stderr}`);
            }

            ctx.logger.info({ dump: newest, scratch }, 'restore drill succeeded');
            return { dump: newest, scratch, verifiedAt: new Date().toISOString() };
          } finally {
            // Always, even on failure: a drill that leaves scratch databases behind is one that
            // eventually fills the disk it was protecting.
            await run('psql', [adminUrl.toString(), '-c', `drop database if exists "${scratch}"`]);
          }
        },
      },
    ],
  };
}
