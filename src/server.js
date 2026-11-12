import { createApp } from './app.js';
import { config } from './config/index.js';
import { db } from './db/knex.js';
import { logger } from './core/logger.js';
import { storage } from './core/storage/index.js';
import { verifyMailer } from './core/mailer.js';

// Fail fast if file storage is misconfigured (wrong bucket / region / credentials), rather than
// failing on the first upload. S3_CREATE_BUCKET=true creates the bucket (local MinIO convenience).
try {
  await storage.check({ create: config.storage.driver === 's3' && config.storage.s3.createBucket });
  logger.info(`File storage: ${storage.name}${storage.name === 's3' ? ` (bucket ${config.storage.s3.bucket}${config.storage.s3.endpoint ? ` @ ${config.storage.s3.endpoint}` : `, ${config.storage.s3.region}`})` : ''}`);
} catch (err) {
  logger.fatal({ err }, 'File storage is not reachable — check the S3_* settings');
  process.exit(1);
}

// Email is optional: a bad SMTP login is logged, invites then fall back to a shareable link.
verifyMailer();

const app = createApp();
const server = app.listen(config.port, () => logger.info(`API listening on http://localhost:${config.port} (${config.env})`));

/** Graceful shutdown: stop accepting connections, finish in-flight requests, close the DB pool. */
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
