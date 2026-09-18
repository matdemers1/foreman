import { writeFile } from 'node:fs/promises';

// The drain loop itself lands in T-0.5. The heartbeat file exists from the start because the
// Compose healthcheck reads it.
const HEARTBEAT = '/tmp/worker-heartbeat';

async function beat(): Promise<void> {
  await writeFile(HEARTBEAT, new Date().toISOString(), 'utf8');
}

await beat();
setInterval(() => {
  void beat();
}, 30_000);

process.stdout.write('foreman-worker started\n');
