// MOCKED integration test: free personal WhatsApp via CallMeBot (network simulated; not a live check).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness, type Client } from '../helpers/harness.ts';
import { PLACES } from '../helpers/mocks.ts';
import { CallMeBot } from '../../src/server/integrations/callmebot.ts';
import { setFetch } from '../../src/server/integrations/http.ts';

const sent: { phone: string; text: string; apikey: string }[] = [];
let h: Harness; let c: Client; let tripId: string;

before(async () => {
  setFetch((async (input: any) => {
    const u = new URL(String(input));
    if (u.hostname !== 'api.callmebot.com') return new Response('unexpected', { status: 599 });
    const apikey = u.searchParams.get('apikey')!;
    if (apikey === 'badkey') return new Response('<p>APIKey is invalid. You need to get a new one.</p>', { status: 200 });
    sent.push({ phone: u.searchParams.get('phone')!, text: u.searchParams.get('text')!, apikey });
    return new Response('<p>Message queued. You will receive it in a few seconds.</p>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }) as typeof fetch);
  h = await startHarness({}, (m) => ({ callmebot: new CallMeBot(true), messenger: Object.assign(m.messenger, { configured: () => false }) }));
  c = await signUp(h, 'wa@example.com');
  await c.put('/api/profile', { timeZone: 'Europe/Brussels', homePlace: PLACES.BRU });
  tripId = (await c.post('/api/trips', { title: 'Barcelona', origin: PLACES.BRU, startDate: '2027-03-10', endDate: '2027-03-13', stops: [{ place: PLACES.BCN, arriveDate: '2027-03-10', departDate: '2027-03-13' }] })).body.id;
  await c.post(`/api/trips/${tripId}/searches`, { kind: 'flight' }); await h.worker.drain();
  const rec = (await c.get(`/api/trips/${tripId}`)).body.offers.find((o: any) => o.role === 'recommended');
  await c.post(`/api/offers/${rec.id}/select`);
});
after(async () => { setFetch((...a) => fetch(...a)); await h.close(); });

test('connect own WhatsApp via CallMeBot: rejected key, code check, encrypted key', async () => {
  assert.equal((await c.get('/api/notifications/channel')).body.callmebotAvailable, true);
  const bad = await c.post('/api/notifications/callmebot', { phone: '+32470111222', apiKey: 'badkey' });
  assert.equal(bad.status, 502, JSON.stringify(bad.body));
  assert.equal((await c.post('/api/notifications/callmebot', { phone: '0470111222', apiKey: '123456' })).status, 400);
  assert.equal((await c.post('/api/notifications/callmebot', { phone: '+32470111222', apiKey: '987654' })).status, 200);
  const msg = sent.at(-1)!;
  assert.equal(msg.phone, '+32470111222');
  const code = /code is (\d{6})/.exec(msg.text)![1];
  const row = await h.ctx.db.query<any>('SELECT callmebot_key_enc FROM notification_channels');
  assert.ok(!row.rows[0].callmebot_key_enc.includes('987654'), 'key stored encrypted');
  assert.equal((await c.put('/api/notifications/consent', { optIn: true })).status, 400, 'cannot opt in before verifying');
  assert.equal((await c.post('/api/notifications/phone/verify', { code })).status, 200);
  const ch = (await c.put('/api/notifications/consent', { optIn: true, pretripTime: '18:00' })).body;
  assert.equal(ch.kind, 'callmebot'); assert.equal(ch.optedIn, true);
});

test('scheduled briefing goes to WhatsApp and is marked sent (no fake delivery receipt)', async () => {
  const before = sent.length;
  h.clock.now = new Date('2027-03-09T17:01:00Z');
  await h.worker.drain();
  const brief = sent.slice(before).find((m) => m.text.includes('starts tomorrow'));
  assert.ok(brief, 'briefing sent');
  assert.equal(brief!.apikey, '987654');
  assert.match(brief!.text, /SN3711/);
  assert.match(brief!.text, /Turn reminders off in Travel Compass/);
  assert.ok(!brief!.text.includes('/stop'));
  const n = (await c.get(`/api/trips/${tripId}/notifications`)).body.find((x: any) => x.kind === 'pretrip_briefing');
  assert.equal(n.status, 'sent');
  await c.put('/api/notifications/consent', { optIn: false });
  const after = (await c.get(`/api/trips/${tripId}/notifications`)).body;
  assert.ok(after.filter((x: any) => x.kind === 'daily_schedule').every((x: any) => x.status === 'cancelled'));
});
