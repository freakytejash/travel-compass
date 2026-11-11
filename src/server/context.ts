import type { Config } from './config.ts';
import type { Pool } from './db/pg.ts';
import type { Providers } from './integrations/types.ts';
import { Sealer } from './secrets.ts';
import { JobQueue } from './jobs/queue.ts';
import { setUsageSink } from './integrations/http.ts';
import { log } from './log.ts';

export interface AppContext {
  cfg: Config;
  db: Pool;
  providers: Providers;
  sealer: Sealer | null;
  jobs: JobQueue;
  now: () => Date;
}

export function requireSealer(ctx: AppContext): Sealer {
  if (!ctx.sealer) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  return ctx.sealer;
}

export function makeContext(cfg: Config, db: Pool, providers: Providers, now: () => Date = () => new Date()): AppContext {
  const sealer = cfg.tokenEncryptionKey ? new Sealer(cfg.tokenEncryptionKey) : null;
  const ctx: AppContext = { cfg, db, providers, sealer, jobs: new JobQueue(db, now), now };
  setUsageSink((e) => {
    db.query('INSERT INTO provider_usage(provider, operation, user_id, status, http_status, latency_ms, tokens_in, tokens_out, cost_estimate_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.provider, e.operation, e.userId ?? null, e.status, e.httpStatus, e.latencyMs, e.tokensIn ?? null, e.tokensOut ?? null, e.costUsd ?? 0]).catch(() => {});
  });
  return ctx;
}

export async function recordError(ctx: AppContext, source: string, e: unknown, context: Record<string, unknown> = {}) {
  const message = (e as Error)?.message ?? String(e);
  log.error(source, { error: message, ...context });
  try { await ctx.db.query('INSERT INTO error_events(source, message, context) VALUES ($1,$2,$3)', [source, message.slice(0, 1000), log.redact(context)]); } catch { /* ignore */ }
}
