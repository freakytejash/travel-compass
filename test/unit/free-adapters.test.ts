// Contract tests for the free-stack adapters against documented response shapes (NOT live calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmHoursToWeekdays, osmElementToPlace, OsmPlaces } from '../../src/server/integrations/osm.ts';
import { FreeGeo, parseOurAirports } from '../../src/server/integrations/freegeo.ts';
import { normaliseSerpHotels } from '../../src/server/integrations/serpapi.ts';
import { WikimediaResearch } from '../../src/server/integrations/wikimedia.ts';
import { OpenAiCompatAi } from '../../src/server/integrations/openaiCompat.ts';
import { parseTelegramUpdates, TelegramBot } from '../../src/server/integrations/telegram.ts';
import { renderTemplate } from '../../src/server/services/notifications.ts';
import { windowsForDate } from '../../src/server/domain/itinerary.ts';
import { setFetch } from '../../src/server/integrations/http.ts';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

test('OSM opening_hours → weekday descriptions → scheduler windows', () => {
  const w = osmHoursToWeekdays('Mo-Fr 08:00-18:00; Sa 09:00-13:00,14:00-17:00; Su off')!;
  assert.equal(w[0], 'Monday: 08:00 – 18:00');
  assert.equal(w[5], 'Saturday: 09:00 – 13:00, 14:00 – 17:00');
  assert.equal(w[6], 'Sunday: Closed');
  assert.deepEqual(windowsForDate(w, '2027-03-13'), [{ open: 540, close: 780 }, { open: 840, close: 1020 }]); // a Saturday
  assert.deepEqual(osmHoursToWeekdays('Tu-Su 10:00-22:00')!.slice(0, 2), ['Monday: Closed', 'Tuesday: 10:00 – 22:00']);
  assert.deepEqual(windowsForDate(osmHoursToWeekdays('Fr-Sa 18:00-02:00'), '2027-03-12'), [{ open: 1080, close: 1560 }], 'overnight span');
  assert.equal(osmHoursToWeekdays('24/7')![3], 'Thursday: Open 24 hours');
  assert.deepEqual(osmHoursToWeekdays('Mo-Su 09:00-18:00; PH off')![0], 'Monday: 09:00 – 18:00');
  for (const unsafe of ['Apr-Oct: Mo-Su 09:00-19:00', 'Mo-Fr sunrise-sunset', 'Mo 09:00-12:00 "by appointment"', 'week 1-26 Mo 10:00-12:00', 'garbage']) assert.equal(osmHoursToWeekdays(unsafe), null, unsafe);
});

test('OSM element mapping: vegetarian tags, address, facts, attribution', () => {
  const p = osmElementToPlace({ type: 'node', id: 42, lat: 41.38, lon: 2.17, tags: { name: 'Veggie Garden', amenity: 'restaurant', 'diet:vegetarian': 'only', 'addr:street': 'Carrer dels Àngels', 'addr:housenumber': '3', 'addr:city': 'Barcelona', opening_hours: 'Mo-Su 12:00-23:00', reservation: 'recommended' } })!;
  assert.equal(p.placeId, 'osm:node/42');
  assert.equal(p.address, 'Carrer dels Àngels 3, Barcelona');
  assert.equal(p.servesVegetarianFood, true);
  assert.equal(p.reservable, true);
  assert.match(p.facts!, /diet:vegetarian=only/);
  assert.equal(p.mapsUrl, 'https://www.openstreetmap.org/node/42');
  assert.deepEqual(p.attributions, ['© OpenStreetMap contributors']);
  const hike = osmElementToPlace({ type: 'relation', id: 7, center: { lat: 41.4, lon: 2.1 }, tags: { name: 'GR 92', route: 'hiking', distance: '12.4' } })!;
  assert.match(hike.facts!, /route distance=12.4 km/);
  assert.match(osmElementToPlace({ type: 'node', id: 1, lat: 1, lon: 1, tags: { name: 'X' } })!.address, /no street address/);
  assert.equal(osmElementToPlace({ type: 'node', id: 1, lat: 1, lon: 1, tags: {} }), null, 'unnamed features are never used');
});

