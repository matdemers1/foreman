import { createServer } from 'node:http';
import express from 'express';

// Liveness and readiness only, for now. Configuration, boot refusal and the pre-migration dump
// land in T-0.4; routes land in Phase 1.
const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/readyz', (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env['PORT'] ?? 3200);
createServer(app).listen(port, () => {
  process.stdout.write(`foreman-server listening on ${port}\n`);
});
