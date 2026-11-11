// Background worker and scheduler. Runs in-process (RUN_WORKER_IN_PROCESS=true) or as a separate process.
import type { AppContext } from '../context.ts';
import { recordError } from '../context.ts';
import { log } from '../log.ts';
import { NotConfiguredError, ProviderError, QuotaExceededError } from '../integrations/http.ts';
import { AiBudgetExceeded } from '../integrations/ai.ts';
import { HttpError } from '../http/core.ts';
import { nextDueAt, type Job } from './queue.ts';
import { failSearch, runDestinationSearch, runFlexSearch, runFlightSearch, runStaySearch } from '../services/searches.ts';
import { runPlanJob } from '../services/planning.ts';
import { pollTelegram, sendNotificationJob, scheduleTripNotifications } from '../services/notifications.ts';
import { gmailSyncJob } from '../services/reservations.ts';

type JobHandler = (ctx: AppContext, payload: any, job: Job) => Promise<unknown>;

export const handlers: Record<string, JobHandler> = {
  'search.flight': (c, p) => runFlightSearch(c, p.searchId, p.userId, p.tripId),
  'search.stay': (c, p) => runStaySearch(c, p.searchId, p.userId, p.tripId),
  'search.flex': (c, p) => runFlexSearch(c, p.searchId, p.userId, p.tripId),
  'search.destinations': (c, p) => runDestinationSearch(c, p.searchId, p.userId, p.tripId),
  'plan.generate': (c, p) => runPlanJob(c, p),
  'notify.send': (c, p) => sendNotificationJob(c, p),
  'notify.reschedule': (c, p) => scheduleTripNotifications(c, p.userId, p.tripId),
  'gmail.sync': (c, p) => gmailSyncJob(c, p),
  'housekeeping': (c) => housekeeping(c),
};

function isRetryable(e: unknown) {
  if (e instanceof NotConfiguredError || e instanceof AiBudgetExceeded || e instanceof HttpError || e instanceof QuotaExceededError) return false;
  if (e instanceof ProviderError) return e.retryable;
  return true;
}

export async function processJob(ctx: AppContext, job: Job) {
  const h = handlers[job.queue];
  if (!h) { await ctx.jobs.fail(job, new Error(`No handler for ${job.queue}`), { retryable: false }); return; }
  try {
    await h(ctx, job.payload, job);
    await ctx.jobs.complete(job.id);
  } catch (e) {
    const status = await ctx.jobs.fail(job, e as Error, { retryable: isRetryable(e) });
    await recordError(ctx, `job.${job.queue}`, e, { jobId: job.id, attempt: job.attempts, final: status === 'dead' });
    if (status === 'dead') await onDead(ctx, job, e as Error);
  }
}

/** Terminal failure side-effects: never leave the customer looking at a perpetual spinner. */
async function onDead(ctx: AppContext, job: Job, e: Error) {
  const p = job.payload ?? {};
  if (job.queue.startsWith('search.') && p.searchId) await failSearch(ctx, p.searchId, e);
  if (job.queue === 'plan.generate' && p.tripId) {
    await ctx.db.query(`UPDATE trips SET plan_status=CASE WHEN EXISTS (SELECT 1 FROM itinerary_days WHERE trip_id=$1) THEN 'incomplete' ELSE 'failed' END,
      plan_message=$2 WHERE id=$1 AND plan_status='generating'`, [p.tripId, e instanceof NotConfiguredError ? 'Live planning is not available yet. Your saved trip is unchanged.' : e instanceof AiBudgetExceeded ? 'Daily planning limit reached. Your saved trip is unchanged; try again tomorrow.' : 'Planning services did not respond. Your saved trip is unchanged — please retry.']);
  }
}