test('OSM provider: one cached Overpass call per category; vegetarian venues ranked first', async () => {
  let calls = 0;
  setFetch((async (_u: any, init: any) => {
    calls++;
    assert.equal(init.method, 'POST');
    assert.match(init.headers['User-Agent'], /TravelCompass/);
    return json({ elements: [
      { type: 'node', id: 1, lat: 41.381, lon: 2.171, tags: { name: 'Steak House', amenity: 'restaurant' } },
      { type: 'node', id: 2, lat: 41.382, lon: 2.172, tags: { name: 'Teresa Carles', amenity: 'restaurant', 'diet:vegetarian': 'only', opening_hours: 'Mo-Su 09:00-23:30' } },
      { type: 'node', id: 3, lat: 41.383, lon: 2.17, tags: { name: 'Café Zero', amenity: 'cafe', 'diet:vegan': 'yes' } },
      { type: 'node', id: 4, lat: 41.383, lon: 2.17, tags: { name: 'Closed Place', amenity: 'restaurant', 'disused:amenity': 'restaurant' } },
    ] });
  }) as typeof fetch);
  const osm = new OsmPlaces('https://overpass.example/api/interpreter', 'TravelCompass/1.0 (+test)');
  const near = { lat: 41.38, lng: 2.17, radiusM: 8000 };
  const rest = await osm.textSearch('vegetarian restaurant in Barcelona', { near });
  assert.equal(rest[0].name, 'Teresa Carles');
  assert.ok(!rest.some((p) => p.name === 'Closed Place'));
  const breakfast = await osm.textSearch('vegetarian breakfast cafe in Barcelona', { near });
  assert.deepEqual(breakfast.map((p) => p.name), ['Café Zero']);
  assert.equal(calls, 1, 'food data fetched once and reused');
  setFetch((...a) => fetch(...a));
});

test('OurAirports parsing and free place search (Photon + airports + time zones)', async () => {
  const csv = '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code"\n'
    + '1,"EBBR","large_airport","Brussels Airport",50.9014,4.4844,184,"EU","BE","BE-VBR","Brussels","yes","EBBR","BRU"\n'
    + '2,"EBCI","medium_airport","Brussels South Charleroi Airport",50.4592,4.4538,614,"EU","BE","BE-WHT","Charleroi","yes","EBCI","CRL"\n'
    + '3,"EBXX","small_airport","Grass strip, ""Club""",50.8,4.3,0,"EU","BE","BE-BRU","Brussels","no","",""\n';
  const airports = parseOurAirports(csv);
  assert.deepEqual(airports.map((a) => a.iata), ['BRU', 'CRL']);
  setFetch((async (u: any) => {
    assert.match(String(u), /photon\.example\/api\/\?q=Brussels/);
    return json({ features: [{ geometry: { coordinates: [4.3517, 50.8466] }, properties: { name: 'Brussels', osm_key: 'place', osm_value: 'city', country: 'Belgium', countrycode: 'BE' } }, { geometry: { coordinates: [4.35, 50.84] }, properties: { name: 'Rue de Bruxelles', osm_key: 'highway', osm_value: 'residential' } }] });
  }) as typeof fetch);
  const geo = new FreeGeo({ airportsUrl: 'x', dataDir: '/nonexistent', photonUrl: 'https://photon.example', airports, tzLookup: async () => 'Europe/Brussels' });
  const r = await geo.searchPlaces('Brussels');
  const city = r.find((p) => p.kind === 'city')!;
  assert.equal(city.timeZone, 'Europe/Brussels');
  assert.deepEqual(city.airports!.map((a) => a.iata), ['BRU', 'CRL'], 'large airports first, then medium, within 90 km');
  assert.equal(city.iata, 'BRU');
  assert.ok(r.some((p) => p.kind === 'airport' && p.iata === 'BRU'), 'airport matched by city name');
  assert.ok(!r.some((p) => p.name.startsWith('Rue')), 'streets filtered out');
  setFetch((...a) => fetch(...a));
  assert.equal((await geo.searchPlaces('CRL')).find((p) => p.kind === 'airport')?.iata, 'CRL');
});

