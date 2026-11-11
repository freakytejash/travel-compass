// MOCKED end-to-end test: public dashboard data → trip ideas (Nager.Date + Google Travel Explore from all nearby
// airports) → choose an idea → one multi-airport Google Flights search + Google Hotels → "Book everything".
// Real adapters, simulated network with documented response shapes. Proves wiring, not the live services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness, type Client } from '../helpers/harness.ts';
import { setFetch } from '../../src/server/integrations/http.ts';
import { FreeGeo, type Airport } from '../../src/server/integrations/freegeo.ts';
import { SerpApiExplore, SerpApiFlights, SerpApiHotels } from '../../src/server/integrations/serpapi.ts';
import { NagerHolidays } from '../../src/server/integrations/holidays.ts';
import type { Place } from '../../src/shared/types.ts';

const AIRPORTS: Airport[] = [
  { iata: 'BRU', name: 'Brussels Airport', city: 'Brussels', country: 'BE', lat: 50.901, lng: 4.484, size: 'large' },
  { iata: 'CRL', name: 'Brussels South Charleroi Airport', city: 'Charleroi', country: 'BE', lat: 50.459, lng: 4.453, size: 'medium' },
  { iata: 'LIS', name: 'Humberto Delgado Airport', city: 'Lisbon', country: 'PT', lat: 38.774, lng: -9.134, size: 'large' },
  { iata: 'BCN', name: 'Barcelona El Prat', city: 'Barcelona', country: 'ES', lat: 41.297, lng: 2.083, size: 'large' },
];
const tzLookup = async (lat: number) => (lat < 40 ? 'Europe/Lisbon' : lat < 45 ? 'Europe/Madrid' : 'Europe/Brussels');
const BRUSSELS: Place = { name: 'Brussels', kind: 'city', lat: 50.8466, lng: 4.3528, countryCode: 'BE', timeZone: 'Europe/Brussels', iata: 'BRU', cityName: 'Brussels', airports: [{ iata: 'BRU', name: 'Brussels Airport', lat: 50.901, lng: 4.484 }], source: 'photon' };

const calls: { engine: string; q: URLSearchParams }[] = [];
let nagerCalls = 0;
const seg = (from: string, to: string, d: string, a: string, fn: string, airline: string, dur: number) => ({ departure_airport: { id: from, time: d }, arrival_airport: { id: to, time: a }, duration: dur, airline, flight_number: fn, extensions: [] });