export async function housekeeping(ctx: AppContext) {
  const r = ctx.cfg.retentionDays;
  await ctx.db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'`);
  await ctx.db.query(`DELETE FROM oauth_states WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM provider_cache WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 hours'`);
  await ctx.db.query(`DELETE FROM provider_usage WHERE created_at < now() - make_interval(days => $1)`, [r.providerUsage]);
  await ctx.db.query(`DELETE FROM error_events WHERE created_at < now() - make_interval(days => $1)`, [r.errorEvents]);
  await ctx.db.query(`DELETE FROM jobs WHERE status IN ('done','cancelled') AND finished_at < now() - make_interval(days => $1)`, [r.jobs]);
  await ctx.db.query(`DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`);
  // Traveller details are only needed until handoff; purge them afterwards.
  await ctx.db.query(`UPDATE booking_sessions SET traveller_details_enc=NULL WHERE traveller_details_enc IS NOT NULL AND (state IN ('handed_off','completed','cancelled','expired','failed') OR updated_at < now() - interval '2 days')`);
  await ctx.db.query(`UPDATE booking_sessions SET state='expired', error='Price check expired.' WHERE state IN ('selected','repriced','details_collected','price_changed','ready_for_handoff') AND updated_at < now() - interval '1 day'`);
  // Plans stuck in "generating" without a live job (e.g. after a crash) become retryable.
  await ctx.db.query(`UPDATE trips t SET plan_status=CASE WHEN EXISTS (SELECT 1 FROM itinerary_days WHERE trip_id=t.id) THEN 'incomplete' ELSE 'failed' END, plan_message='Planning was interrupted. Your saved trip is unchanged — please retry.'
    WHERE plan_status='generating' AND updated_at < now() - interval '30 minutes' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.queue='plan.generate' AND j.status IN ('queued','running') AND j.payload->>'tripId' = t.id::text)`);
  await ctx.db.query(`UPDATE trips SET status='completed' WHERE status IN ('planned','booked') AND end_date < (now() - interval '1 day')::date`);
}

export class Worker {
  private ctx: AppContext; private running = false; private timer?: NodeJS.Timeout; private active = 0; private lastPoll = 0; private lastHousekeeping = '';
  private tickFn: (() => Promise<void>) | null = null;
  private concurrency: number;
  constructor(ctx: AppContext, concurrency = 4) { this.ctx = ctx; this.concurrency = concurrency; }
  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        // Scheduler: one housekeeping job per hour across all instances (dedupe key).
        const hour = this.ctx.now().toISOString().slice(0, 13);
        if (hour !== this.lastHousekeeping) {
          await this.ctx.jobs.enqueue('housekeeping', {}, { dedupeKey: `housekeeping:${hour}`, maxAttempts: 2 });
          this.lastHousekeeping = hour;
        }
        if (this.ctx.cfg.telegram.mode === 'polling' && this.ctx.providers.telegram?.configured() && Date.now() - this.lastPoll > 3000) {
          this.lastPoll = Date.now();
          await pollTelegram(this.ctx).catch((e) => log.warn('telegram poll failed', { error: (e as Error).message }));
        }
        const free = this.concurrency - this.active;
        let claimed = 0;
        if (free > 0) {
          const jobs = await this.ctx.jobs.claim(free);
          claimed = jobs.length;
          for (const j of jobs) { this.active++; processJob(this.ctx, j).finally(() => { this.active--; this.nudge(); }); }
        }
        delay = await this.idleDelay(claimed);
      } catch (e) { log.error('worker tick failed', { error: (e as Error).message }); delay = 5000; }
      if (this.running) this.timer = setTimeout(tick, delay);
    };
    let delay = 1000;
    this.tickFn = tick;
    // Wake straight away when this process enqueues work (web requests in the same process).
    this.ctx.jobs.onEnqueue = () => this.nudge();
    void tick();
    log.info('worker started', { id: this.ctx.jobs.workerId });
  }
  /**
   * How long to wait before the next check. By default every second. With WORKER_IDLE_MAX_SECONDS set (e.g. on
   * free hosting with a scale-to-zero database), an idle worker sleeps until the next job is due, so the database
   * is not kept awake by polling.
   */
  private async idleDelay(claimed: number): Promise<number> {
    const max = this.ctx.cfg.workerIdleMaxSeconds * 1000;
    if (max <= 1000 || claimed > 0 || this.active > 0) return 1000;
    if (this.ctx.cfg.telegram.mode === 'polling' && this.ctx.providers.telegram?.configured()) return 3000;
    const next = await nextDueAt(this.ctx.db);
    const nextHour = new Date(this.ctx.now()); nextHour.setUTCMinutes(60, 0, 0);
    const until = Math.min(next ? next.getTime() : Infinity, nextHour.getTime()) - this.ctx.now().getTime();
    return Math.max(1000, Math.min(max, until + 500));
  }

  /** Re-check soon (used when work is enqueued or a job finishes). */
  nudge() {
    if (!this.running || !this.tickFn) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.tickFn, 200);
  }

  async stop() {
    this.running = false;
    this.ctx.jobs.onEnqueue = null;
    if (this.timer) clearTimeout(this.timer);
    const deadline = Date.now() + 15000;
    while (this.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }
  /** Test helper: process due jobs until the queue is drained. */
  async drain(maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const jobs = await this.ctx.jobs.claim(10);
      if (!jobs.length) return;
      for (const j of jobs) await processJob(this.ctx, j);
    }
  }
}
