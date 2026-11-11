// MOCKED end-to-end test: public dashboard data → trip ideas (Nager.Date + Google Travel Explore from all nearby
// airports) → choose an idea → one multi-airport Google Flights search + Google Hotels → "Book everything".
// Real adapters, simulated network with documented response shapes. Proves wiring, not the live services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness, type Client } from '../helpers/harness.ts';
import { setFetch } from '../../src/server/integrations/http.ts';
import { FreeGeo } from '../../src/server/integrations/freegeo.ts';
import { SerpApiExplore, SerpApiFlights, SerpApiHotels } from '../../src/server/integrations/serpapi.ts';
import { NagerHolidays } from '../../src/server/integrations/holidays.ts';
import { BrevoMailer } from '../../src/server/integrations/messaging.ts';
import type { Place } from '../../src/shared/types.ts';
import { AIRPORTS, BRUSSELS, brevoSent, calls, net, sim, tzLookup } from '../helpers/simnet.ts';

let h: Harness; let c: Client;
before(async () => {
  setFetch(net());
  h = await startHarness({ SERPAPI_API_KEY: 'serp_test', BREVO_API_KEY: 'xkeysib-test', EMAIL_FROM: 'Travel Compass <me@example.com>' }, (m) => {
    const geo = new FreeGeo({ airportsUrl: 'unused', dataDir: '/nonexistent', photonUrl: 'https://photon.example', airports: AIRPORTS, tzLookup });
    const quota = async () => {};
    // Real Brevo adapter on the simulated network; copies kept so the sign-up helper can read links.
    const mailer = new (class extends BrevoMailer { override async send(x: any) { await super.send(x); m.mailer.outbox.push(x); } })('xkeysib-test', 'Travel Compass <me@example.com>');
    return { flights: new SerpApiFlights('serp_test', geo, quota), stays: [new SerpApiHotels('serp_test', quota)], explore: new SerpApiExplore('serp_test', quota), holidays: new NagerHolidays('https://date.nager.at/api/v3'), mailer };
  });
});
after(async () => { setFetch((...a) => fetch(...a)); await h.close(); });

test('dashboard is public: place search and holiday windows without an account, no paid searches', async () => {
  const anon = h.client();
  const home = await fetch(h.base + '/');
  assert.equal(home.status, 200, 'the dashboard page loads without signing in');
  const places = await anon.get('/api/places?q=Brussels');
  assert.equal(places.status, 200); assert.ok(places.body.some((p: any) => p.name === 'Brussels' && p.airports.some((a: any) => a.iata === 'BRU')));
  const w = await anon.get('/api/public/windows?country=BE&months=6');
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.ok(w.body.windows.some((x: any) => x.label === 'Easter Monday long weekend' && x.leaveDays === 0));
  assert.ok(w.body.windows.some((x: any) => x.label.startsWith('Ascension Day') && x.needsBridgeDay));
  assert.equal(calls.length, 0, 'browsing never spends the SerpApi allowance');
  const denied = await anon.post('/api/ideas', { origin: BRUSSELS });
  assert.equal(denied.status, 401, 'live prices need an account');
  assert.equal((await anon.get('/api/trips')).status, 401, 'personal data stays private');
});

