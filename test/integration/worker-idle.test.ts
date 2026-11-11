// The idle worker sleeps until the next job is due, so a scale-to-zero database (e.g. Neon free) can pause.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness.ts';

let h: Harness;
after(async () => { await h.close(); });

test('idle delay follows the next due job, capped by WORKER_IDLE_MAX_SECONDS', async () => {
  h = await startHarness({ WORKER_IDLE_MAX_SECONDS: '1800' });
  const w = h.worker as any;
  assert.equal(await w.idleDelay(0), 1800 * 1000, 'empty queue: sleep the maximum (next hour is 60 min away)');
  await h.ctx.jobs.enqueue('housekeeping', {}, { runAt: new Date(h.clock.now.getTime() + 10 * 60_000) });
  assert.equal(await w.idleDelay(0), 10 * 60_000 + 500, 'wakes just after the job is due');
  assert.equal(await w.idleDelay(1), 1000, 'busy: keep checking every second');
  h.ctx.cfg.workerIdleMaxSeconds = 1;
  assert.equal(await w.idleDelay(0), 1000, 'default behaviour unchanged');
});
