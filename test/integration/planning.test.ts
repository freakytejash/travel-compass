// MOCKED integration tests: search → rank → plan → book handoff, with outages. No live provider is contacted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness, type Client } from '../helpers/harness.ts';
import { PLACES } from '../helpers/mocks.ts';
import { PLACEHOLDER_PATTERNS } from '../../src/server/domain/planQuality.ts';

let h: Harness; let c: Client; let tripId: string;
before(async () => {
  h = await startHarness();
  c = await signUp(h, 'traveller@example.com');
  await c.put('/api/profile', { diet: 'vegetarian', pace: 'moderate', interests: ['food', 'architecture'], hikingExperience: 'intermediate', hikingDifficulty: 'moderate', timeZone: 'Europe/Brussels', currency: 'EUR', homePlace: PLACES.BRU, checkedBag: true });
  tripId = (await c.post('/api/trips', { title: 'Iberia', origin: PLACES.BRU, adults: 2, flexDays: 2, startDate: '2027-03-10', endDate: '2027-03-16',
    stops: [{ place: PLACES.BCN, arriveDate: '2027-03-10', departDate: '2027-03-13' }, { place: PLACES.LIS, arriveDate: '2027-03-13', departDate: '2027-03-16' }] })).body.id;
});
after(async () => { await h.close(); });

async function search(kind: string) {
  const r = await c.post(`/api/trips/${tripId}/searches`, { kind });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Drain, letting any retry backoff elapse on the test clock.
  for (let i = 0; i < 4; i++) { await h.worker.drain(); h.clock.now = new Date(h.clock.now.getTime() + 3600_000); }
  return (await c.get(`/api/searches/${r.body.searchId}`)).body;
}

test('flight search returns ranked real offers with explanations', async () => {
  const s = await search('flight');
  assert.equal(s.status, 'complete', JSON.stringify(s));
  const roles = Object.fromEntries(s.offers.filter((o: any) => o.role).map((o: any) => [o.role, o]));
  assert.ok(roles.recommended && roles.cheapest);
  assert.match(roles.cheapest.explanation, /Lowest price among the \d+ offers retrieved/);
  assert.equal(roles.recommended.data.offer.slices[0].segments[0].flightNumber, 'SN3711');
  assert.ok(roles.recommended.data.offer.baggage.checkedBags >= 1, 'checked bag preference favours fares with bags');
  assert.ok(s.result.notes.some((n: string) => n.includes('planning estimates')));
  assert.ok(s.result.notes.some((n: string) => n.includes('between your destinations')));
  // Open-jaw: outbound to BCN, return from LIS
  const call = h.mocks.flights.calls.at(-1)!;
  assert.equal(call.slices[0].destination, 'BCN'); assert.equal(call.slices[1].origin, 'LIS');
});

test('multi-destination accommodation covers every night without gaps or overlaps', async () => {
  const s = await search('stay');
  assert.equal(s.status, 'complete', JSON.stringify(s.result));
  assert.equal(s.result.requiredNights, 6);
  assert.equal(s.result.coverage.ok, true);
  assert.equal(s.result.perStop.length, 2);
  for (const p of s.result.perStop) {
    assert.ok(p.externalOptions[0].note.includes('no Airbnb listings or prices'));
    const rec = s.offers.find((o: any) => o.stopId === p.stopId && o.role === 'recommended');
    assert.ok(rec, 'recommended stay per stop');
    assert.notEqual(rec.data.stay.roomKind, 'dorm', 'private-room preference respected');
    assert.equal(rec.data.stay.checkIn, p.checkIn); assert.equal(rec.data.stay.checkOut, p.checkOut);
  }
});

