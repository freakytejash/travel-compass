// Standalone worker process (set RUN_WORKER_IN_PROCESS=false on web instances when using this).
import { loadConfig } from '../config.ts';
import { Pool, parseDatabaseUrl } from '../db/pg.ts';
import { buildProviders } from '../integrations/index.ts';
import { aiBudget, monthlyQuota } from '../http/guards.ts';
import { makeContext } from '../context.ts';
import { Worker } from './worker.ts';
import { log } from '../log.ts';

const cfg = loadConfig();
if (!cfg.databaseUrl) { log.error('DATABASE_URL is required'); process.exit(1); }
const db = new Pool(parseDatabaseUrl(cfg.databaseUrl), Math.max(4, Math.floor(cfg.dbPoolSize / 2)));
const ctx = makeContext(cfg, db, buildProviders(cfg, aiBudget(db, cfg), monthlyQuota(db, cfg)));
const worker = new Worker(ctx, Number(process.env.WORKER_CONCURRENCY ?? 4));
worker.start();
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, async () => { await worker.stop(); await db.end(); process.exit(0); });
