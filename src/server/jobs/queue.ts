// Durable PostgreSQL job queue (FOR UPDATE SKIP LOCKED). Survives restarts; supports delayed runs,
// dedupe keys, bounded retries with backoff, stale-lock recovery and cancellation.
import os from 'node:os';
import type { Pool, Queryable } from '../db/pg.ts';
import { retryDelayMs } from '../domain/reminders.ts';

export interface Job { id: number; queue: string; payload: any; attempts: number; max_attempts: number; run_at: Date; dedupe_key: string | null }

export class JobQueue {
  private db: Pool; private now: () => Date;
  readonly workerId = `${os.hostname()}:${process.pid}`;
  /** Called after every enqueue so an idle in-process worker wakes immediately. */
  onEnqueue: (() => void) | null = null;
  constructor(db: Pool, now: () => Date) { this.db = db; this.now = now; }

  /** Enqueue a job. With a dedupe key, an existing active job is reused (returns its id). */
  async enqueue(queue: string, payload: unknown, o: { runAt?: Date; dedupeKey?: string; maxAttempts?: number; q?: Queryable } = {}): Promise<number> {
    const q = o.q ?? this.db;
    const r = await q.query<{ id: number }>(
      `INSERT INTO jobs(queue, payload, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         run_at = CASE WHEN jobs.status IN ('queued') THEN EXCLUDED.run_at ELSE jobs.run_at END,
         payload = CASE WHEN jobs.status IN ('queued') THEN EXCLUDED.payload ELSE jobs.payload END
       RETURNING id`,
      [queue, payload ?? {}, o.runAt ?? this.now(), o.dedupeKey ?? null, o.maxAttempts ?? 5],
    );
    this.onEnqueue?.();
    return r.rows[0].id;
  }

  async cancel(id: number, q: Queryable = this.db) {
    await q.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=$1 AND status='queued'`, [id]);
  }

  async claim(limit = 5, queues?: string[]): Promise<Job[]> {
    // Recover jobs whose worker died (locked for > 10 minutes).
    await this.db.query(`UPDATE jobs SET status='queued', locked_at=NULL, locked_by=NULL WHERE status='running' AND locked_at < $1`, [new Date(this.now().getTime() - 10 * 60_000)]);
    const r = await this.db.query<Job>(
      `UPDATE jobs SET status='running', locked_at=$1, locked_by=$2, attempts=attempts+1
       WHERE id IN (SELECT id FROM jobs WHERE status='queued' AND run_at <= $1 ${queues ? 'AND queue = ANY($4::text[])' : ''}
                    ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT $3)
       RETURNING id, queue, payload, attempts, max_attempts, run_at, dedupe_key`,
      queues ? [this.now(), this.workerId, limit, queues] : [this.now(), this.workerId, limit],
    );
    return r.rows;
  }

  async complete(id: number) {
    await this.db.query(`UPDATE jobs SET status='done', finished_at=now(), locked_at=NULL, last_error=NULL WHERE id=$1`, [id]);
  }

  /** Records a failure; retries with backoff until max_attempts, then marks dead. Returns the new status. */
  async fail(job: Job, err: Error, opts: { retryable?: boolean } = {}): Promise<'queued' | 'dead'> {
    const retry = (opts.retryable ?? true) && job.attempts < job.max_attempts;
    if (retry) {
      const at = new Date(this.now().getTime() + retryDelayMs(job.attempts));
      await this.db.query(`UPDATE jobs SET status='queued', run_at=$2, locked_at=NULL, locked_by=NULL, last_error=$3 WHERE id=$1`, [job.id, at, err.message.slice(0, 1000)]);
      return 'queued';
    }
    await this.db.query(`UPDATE jobs SET status='dead', finished_at=now(), locked_at=NULL, last_error=$2 WHERE id=$1`, [job.id, err.message.slice(0, 1000)]);
    return 'dead';
  }
}

/** Earliest time a queued job becomes due, or null when the queue is empty. */
export async function nextDueAt(db: Pool): Promise<Date | null> {
  const r = await db.query<{ t: Date | null }>(`SELECT min(run_at) AS t FROM jobs WHERE status='queued'`);
  return r.rows[0]?.t ?? null;
}
