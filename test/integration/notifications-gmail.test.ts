// MOCKED integration tests for WhatsApp reminders and Gmail import. Google and Meta APIs are simulated.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness, type Client } from '../helpers/harness.ts';
import { PLACES } from '../helpers/mocks.ts';
import { setFetch } from '../../src/server/integrations/http.ts';

let h: Harness; let c: Client; let tripId: string;
before(async () => {
  h = await startHarness();
  c = await signUp(h, 'remind@example.com');
  await c.put('/api/profile', { diet: 'vegetarian', timeZone: 'Europe/Brussels', homePlace: PLACES.BRU, checkedBag: false, prepMinutes: 40 });
  tripId = (await c.post('/api/trips', { title: 'Barcelona', origin: PLACES.BRU, startDate: '2027-03-10', endDate: '2027-03-13', stops: [{ place: PLACES.BCN, arriveDate: '2027-03-10', departDate: '2027-03-13' }] })).body.id;
  await c.post(`/api/trips/${tripId}/searches`, { kind: 'flight' }); await h.worker.drain();
  const rec = (await c.get(`/api/trips/${tripId}`)).body.offers.find((o: any) => o.role === 'recommended');
  await c.post(`/api/offers/${rec.id}/select`);
  await c.post(`/api/trips/${tripId}/plan`, {}); await h.worker.drain();
});
after(async () => { await h.close(); });

test('WhatsApp opt-in requires phone verification', async () => {
  assert.equal((await c.put('/api/notifications/consent', { optIn: true })).status, 400);
  assert.equal((await c.post('/api/notifications/phone', { phone: '0470123456' })).status, 400, 'E.164 required');
  assert.equal((await c.post('/api/notifications/phone', { phone: '+32470123456' })).status, 200);
  await h.worker.drain();
  const msg = h.mocks.messenger.sent.at(-1)!;
  assert.equal(msg.template, 'tc_verification_code');
  const raw = await h.ctx.db.query<any>(`SELECT payload FROM jobs WHERE queue='notify.send' ORDER BY id DESC LIMIT 1`);
  assert.ok(!JSON.stringify(raw.rows[0].payload).includes(msg.params[0]), 'code is not stored in clear text');
  assert.equal((await c.post('/api/notifications/phone/verify', { code: '000000' === msg.params[0] ? '111111' : '000000' })).status, 400);
  assert.equal((await c.post('/api/notifications/phone/verify', { code: msg.params[0] })).status, 200);
  const ch = (await c.put('/api/notifications/consent', { optIn: true, dailyTime: '07:30', pretripTime: '18:00', shareBookingRefs: false })).body;
  assert.equal(ch.optedIn, true);
});

test('scheduled notifications have persistent jobs, time-zone-aware times, and no duplicates', async () => {
  const list = (await c.get(`/api/trips/${tripId}/notifications`)).body;
  const pre = list.find((n: any) => n.kind === 'pretrip_briefing');
  assert.ok(pre && pre.hasJob, 'pre-trip briefing has a persistent job');
  assert.equal(new Date(pre.scheduledFor).toISOString(), '2027-03-09T17:00:00.000Z', '18:00 Brussels the day before');
  const daily = list.filter((n: any) => n.kind === 'daily_schedule');
  assert.equal(daily.length, 4);
  assert.equal(new Date(daily[1].scheduledFor).toISOString(), '2027-03-11T06:30:00.000Z', '07:30 Madrid');
  const jobs = await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM jobs WHERE queue='notify.send' AND status='queued'`);
  assert.equal(jobs.rows[0].n, 5);
  // Rescheduling is idempotent.
  await c.put('/api/notifications/consent', { optIn: true });
  assert.equal((await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM jobs WHERE queue='notify.send' AND status='queued'`)).rows[0].n, 5);
  assert.equal((await h.ctx.db.query<any>(`SELECT count(*)::int AS n FROM notifications WHERE trip_id=$1`, [tripId])).rows[0].n, 5);
});

