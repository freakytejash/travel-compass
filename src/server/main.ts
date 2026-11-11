import http from 'node:http';
import { loadConfig } from './config.ts';
import { Pool, parseDatabaseUrl } from './db/pg.ts';
import { migrate } from './db/migrate.ts';
import { buildProviders } from './integrations/index.ts';
import { aiBudget, monthlyQuota } from './http/guards.ts';
import { makeContext } from './context.ts';
import { createApp } from './app.ts';
import { Worker } from './jobs/worker.ts';
import { log } from './log.ts';

const cfg = loadConfig();
if (!cfg.databaseUrl) { log.error('DATABASE_URL is required'); process.exit(1); }
if (cfg.isProd && !cfg.tokenEncryptionKey) { log.error('TOKEN_ENCRYPTION_KEY is required in production'); process.exit(1); }
if (cfg.isProd && !cfg.appUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.appUrl)) { log.error('APP_URL must be https in production'); process.exit(1); }

const db = new Pool(parseDatabaseUrl(cfg.databaseUrl), cfg.dbPoolSize);
if (process.env.MIGRATE_ON_START !== 'false') await migrate(db, (m) => log.info(m));
const ctx = makeContext(cfg, db, buildProviders(cfg, aiBudget(db, cfg), monthlyQuota(db, cfg)));
const server = http.createServer(createApp(ctx));
server.headersTimeout = 30000; server.requestTimeout = 60000;
const worker = cfg.runWorkerInProcess ? new Worker(ctx) : null;
worker?.start();
server.listen(cfg.port, () => log.info('Travel Compass listening', { port: cfg.port, env: cfg.env }));

async function shutdown(sig: string) {
  log.info('shutting down', { sig });
  server.close();
  await worker?.stop();
  await db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