let ideaId: string; let tripId: string;
test('trip ideas: one Travel Explore search per window from every airport near home, ranked with real prices only', async () => {
  c = await signUp(h, 'ideas@example.com');
  await c.put('/api/profile', { homePlace: BRUSSELS, currency: 'EUR', onboardingComplete: true });
  const r = await c.post('/api/ideas', { origin: BRUSSELS, months: 6, adults: 1, budget: 600, currency: 'EUR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ideaId = r.body.ideaId;
  await h.worker.drain();
  const g = (await c.get(`/api/ideas/${ideaId}`)).body;
  assert.equal(g.status, 'complete', JSON.stringify(g));
  const ex = calls.filter((x) => x.engine === 'google_travel_explore');
  assert.ok(ex.length >= 1 && ex.length <= 3, `at most IDEA_WINDOWS searches (got ${ex.length})`);
  assert.equal(ex[0].q.get('departure_id'), 'BRU,CRL', 'home airport plus Charleroi (within 150 km) in ONE search');
  assert.deepEqual(g.result.airports.map((a: any) => a.iata), ['BRU', 'CRL']);
  const ideas = g.result.ideas;
  assert.ok(ideas.length >= 2);
  assert.ok(ideas.every((i: any) => i.destination.iata !== 'BRU' && i.destination.iata !== 'UNP'), 'home airports and unpriced places are never suggested');
  assert.equal(ideas[0].destination.iata, 'LIS', 'cheapest good trip first');
  assert.equal(ideas[0].total, 89 + 58 * ideas[0].nights);
  assert.ok(ideas[0].window.label.length > 0);
  assert.ok(g.result.notes.some((n: string) => /Hotel prices are per night/.test(n)));
  // Another user cannot read someone else's ideas.
  const other = await signUp(h, 'other@example.com');
  assert.equal((await other.get(`/api/ideas/${ideaId}`)).status, 404);
});

test('choosing an idea creates the trip and searches flights from all nearby airports in a single search', async () => {
  const before = calls.length;
  const lis = (await c.get(`/api/ideas/${ideaId}`)).body.result.ideas.find((i: any) => i.destination.iata === 'LIS');
  const r = await c.post(`/api/ideas/${ideaId}/choose`, { index: lis.index });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tripId = r.body.tripId;
  assert.deepEqual(r.body.started.slice(0, 2), ['flight', 'stay']);
  await h.worker.drain();
  const detail = (await c.get(`/api/trips/${tripId}`)).body;
  assert.equal(detail.trip.startDate, lis.window.start); assert.equal(detail.stops[0].place.iata, 'LIS');
  const outbound = calls.slice(before).filter((x) => x.engine === 'google_flights' && !x.q.get('departure_token'));
  assert.equal(outbound.length, 1, 'one outbound search covers BRU and CRL');
  assert.equal(outbound[0].q.get('departure_id'), 'BRU,CRL');
  const searches = (await c.get(`/api/trips/${tripId}/searches`)).body;
  const fs = (await c.get(`/api/searches/${searches.find((s: any) => s.kind === 'flight').id}`)).body;
  assert.equal(fs.status, 'complete', JSON.stringify(fs.error));
  // The Charleroi fare is both cheapest and best overall here, so it carries the 'recommended' role.
  const cheapest = [...fs.offers].sort((a: any, b: any) => a.total.amount - b.total.amount)[0];
  assert.equal(fs.offers.find((o: any) => o.role === 'recommended').id, cheapest.id, 'cheaper airport wins even after the transfer cost');
  assert.equal(cheapest.data.offer.slices[0].from, 'CRL', 'the cheaper Charleroi fare is found');
  assert.ok(fs.result.notes[0].startsWith('Searched 2 airports near you: BRU'), fs.result.notes[0]);
  assert.ok(cheapest.data.scoring.components.some((x: any) => /Ground transfer CRL/.test(x.label)), 'getting to the farther airport is priced in');
});

test('Book everything: flights, stays, hostels/Airbnb, car rental, transport, tickets and extras in one checklist', async () => {
  const r = await c.get(`/api/trips/${tripId}/book`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const items = r.body.items;
  const fl = items.find((i: any) => i.section === 'flights');
  assert.equal(fl.status, 'to_book');
  assert.ok(fl.options.some((o: any) => o.price.amount === 89 && o.offer.id));
  const stay = items.find((i: any) => i.section === 'stays');
  assert.ok(stay.options.some((o: any) => o.title === 'Lisbon Central Hostel' && o.price.amount === 96), JSON.stringify(stay.options.map((o: any) => [o.role, o.title])));
  assert.ok(stay.links.some((l: any) => l.label === 'Airbnb') && stay.links.some((l: any) => /Hostels/.test(l.label)));
  const car = items.find((i: any) => i.section === 'car');
  assert.ok(car.links.some((l: any) => l.url.includes('/cars/LIS/')));
  assert.match(car.note, /no free price source/);
  assert.ok(items.some((i: any) => i.section === 'transport' && /Airport LIS/.test(i.title)));
  assert.ok(items.some((i: any) => i.key === 'extra:insurance'));
  assert.ok(items.flatMap((i: any) => i.links).every((l: any) => /^https:\/\//.test(l.url)));
  assert.equal(r.body.totals.cheapest, 89 + 96);
  // Recording a booking marks the item as booked.
  await c.post('/api/reservations', { tripId, kind: 'flight', providerName: 'Ryanair', confirmationCode: 'ABC123', startDate: '2027-03-27' });
  const again = (await c.get(`/api/trips/${tripId}/book`)).body;
  assert.equal(again.items.find((i: any) => i.section === 'flights').status, 'booked');
  const other = await signUp(h, 'nosy@example.com');
  assert.equal((await other.get(`/api/trips/${tripId}/book`)).status, 404, 'checklists are private to the trip owner');
});

test('a return date before the departure date is a clear 400, not a server error', async () => {
  const r = await c.post('/api/trips', { title: 'Backwards', origin: BRUSSELS, adults: 1, startDate: '2027-12-17', endDate: '2027-11-27', stops: [] });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error.message, /return date is before the departure date/);
});


test('sign-up email goes through Brevo to the address typed, with a working verification link', async () => {
  const anon = h.client();
  const r = await anon.post('/api/auth/register', { email: 'tejash@example.com', password: 'correct horse battery', displayName: 'Tejash' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mail = brevoSent.find((m) => m.to[0].email === 'tejash@example.com');
  assert.ok(mail, 'Brevo was asked to send the verification email');
  assert.deepEqual(mail.sender, { name: 'Travel Compass', email: 'me@example.com' });
  const link = /https?:\/\/\S+verify-email\S+/.exec(mail.textContent)![0];
  const v = await anon.post('/api/auth/verify-email', { token: new URL(link).searchParams.get('token') });
  assert.equal(v.status, 200, JSON.stringify(v.body));
});

test('your journey: trip from Charleroi → Suggest destinations (1 search, no AI) → choose → flights + stays → Book everything → flexible dates', async () => {
  const CRL: Place = { name: 'Brussels South Charleroi Airport (CRL)', kind: 'airport', iata: 'CRL', lat: 50.459, lng: 4.453, countryCode: 'BE', timeZone: 'Europe/Brussels', cityName: 'Charleroi', source: 'ourairports' };
  const t = await c.post('/api/trips', { title: 'New trip', origin: CRL, adults: 1, startDate: '2027-12-17', endDate: '2027-12-27', flexDays: 3, budgetTotal: 300, stops: [] });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const id = t.body.id;
  const before = calls.length;
  const s = await c.post(`/api/trips/${id}/searches`, { kind: 'destinations' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  await h.worker.drain();
  const d = (await c.get(`/api/searches/${s.body.searchId}`)).body;
  assert.equal(d.status, 'complete', d.error);
  const used = calls.slice(before);
  assert.equal(used.length, 1, 'one Travel Explore search, nothing else');
  assert.equal(used[0].engine, 'google_travel_explore');
  assert.ok(used[0].q.get('departure_id')!.split(',').includes('CRL'));
  const lis = d.result.destinations.find((x: any) => x.place.airports?.[0]?.iata === 'LIS');
  assert.ok(lis, JSON.stringify(d.result.destinations.map((x: any) => x.place.name)));
  assert.equal(lis.flight.amount, 89); assert.equal(lis.stay.amount, 58 * 10);
  // Choose it (what the button does), then search flights and stays.
  const trip = (await c.get(`/api/trips/${id}`)).body.trip;
  const p = await c.patch(`/api/trips/${id}`, { version: trip.version, changes: { title: `Trip to ${lis.place.name}`, stops: [{ place: lis.place, arriveDate: trip.startDate, departDate: trip.endDate }] } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  for (const kind of ['flight', 'stay']) assert.equal((await c.post(`/api/trips/${id}/searches`, { kind })).status, 200);
  await h.worker.drain();
  const book = (await c.get(`/api/trips/${id}/book`)).body;
  assert.equal(book.items.find((i: any) => i.section === 'flights').status, 'to_book');
  assert.equal(book.items.find((i: any) => i.section === 'stays').status, 'to_book');
  // Flexible dates on the same trip.
  const f = await c.post(`/api/trips/${id}/searches`, { kind: 'flex' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  await h.worker.drain();
  const fx = (await c.get(`/api/searches/${f.body.searchId}`)).body;
  assert.ok(['complete', 'partial'].includes(fx.status), fx.error);
});

test('failures name the service and the setting to fix — no more "a travel data service did not respond"', async () => {
  sim.serpStatus = 401;
  try {
    const r = await c.post('/api/ideas', { origin: BRUSSELS, months: 3 });
    await h.worker.drain();
    const g = (await c.get(`/api/ideas/${r.body.ideaId}`)).body;
    assert.equal(g.status, 'failed');
    assert.match(g.error, /SerpApi.*rejected the request \(HTTP 401\).*SERPAPI_API_KEY/);
  } finally { sim.serpStatus = 200; }
});

test('admin self-test reports each live service, and can send a real test email', async () => {
  const admin = await signUp(h, 'admin@example.com');
  assert.equal((await c.post('/api/admin/selftest', {})).status, 404, 'admins only (hidden from others)');
  const r = await admin.post('/api/admin/selftest', { sendEmail: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.results.map((x: any) => [x.key, x]));
  for (const k of ['database', 'places', 'nearby', 'holidays', 'weather', 'serpapi', 'email']) assert.equal(by[k].status, 'ok', `${k}: ${by[k].detail}`);
  assert.match(by.serpapi.detail, /searches left this month: 231/);
  assert.equal(by.flights.status, 'skipped', 'no SerpApi search unless asked');
  assert.ok(brevoSent.some((m) => m.to[0].email === 'admin@example.com' && /test email/i.test(m.subject)));
  assert.ok(!JSON.stringify(r.body).includes('serp_test') && !JSON.stringify(r.body).includes('xkeysib'), 'keys never shown');
});