test('pre-trip briefing content, retry on failure, delivery callbacks with signature checks', async () => {
  const sentBefore = h.mocks.messenger.sent.length;
  h.mocks.messenger.failNext = 1;
  h.clock.now = new Date('2027-03-09T17:00:30Z');
  await h.worker.drain();
  let n = (await c.get(`/api/trips/${tripId}/notifications`)).body.find((x: any) => x.kind === 'pretrip_briefing');
  assert.equal(n.status, 'scheduled', 'temporary failure is retried, not lost');
  assert.equal(n.attempts, 1);
  h.clock.now = new Date('2027-03-09T18:00:00Z');
  await h.worker.drain();
  n = (await c.get(`/api/trips/${tripId}/notifications`)).body.find((x: any) => x.kind === 'pretrip_briefing');
  assert.equal(n.status, 'sent');
  const msgs = h.mocks.messenger.sent.slice(sentBefore);
  assert.equal(msgs.length, 1, 'exactly one message sent');
  const p = msgs[0].params;
  assert.match(p[2], /SN3711/);
  assert.match(p[3], /NOT confirmed/, 'check-in not assumed from a booking');
  assert.match(p[4], /^\d{2}:\d{2}$/); assert.match(p[5], /^\d{2}:\d{2}$/);
  assert.match(p[6], /planning assumption/);
  assert.ok(Number(/^(\d+) min/.exec(p[6])![1]) >= 25, `transfer measured to the airport, not the city centre: ${p[6]}`);
  assert.ok(p.every((x: string) => !/[\n\t]/.test(x)), 'template params are single-line');
  assert.ok(!p.join(' ').includes('Ref '), 'booking references withheld without consent');
  // Re-running the job cannot send again.
  const row = await h.ctx.db.query<any>(`SELECT id FROM notifications WHERE trip_id=$1 AND kind='pretrip_briefing'`, [tripId]);
  await h.ctx.jobs.enqueue('notify.send', { notificationId: row.rows[0].id, userId: 'x' });
  await h.worker.drain();
  assert.equal(h.mocks.messenger.sent.length, sentBefore + 1);
  // Delivery callbacks
  const wamid = msgs[0].id;
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'delivered', timestamp: '1804100000' }] } }] }] });
  const bad = await fetch(h.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' }, body: payload });
  assert.equal(bad.status, 401);
  const ok = await fetch(h.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': h.mocks.messenger.sign(payload) }, body: payload });
  assert.equal(ok.status, 200);
  const dup = await (await fetch(h.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': h.mocks.messenger.sign(payload) }, body: payload })).json();
  assert.equal(dup.updated, 0, 'duplicate callback ignored');
  const older = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status: 'sent', timestamp: '1804099990' }] } }] }] });
  await fetch(h.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': h.mocks.messenger.sign(older) }, body: older });
  n = (await c.get(`/api/trips/${tripId}/notifications`)).body.find((x: any) => x.kind === 'pretrip_briefing');
  assert.equal(n.status, 'delivered', 'out-of-order callback does not regress status');
  // Verification handshake
  const hs = await fetch(h.base + '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42');
  assert.equal(await hs.text(), '42');
});

test('STOP reply opts out and cancels pending jobs', async () => {
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '32470123456', id: 'in1', text: { body: 'STOP' } }] } }] }] });
  await fetch(h.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': h.mocks.messenger.sign(payload) }, body: payload });
  const list = (await c.get(`/api/trips/${tripId}/notifications`)).body;
  assert.ok(list.filter((x: any) => x.kind === 'daily_schedule').every((x: any) => x.status === 'cancelled'));
  assert.equal((await c.get('/api/notifications/channel')).body.optedIn, false);
  const before = h.mocks.messenger.sent.length;
  h.clock.now = new Date('2027-03-12T08:00:00Z');
  await h.worker.drain();
  assert.equal(h.mocks.messenger.sent.length, before, 'nothing sent after opt-out');
});