test('flexible dates compare complete trip cost with independent shifts', async () => {
  const s = await search('flex');
  assert.ok(['complete', 'partial'].includes(s.status), JSON.stringify(s));
  const combos = s.result.combos;
  assert.ok(combos.some((x: any) => x.combo.outShift !== x.combo.inShift), 'independent outbound/return shifts were evaluated');
  assert.ok(s.result.recommendation, 'a recommendation based on complete cost');
  assert.ok(s.result.recommendation.lines.some((l: any) => l.label.startsWith('Accommodation')));
  assert.ok(s.result.original);
  assert.equal(typeof s.result.coverage.checked, 'number');
  // Multi-stop: only first/last stays change; the middle boundary stays fixed.
  const calls = h.mocks.stays[0].calls;
  assert.ok(calls.some((x) => x.checkIn === '2027-03-13'), 'second stop kept its fixed start');
});

test('plan generation produces named, sourced vegetarian recommendations — no placeholders', async () => {
  // Select the recommended flight so arrival/departure use real times.
  const flights = await c.get(`/api/trips/${tripId}`);
  const recFlight = flights.body.offers.find((o: any) => o.kind === 'flight' && o.role === 'recommended');
  assert.equal((await c.post(`/api/offers/${recFlight.id}/select`)).status, 200);
  h.mocks.weather.rainyDates.add('2027-03-11');
  const r = await c.post(`/api/trips/${tripId}/plan`, {});
  assert.equal(r.status, 200);
  assert.equal((await c.get(`/api/trips/${tripId}`)).body.trip.planStatus, 'generating');
  await h.worker.drain();
  const d = (await c.get(`/api/trips/${tripId}`)).body;
  assert.ok(['complete', 'incomplete'].includes(d.trip.planStatus), d.trip.planMessage);
  assert.equal(d.days.length, 7, 'every day including arrival and departure');
  const all = d.days.flatMap((x: any) => x.items);
  for (const it of all) for (const p of PLACEHOLDER_PATTERNS) assert.ok(!p.test(it.title), `placeholder in ${it.title}`);
  for (const it of all.filter((i: any) => ['breakfast', 'lunch', 'dinner', 'activity', 'hike'].includes(i.kind))) {
    assert.ok(it.venue?.name && it.venue.address && it.venue.mapsUrl, `${it.title} has a named venue`);
    assert.ok(it.sources.length >= 1, `${it.title} has sources`);
    assert.ok(it.retrievedAt, `${it.title} has a retrieval timestamp`);
  }
  // Vegetarian dish evidence: labelled dishes from the menu are kept, fish removed, invented sources dropped.
  const veg = all.find((i: any) => i.venue?.name?.startsWith('Veggie Garden') && i.venue.dishes?.length);
  assert.ok(veg, 'restaurant with sourced dishes');
  const names = veg.venue.dishes.map((x: any) => x.name);
  assert.ok(names.includes('Escalivada toast'));
  assert.ok(!names.includes('Fish of the day'));
  assert.ok(!names.includes('Invented dish'));
  assert.equal(veg.venue.dishes.find((x: any) => x.name === 'Mushroom risotto').dietStatus, 'likely', 'risotto flagged for possible stock');
  // Arrival day: nothing before the flight lands (SN3711 lands 11:05 local).
  const day1 = d.days[0];
  assert.ok(day1.items.every((i: any) => i.startLocal.slice(11) >= '11:05'), JSON.stringify(day1.items.map((i: any) => i.startLocal)));
  // Departure day: everything ends before leaving for the airport (return 18:00 local).
  const last = d.days.at(-1);
  assert.ok(last.items.filter((i: any) => i.kind !== 'travel').every((i: any) => i.endLocal.slice(11) <= '16:00'));
  // Rainy day: outdoor park swapped out, with a note.
  const rainy = d.days.find((x: any) => x.date === '2027-03-11');
  assert.ok(!rainy.items.some((i: any) => i.title.startsWith('Hilltop Park')));
  // Hike facts only from the official source; prompt injection in the source had no effect.
  const hike = all.find((i: any) => i.kind === 'hike');
  if (hike) { assert.match(hike.why, /9\.5 km/); assert.ok(hike.sources.some((s: any) => s.url === 'https://parks.example/ridge-trail')); }
  assert.ok(!JSON.stringify(d).includes('Casino Royale'));
  // The AI was told to treat sources as untrusted.
  assert.ok(h.mocks.ai.prompts.at(-1)!.includes('<untrusted_source'));
});