function net(): typeof fetch {
  return (async (input: any) => {
    const url = new URL(String(input));
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'date.nager.at') {
      nagerCalls++;
      if (url.pathname.endsWith('/PublicHolidays/2027/BE')) return j([
        { date: '2027-03-29', name: 'Easter Monday', localName: 'Paasmaandag', countryCode: 'BE', global: true },
        { date: '2027-05-06', name: 'Ascension Day', localName: 'O.L.H. Hemelvaart', countryCode: 'BE', global: true },
      ]);
      if (url.pathname.endsWith('/LongWeekend/2027/BE')) return j([
        { startDate: '2027-03-27', endDate: '2027-03-29', dayCount: 3, needBridgeDay: false },
        { startDate: '2027-05-06', endDate: '2027-05-09', dayCount: 4, needBridgeDay: true },
      ]);
      return new Response('', { status: 404 });
    }
    if (url.hostname === 'photon.example') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const f = (name: string, lng: number, lat: number, cc: string, country: string) => ({ geometry: { coordinates: [lng, lat] }, properties: { name, osm_key: 'place', osm_value: 'city', countrycode: cc, country } });
      return j({ features: q.startsWith('lis') ? [f('Lisbon', -9.1393, 38.7223, 'PT', 'Portugal')] : q.startsWith('bar') ? [f('Barcelona', 2.1686, 41.3874, 'ES', 'Spain')] : q.startsWith('bru') ? [f('Brussels', 4.3528, 50.8466, 'BE', 'Belgium')] : [] });
    }
    if (url.hostname === 'serpapi.com') {
      const q = url.searchParams; const engine = q.get('engine')!;
      calls.push({ engine, q });
      if (engine === 'google_travel_explore') return j({ search_metadata: { google_travel_explore_url: 'https://www.google.com/travel/explore?tfs=x' }, destinations: [
        { name: 'Lisbon', country: 'Portugal', destination_airport: { code: 'LIS' }, gps_coordinates: { latitude: 38.7223, longitude: -9.1393 }, flight_price: 89, hotel_price: 58, start_date: q.get('outbound_date'), end_date: q.get('return_date'), flight_duration: 165, number_of_stops: 0, airline: 'Ryanair', thumbnail: 'https://img.example/lis.jpg', link: 'https://www.google.com/travel/explore?d=LIS' },
        { name: 'Barcelona', country: 'Spain', destination_airport: { code: 'BCN' }, gps_coordinates: { latitude: 41.3874, longitude: 2.1686 }, flight_price: 140, hotel_price: 95, flight_duration: 125, number_of_stops: 0, airline: 'Vueling' },
        { name: 'Brussels', country: 'Belgium', destination_airport: { code: 'BRU' }, flight_price: 1 },
        { name: 'Unpriced', country: 'X', destination_airport: { code: 'UNP' } },
      ] });
      if (engine === 'google_hotels') return j({ search_metadata: { google_hotels_url: 'https://www.google.com/travel/hotels/Lisbon' }, properties: [
        { name: 'Lisbon Central Hostel', type: 'hotel', link: 'https://hostel.example', gps_coordinates: { latitude: 38.715, longitude: -9.14 }, total_rate: { extracted_lowest: 96 }, overall_rating: 4.5, property_token: 'h1' },
        { name: 'Hotel Baixa', type: 'hotel', link: 'https://baixa.example', gps_coordinates: { latitude: 38.711, longitude: -9.137 }, total_rate: { extracted_lowest: 210 }, overall_rating: 4.7, extracted_hotel_class: 4, property_token: 'h2', amenities: ['Free cancellation'] },
      ] });
      if (engine === 'google_flights') {
        const tok = q.get('departure_token');
        if (tok) return j({ best_flights: [{ flights: [tok === 'crl' ? seg('LIS', 'CRL', '2027-03-29 18:00', '2027-03-29 21:45', 'FR 7311', 'Ryanair', 165) : seg('LIS', 'BRU', '2027-03-29 17:00', '2027-03-29 20:45', 'TP 1209', 'TAP', 165)], total_duration: 165, price: tok === 'crl' ? 89 : 260, booking_token: `b_${tok}` }] });
        return j({ search_metadata: { id: 'f1', google_flights_url: 'https://www.google.com/travel/flights?tfs=lis' },
          best_flights: [{ flights: [seg('BRU', 'LIS', '2027-03-27 10:00', '2027-03-27 11:45', 'TP 1204', 'TAP', 165)], total_duration: 165, price: 260, departure_token: 'bru' }],
          other_flights: [{ flights: [seg('CRL', 'LIS', '2027-03-27 07:00', '2027-03-27 08:45', 'FR 7310', 'Ryanair', 165)], total_duration: 165, price: 89, departure_token: 'crl' }] });
      }
    }
    return new Response('unexpected ' + url, { status: 599 });
  }) as typeof fetch;
}

let h: Harness; let c: Client;
before(async () => {
  setFetch(net());
  h = await startHarness({}, () => {
    const geo = new FreeGeo({ airportsUrl: 'unused', dataDir: '/nonexistent', photonUrl: 'https://photon.example', airports: AIRPORTS, tzLookup });
    const quota = async () => {};
    return { flights: new SerpApiFlights('serp_test', geo, quota), stays: [new SerpApiHotels('serp_test', quota)], explore: new SerpApiExplore('serp_test', quota), holidays: new NagerHolidays('https://date.nager.at/api/v3') };
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