test('Gmail import: OAuth, extraction, dedupe, review, disconnect + revoke', async () => {
  const calls: string[] = [];
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const msgs: Record<string, any> = {
    m1: { id: 'm1', internalDate: '1798000000000', payload: { headers: [{ name: 'From', value: 'Booking.com <noreply@booking.com>' }, { name: 'Subject', value: 'Your booking at Hotel Arts is confirmed' }], mimeType: 'text/plain', body: { data: b64('Confirmation number: 4021133398\nCheck-in: Wed 10 Mar 2027\nCheck-out: Sat 13 Mar 2027') } } },
    m2: { id: 'm2', internalDate: '1798000001000', payload: { headers: [{ name: 'From', value: 'Booking.com <noreply@booking.com>' }, { name: 'Subject', value: 'Reminder: Hotel Arts' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Your booking at Hotel Arts</p><p>Confirmation number: 4021133398</p><p>Check-in: 10 March 2027</p>') } }] } },
    m3: { id: 'm3', internalDate: '1798000002000', payload: { headers: [{ name: 'From', value: 'deals@shop.example' }, { name: 'Subject', value: '70% off sale ends today' }], mimeType: 'text/plain', body: { data: b64('buy') } } },
  };
  setFetch((async (input: any, init?: any) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    if (url.includes('/users/me/profile')) return json({ emailAddress: 'remind@gmail.example' });
    if (url.includes('/users/me/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
    const m = /messages\/(m\d)/.exec(url); if (m) return json(msgs[m[1]]);
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
  const start = (await c.post('/api/gmail/connect')).body.url as string;
  const u = new URL(start);
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly', 'least-privilege read-only scope');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const cb = await c.get(`/api/oauth/google/callback?code=abc&state=${encodeURIComponent(u.searchParams.get('state')!)}`);
  assert.equal(cb.status, 302);
  const stored = await h.ctx.db.query<any>('SELECT access_token_enc, refresh_token_enc FROM oauth_connections');
  assert.ok(!stored.rows[0].access_token_enc.includes('at-1') && !stored.rows[0].refresh_token_enc.includes('rt-1'), 'tokens encrypted');
  await h.worker.drain();
  let res = (await c.get('/api/reservations')).body.filter((r: any) => r.source === 'gmail');
  assert.equal(res.length, 1, 'two emails for one booking deduplicated; marketing ignored');
  assert.equal(res[0].confirmationCode, '4021133398');
  assert.equal(res[0].tripId, tripId, 'associated to the trip by date');
  assert.equal(res[0].reviewStatus, 'needs_review');
  assert.ok(res[0].extractionConfidence > 0.5);
  assert.equal(res[0].sourceRef, 'm1');
  // Second sync does not duplicate.
  await c.post('/api/gmail/sync'); h.clock.now = new Date(h.clock.now.getTime() + 120_000); await c.post('/api/gmail/sync'); await h.worker.drain();
  assert.equal((await c.get('/api/reservations')).body.filter((r: any) => r.source === 'gmail').length, 1);
  // Customer correction
  const fixed = (await c.patch(`/api/reservations/${res[0].id}`, { providerName: 'Hotel Arts Barcelona', reviewStatus: 'confirmed' })).body;
  assert.equal(fixed.reviewStatus, 'confirmed');
  // Another customer cannot trigger the callback into this account.
  const other = await signUp(h, 'other@example.com');
  const st2 = new URL((await other.post('/api/gmail/connect')).body.url).searchParams.get('state')!;
  const hijack = await c.get(`/api/oauth/google/callback?code=x&state=${encodeURIComponent(st2)}`);
  assert.match(hijack.headers.get('location') ?? '', /session_mismatch/);
  // Disconnect revokes and deletes tokens.
  const d = (await c.post('/api/gmail/disconnect', { deleteImported: false })).body;
  assert.deepEqual(d, { disconnected: true, revoked: true });
  assert.ok(calls.some((x) => x.startsWith('POST https://oauth2.googleapis.com/revoke')));
  assert.equal((await h.ctx.db.query('SELECT count(*)::int AS n FROM oauth_connections WHERE user_id=(SELECT id FROM users WHERE email=$1)', ['remind@example.com'])).rows[0].n, 0);
  res = (await c.get('/api/reservations')).body;
  assert.equal(res.length >= 1, true, 'imported records kept when the customer chooses');
  setFetch((...a) => fetch(...a));
});

test('admin readiness separates configured from verified-live', async () => {
  const a = await signUp(h, 'admin@example.com');
  const r = (await a.get('/api/admin/readiness')).body;
  const duffel = r.find((x: any) => x.key === 'duffel_flights');
  assert.equal(duffel.status, 'awaiting_credentials');
  assert.equal(duffel.verifiedLive, false);
  assert.ok(r.find((x: any) => x.key === 'gmail').approvals.some((s: string) => /CASA/.test(s)));
  assert.equal((await a.get('/api/admin/health')).body.database, true);
});
