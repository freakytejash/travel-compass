// Rate limiting (shared across instances via PostgreSQL) and AI spending controls.
import type { Pool } from '../db/pg.ts';
import type { Config } from '../config.ts';
import { HttpError } from './core.ts';
import { QuotaExceededError } from '../integrations/http.ts';

export async function rateLimit(db: Pool, key: string, limit: number, windowSec: number, now = new Date()) {
  const windowStart = new Date(Math.floor(now.getTime() / (windowSec * 1000)) * windowSec * 1000);
  const r = await db.query<{ count: number }>(
    `INSERT INTO rate_limits(key, window_start, count) VALUES ($1,$2,1) ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1 RETURNING count`, [key, windowStart]);
  if (r.rows[0].count > limit) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.', { retryable: true, details: { retryAfterSec: Math.ceil((windowStart.getTime() + windowSec * 1000 - now.getTime()) / 1000) } });
  }
}

export function aiBudget(db: Pool, cfg: Config) {
  return async (userId: string | null | undefined) => {
    const g = await db.query<{ c: number }>(`SELECT COALESCE(sum(cost_estimate_usd),0)::float AS c FROM provider_usage WHERE provider IN ('anthropic','ai') AND created_at >= date_trunc('day', now())`);
    if (g.rows[0].c >= cfg.anthropic.dailyBudgetUsd) return { allowed: false, reason: 'Global daily AI budget reached' };
    if (userId) {
      const u = await db.query<{ c: number }>(`SELECT COALESCE(sum(cost_estimate_usd),0)::float AS c FROM provider_usage WHERE provider IN ('anthropic','ai') AND user_id=$1 AND created_at >= date_trunc('day', now())`, [userId]);
      if (u.rows[0].c >= cfg.anthropic.perUserDailyBudgetUsd) return { allowed: false, reason: 'Per-customer daily AI budget reached' };
    }
    return { allowed: true };
  };
}

/** Monthly allowance guard for free-plan providers (counts successful calls recorded in provider_usage). */
export function monthlyQuota(db: Pool, cfg: Config) {
  return async (provider: string) => {
    const limit = provider === 'serpapi' ? cfg.serpapi.monthlyLimit : Infinity;
    if (!Number.isFinite(limit)) return;
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider_usage WHERE provider=$1 AND status='ok' AND created_at >= date_trunc('month', now())`, [provider]);
    if (r.rows[0].n >= limit) throw new QuotaExceededError(provider, `The free monthly search allowance (${limit}) is used up. It resets on the 1st; saved trips and plans still work.`);
  };
}
