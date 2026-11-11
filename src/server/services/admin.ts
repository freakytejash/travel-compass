// Administrator views: integration readiness, usage/cost, notification failures, errors, health. No secrets are returned.
import type { AppContext } from '../context.ts';
import { integrationReadiness } from '../config.ts';

export async function readiness(ctx: AppContext) {
  const list = integrationReadiness(ctx.cfg);
  const lastOk = await ctx.db.query<any>(`SELECT provider, max(created_at) FILTER (WHERE status='ok') AS last_ok, max(created_at) FILTER (WHERE status='error') AS last_error,
      count(*) FILTER (WHERE status='error' AND created_at > now() - interval '24 hours')::int AS errors_24h, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS calls_24h
    FROM provider_usage GROUP BY provider`);
  const byProv = new Map(lastOk.rows.map((r) => [r.provider, r]));
  const providerKey: Record<string, string> = { duffel_flights: 'duffel', duffel_stays: 'duffel', duffel_links: 'duffel', booking_com: 'booking_com', google_places: 'google_places', google_routes: 'google_routes', weather: 'open_meteo', ai: 'anthropic', research: 'brave_search', gmail: 'gmail', whatsapp: 'whatsapp', email: 'resend', google_login: 'google_oauth', serpapi: 'serpapi', osm: 'overpass', wikimedia: 'wikimedia', ai_compat: 'openai_compatible', geo_free: 'photon', telegram: 'telegram' };
  return list.map((i) => {
    const u = byProv.get(providerKey[i.key] ?? i.key);
    // "verified_live" requires at least one successful live call recorded by this deployment.
    return { ...i, verifiedLive: !!u?.last_ok, lastSuccessAt: u?.last_ok ?? null, lastErrorAt: u?.last_error ?? null, calls24h: u?.calls_24h ?? 0, errors24h: u?.errors_24h ?? 0 };
  });
}

export async function usage(ctx: AppContext, days = 7) {
  const since = new Date(ctx.now().getTime() - days * 86400000);
  const r = await ctx.db.query<any>(`SELECT date_trunc('day', created_at) AS day, provider, count(*)::int AS calls, count(*) FILTER (WHERE status='error')::int AS errors,
      COALESCE(sum(tokens_in),0)::int AS tokens_in, COALESCE(sum(tokens_out),0)::int AS tokens_out, COALESCE(sum(cost_estimate_usd),0)::float AS cost_usd, COALESCE(avg(latency_ms) FILTER (WHERE latency_ms>0),0)::int AS avg_latency_ms
    FROM provider_usage WHERE created_at >= $1 GROUP BY 1,2 ORDER BY 1 DESC, 2`, [since]);
  const today = await ctx.db.query<any>(`SELECT COALESCE(sum(cost_estimate_usd),0)::float AS cost FROM provider_usage WHERE provider IN ('anthropic','ai') AND created_at >= date_trunc('day', now())`);
  const serp = await ctx.db.query<any>(`SELECT count(*)::int AS n FROM provider_usage WHERE provider='serpapi' AND status='ok' AND created_at >= date_trunc('month', now())`);
  return { rows: r.rows, aiCostTodayUsd: today.rows[0].cost, aiDailyBudgetUsd: ctx.cfg.anthropic.dailyBudgetUsd, serpapiUsedThisMonth: serp.rows[0].n, serpapiMonthlyLimit: ctx.cfg.serpapi.monthlyLimit };
}

export async function notificationFailures(ctx: AppContext) {
  const r = await ctx.db.query<any>(`SELECT n.id, n.kind, n.status, n.attempts, n.last_error, n.scheduled_for, n.updated_at, u.email FROM notifications n JOIN users u ON u.id=n.user_id
    WHERE n.status='failed' OR (n.status='scheduled' AND n.scheduled_for < now() - interval '15 minutes') ORDER BY n.updated_at DESC LIMIT 100`);
  const jobs = await ctx.db.query<any>(`SELECT id, queue, attempts, last_error, finished_at FROM jobs WHERE status='dead' ORDER BY finished_at DESC LIMIT 50`);
  return { notifications: r.rows.map((x) => ({ ...x, email: x.email.replace(/^(.).*(@.*)$/, '$1***$2') })), deadJobs: jobs.rows };
}

export async function errors(ctx: AppContext) {
  const r = await ctx.db.query<any>('SELECT id, source, message, created_at FROM error_events ORDER BY created_at DESC LIMIT 100');
  return r.rows;
}

export async function health(ctx: AppContext) {
  const started = Date.now();
  let db = false;
  try { await ctx.db.query('SELECT 1'); db = true; } catch { /* reported below */ }
  const q = db ? (await ctx.db.query<any>(`SELECT count(*) FILTER (WHERE status='queued' AND run_at < now() - interval '5 minutes')::int AS overdue, count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='dead' AND finished_at > now() - interval '24 hours')::int AS dead24h FROM jobs`)).rows[0] : null;
  return { ok: db && (q?.overdue ?? 0) < 50, database: db, dbLatencyMs: Date.now() - started, jobs: q };
}

export async function stats(ctx: AppContext) {
  const r = await ctx.db.query<any>(`SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM trips) AS trips, (SELECT count(*)::int FROM trips WHERE plan_status='complete') AS complete_plans,
    (SELECT count(*)::int FROM notifications WHERE status IN ('delivered','read')) AS delivered_notifications, (SELECT count(*)::int FROM booking_sessions WHERE state='completed') AS completed_bookings`);
  return r.rows[0];
}
