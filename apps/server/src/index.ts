import { migrate } from './boot.js';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './app.js';
import { createOidcClient } from './auth/oidc.js';
import { createDb } from './db.js';
import { logger } from './logger.js';

/**
 * Entry point. A misconfigured instance exits here, naming what is wrong, rather than starting and
 * failing later in a way that looks like a bug (FRM-REQ-006).
 */

const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write('foreman-server refused to start:\n');
      for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
      process.exit(1);
    }
    throw error;
  }
})();

await migrate(config);

const db = createDb(config.DATABASE_URL);

// Discovery is attempted once and allowed to fail. An unreachable D3 Auth means one login button
// instead of two — never a server that will not start (FRM-REQ-017, ADR-004).
const oidc = await createOidcClient(config);

const app = createApp({ config, db, oidc });

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      baseUrl: config.BASE_URL,
      oidcConfigured: config.oidcConfigured,
      oidcReachable: oidc !== null,
    },
    'foreman-server listening',
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void db.$disconnect().then(() => {
        process.exit(0);
      });
    });
  });
}