test('Google Hotels (SerpApi) normalisation: totals, taxes, rating scale, no unpriced or far properties, no API key leaks', () => {
  const r = { search_metadata: { google_hotels_url: 'https://www.google.com/travel/hotels/Barcelona' }, properties: [
    { name: 'Hotel Central', type: 'hotel', link: 'https://hotelcentral.example', gps_coordinates: { latitude: 41.385, longitude: 2.17 }, total_rate: { extracted_lowest: 360, extracted_before_taxes_fees: 330 }, rate_per_night: { extracted_lowest: 120 }, overall_rating: 4.4, extracted_hotel_class: 3, property_token: 'tok1', amenities: ['Free Wi-Fi', 'Free cancellation'], serpapi_property_details_link: 'https://serpapi.com/search.json?api_key=SECRET' },
    { name: 'Nightly Only Hostel', type: 'hotel', gps_coordinates: { latitude: 41.39, longitude: 2.16 }, rate_per_night: { extracted_lowest: 30 }, property_token: 'tok2' },
    { name: 'No Price Inn', type: 'hotel', gps_coordinates: { latitude: 41.39, longitude: 2.16 }, property_token: 'tok3' },
    { name: 'Far Resort', type: 'hotel', gps_coordinates: { latitude: 42.5, longitude: 3.1 }, total_rate: { extracted_lowest: 200 }, property_token: 'tok4' },
  ] };
  const out = normaliseSerpHotels(r, { lat: 41.3874, lng: 2.1686, radiusKm: 5, checkIn: '2027-03-10', checkOut: '2027-03-13', adults: 2, currency: 'EUR' }, 'now');
  assert.deepEqual(out.map((o) => o.propertyName), ['Hotel Central', 'Nightly Only Hostel']);
  assert.deepEqual(out[0].taxesAndFees, { amount: 30, currency: 'EUR' });
  assert.equal(out[0].reviewScore, 8.8);
  assert.equal(out[0].cancellation.refundable, true);
  assert.equal(out[1].total.amount, 90);
  assert.match(out[1].payment, /Estimated from the nightly rate/);
  assert.equal(out[1].link, 'https://www.google.com/travel/hotels/Barcelona');
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('Wikivoyage research: cleaned search, planning sections first, attribution titles', async () => {
  const seen: string[] = [];
  setFetch((async (u: any) => {
    const url = new URL(String(u)); seen.push(url.hostname + ' ' + (url.searchParams.get('srsearch') ?? url.searchParams.get('titles')));
    if (url.searchParams.get('list') === 'search') return json({ query: { search: url.hostname.startsWith('en.wikivoyage') ? [{ title: 'Barcelona', snippet: '<b>Barcelona</b> is…' }] : [] } });
    return json({ query: { pages: [{ title: 'Barcelona', extract: 'Intro text.\n== Understand ==\nHistory.\n== See ==\nSagrada Família.\n== Eat ==\nTry escalivada (roasted vegetables) and pa amb tomàquet.\n== Sleep ==\nHotels.' }] } });
  }) as typeof fetch);
  const w = new WikimediaResearch('TravelCompass/1.0 (+test)');
  const hits = await w.search('Barcelona traditional vegetarian dishes to try', { count: 2 });
  assert.equal(hits[0].url, 'https://en.wikivoyage.org/wiki/Barcelona');
  assert.ok(seen[0].endsWith(' Barcelona'), `query cleaned: ${seen[0]}`);
  const page = await w.fetchText(hits[0].url);
  assert.ok(page.text.startsWith('== Eat =='), 'Eat section first');
  assert.ok(!page.text.includes('Hotels.'), 'irrelevant sections dropped');
  assert.match(page.title, /Wikivoyage/);
  setFetch((...a) => fetch(...a));
});

test('OpenAI-compatible AI: JSON mode, bearer key, fallback when response_format is rejected', async () => {
  const bodies: any[] = []; let n = 0;
  setFetch((async (u: any, init: any) => {
    assert.equal(String(u), 'https://api.groq.example/openai/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer gsk_test');
    const b = JSON.parse(init.body); bodies.push(b); n++;
    if (n === 1) return json({ error: { message: 'response_format not supported' } }, 400);
    return json({ choices: [{ message: { content: 'Sure! ```json\n{"ok": true}\n```' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }) as typeof fetch);
  const ai = new OpenAiCompatAi({ baseUrl: 'https://api.groq.example/openai/v1/', apiKey: 'gsk_test', model: 'llama-3.3-70b-versatile', budget: async () => ({ allowed: true }), price: { in: 0, out: 0 } });
  assert.deepEqual(await ai.json({ system: 's', user: 'u', operation: 'test' }), { ok: true });
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[1].response_format, undefined);
  assert.match(bodies[1].messages[0].content, /untrusted_source/);
  const denied = new OpenAiCompatAi({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5', budget: async () => ({ allowed: false, reason: 'cap' }), price: { in: 0, out: 0 } });
  await assert.rejects(denied.json({ system: 's', user: 'u', operation: 'x' }), /cap/);
  setFetch((...a) => fetch(...a));
});

test('Telegram: message rendering, update parsing, webhook secret check', async () => {
  const text = renderTemplate('pretrip_briefing', ['Tejash', 'Barcelona', 'SN3711 BRU 09:00 → BCN 11:05', 'NOT confirmed', '06:20', '07:05', '40 min (planning assumption)', 'Hotel Central', '12–18°C', '11:05 Arrive · 15:00 Check in', 'dinner: Teresa Carles']);
  assert.match(text, /Wake up 06:20, leave home 07:05/);
  assert.match(text, /\/stop/);
  assert.deepEqual(parseTelegramUpdates([{ update_id: 5, message: { chat: { id: 99 }, text: '/start abc' } }, { update_id: 6, edited_message: {} }]), [{ updateId: 5, chatId: '99', text: '/start abc' }]);
  const bot = new TelegramBot('123:abc', '@TravelCompassBot', 'secret-value');
  assert.equal(bot.botUsername(), 'TravelCompassBot');
  assert.equal(bot.verifyWebhook('secret-value'), true);
  assert.equal(bot.verifyWebhook('nope'), false);
  let sent: any;
  setFetch((async (u: any, init: any) => { sent = { u: String(u), b: JSON.parse(init.body) }; return json({ ok: true, result: { message_id: 77 } }); }) as typeof fetch);
  assert.deepEqual(await bot.sendText('99', 'hello'), { messageId: 'tg:99:77' });
  assert.equal(sent.u, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(sent.b.chat_id, '99');
  setFetch((...a) => fetch(...a));
});