test('editing: move an activity, change pace, regenerate a single day', async () => {
  const d = (await c.get(`/api/trips/${tripId}`)).body;
  const day2 = d.days[1];
  const act = day2.items.find((i: any) => i.kind === 'activity');
  const mv = await c.post(`/api/trips/${tripId}/items/${act.id}/move`, { toDate: d.days[2].date });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  const after = (await c.get(`/api/trips/${tripId}`)).body;
  assert.ok(after.days[2].items.some((i: any) => i.title === act.title));
  assert.ok(!after.days[1].items.some((i: any) => i.title === act.title));
  const relaxed = await c.post(`/api/trips/${tripId}/days/${d.days[2].date}/reschedule`, { pace: 'relaxed' });
  assert.equal(relaxed.status, 200);
  assert.ok(relaxed.body.items.filter((i: any) => ['activity', 'hike'].includes(i.kind)).length <= 2);
  const before = after.days.find((x: any) => x.date === '2027-03-14');
  await c.post(`/api/trips/${tripId}/plan`, { date: '2027-03-12' });
  await h.worker.drain();
  const regen = (await c.get(`/api/trips/${tripId}`)).body;
  assert.deepEqual(regen.days.find((x: any) => x.date === '2027-03-14').items.map((i: any) => i.title), before.items.map((i: any) => i.title), 'other days untouched');
});

test('provider outage never overwrites a good saved itinerary', async () => {
  const before = (await c.get(`/api/trips/${tripId}`)).body;
  h.mocks.places.fail = true;
  await c.post(`/api/trips/${tripId}/plan`, {});
  await h.worker.drain();
  h.clock.now = new Date(h.clock.now.getTime() + 3600_000 * 3); // allow retries to become due
  await h.worker.drain();
  const after = (await c.get(`/api/trips/${tripId}`)).body;
  assert.equal(after.days.length, before.days.length);
  assert.deepEqual(after.days.map((d: any) => d.items.length), before.days.map((d: any) => d.items.length));
  assert.equal(after.trip.planStatus, 'incomplete');
  assert.match(after.trip.planMessage, /kept|unchanged/i);
  h.mocks.places.fail = false;
  h.mocks.flights.fail = true;
  const s = await search('flight');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /retry/i);
  h.mocks.flights.fail = false;
  const still = (await c.get(`/api/trips/${tripId}`)).body;
  assert.ok(still.offers.some((o: any) => o.kind === 'flight' && o.selected), 'selected flight survives a failed search');
});

test('booking: reprice, expired fare, price increase and checkout handoff without purchase', async () => {
  const d = (await c.get(`/api/trips/${tripId}`)).body;
  const f = d.offers.find((o: any) => o.kind === 'flight' && o.selected);
  const sess = (await c.post(`/api/offers/${f.id}/select`)).body;
  assert.equal(sess.state, 'selected');
  // Handoff before repricing is refused.
  assert.equal((await c.post(`/api/booking-sessions/${sess.id}/handoff`, { acceptedAmount: f.total.amount, acceptedCurrency: 'EUR', acceptConditions: true })).status, 409);
  // Price increase must be reviewed.
  h.mocks.flights.repriceTo = f.total.amount + 40;
  const up = (await c.post(`/api/booking-sessions/${sess.id}/reprice`)).body;
  assert.equal(up.state, 'price_changed');
  assert.equal((await c.post(`/api/booking-sessions/${sess.id}/handoff`, { acceptedAmount: f.total.amount, acceptedCurrency: 'EUR', acceptConditions: true })).body.error.code, 'price_mismatch');
  // Offer gone → expired, never handed off.
  h.mocks.flights.repriceTo = null;
  assert.equal((await c.post(`/api/booking-sessions/${sess.id}/reprice`)).body.state, 'expired');
  // Fresh session with unchanged price.
  h.mocks.flights.repriceTo = 'same';
  const s2 = (await c.post(`/api/offers/${f.id}/select`)).body;
  const rp = (await c.post(`/api/booking-sessions/${s2.id}/reprice`)).body;
  assert.equal(rp.state, 'repriced');
  const trav = { title: 'ms', givenName: 'Ana', familyName: 'Silva', bornOn: '1990-01-01', gender: 'f', email: 'ana@example.com', phone: '+32470000000' };
  assert.equal((await c.post(`/api/booking-sessions/${s2.id}/travellers`, { travellers: [trav] })).status, 400, 'needs both adults');
  assert.equal((await c.post(`/api/booking-sessions/${s2.id}/travellers`, { travellers: [trav, { ...trav, givenName: 'Rui' }] })).body.state, 'details_collected');
  const raw = await h.ctx.db.query<any>('SELECT traveller_details_enc FROM booking_sessions WHERE id=$1', [s2.id]);
  assert.ok(!raw.rows[0].traveller_details_enc.includes('Silva'), 'traveller details encrypted at rest');
  assert.equal((await c.post(`/api/booking-sessions/${s2.id}/handoff`, { acceptedAmount: rp.repricedAmount, acceptedCurrency: 'EUR', acceptConditions: false })).status, 400);
  const ho = (await c.post(`/api/booking-sessions/${s2.id}/handoff`, { acceptedAmount: rp.repricedAmount, acceptedCurrency: 'EUR', acceptConditions: true })).body;
  assert.equal(ho.state, 'ready_for_handoff');
  assert.equal(ho.handoff.type, 'hosted_checkout');
  assert.match(ho.handoff.note, /never sees your card/);
  // No order exists until the provider confirms one.
  assert.equal(h.mocks.checkout.orders.size, 0);
  assert.equal((await c.get('/api/reservations')).body.filter((r: any) => r.source === 'booking_flow').length, 0);
  await c.post(`/api/booking-sessions/${s2.id}/handed-off`);
  assert.equal((await c.post(`/api/booking-sessions/${s2.id}/complete`, { orderId: 'ord_fake', result: 'success' })).status, 400, 'unverifiable order rejected');
  h.mocks.checkout.orders.set('ord_123', { bookingReference: 'ZX9Q7P' });
  const done = (await c.post(`/api/booking-sessions/${s2.id}/complete`, { orderId: 'ord_123', result: 'success' })).body;
  assert.equal(done.state, 'completed');
  const res = (await c.get('/api/reservations')).body.find((r: any) => r.source === 'booking_flow');
  assert.equal(res.confirmationCode, 'ZX9Q7P');
  assert.equal(res.checkinStatus, 'unknown', 'a booking is not proof of check-in');
});

test('destination ideas are verified against live data; unverifiable AI suggestions dropped', async () => {
  const t = (await c.post('/api/trips', { title: 'Where to?', origin: PLACES.BRU, startDate: '2027-06-05', endDate: '2027-06-09', budgetTotal: 1500 })).body;
  const r = await c.post(`/api/trips/${t.id}/searches`, { kind: 'destinations' });
  await h.worker.drain();
  const s = (await c.get(`/api/searches/${r.body.searchId}`)).body;
  assert.equal(s.status, 'complete', JSON.stringify(s));
  assert.equal(s.result.unverified, 1);
  assert.ok(s.result.destinations.every((x: any) => x.place.iata !== 'ZZZ'));
  assert.ok(s.result.destinations[0].reasons.some((x: string) => /Quoted flights/.test(x)));
  assert.ok(s.result.destinations[0].reasons.some((x: string) => /Forecast|Historical climate/.test(x)));
});
