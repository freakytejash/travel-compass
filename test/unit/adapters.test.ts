// Adapter contract tests against documented provider response shapes (NOT live calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDurationMinutes, normaliseDuffelOffer, normaliseDuffelStay, DuffelFlights } from '../../src/server/integrations/duffel.ts';
import { normalisePlace, parseGmailMessage } from '../../src/server/integrations/google.ts';
import { parseWhatsAppStatuses, WhatsAppCloud } from '../../src/server/integrations/messaging.ts';
import { isPrivateAddress } from '../../src/server/integrations/research.ts';
import { extractJson } from '../../src/server/integrations/ai.ts';
import { requestJson, setFetch, mapLimit, NotConfiguredError } from '../../src/server/integrations/http.ts';
import { integrationReadiness, loadConfig } from '../../src/server/config.ts';
import crypto from 'node:crypto';

test('Duffel offer normalisation: overnight flight across time zones', () => {
  const o = normaliseDuffelOffer({
    id: 'off_1', expires_at: '2027-03-01T10:00:00Z', total_amount: '612.40', total_currency: 'EUR', tax_amount: '88.10', tax_currency: 'EUR', owner: { name: 'Air India' },
    conditions: { refund_before_departure: { allowed: false }, change_before_departure: { allowed: true, penalty_amount: '75.00', penalty_currency: 'EUR' } },
    payment_requirements: { requires_instant_payment: false, price_guarantee_expires_at: '2027-03-02T10:00:00Z' },
    slices: [{ duration: 'PT10H55M', segments: [{ departing_at: '2027-03-10T21:30:00', arriving_at: '2027-03-11T10:55:00', origin: { iata_code: 'BRU', time_zone: 'Europe/Brussels' }, destination: { iata_code: 'DEL', time_zone: 'Asia/Kolkata' }, marketing_carrier: { iata_code: 'AI', name: 'Air India' }, marketing_carrier_flight_number: '146', passengers: [{ baggages: [{ type: 'checked', quantity: 2 }, { type: 'carry_on', quantity: 1 }] }] }] }],
  });
  const s = o.slices[0].segments[0];
  assert.equal(s.flightNumber, 'AI146');
  assert.equal(s.departUtc, '2027-03-10T20:30:00.000Z');
  assert.equal(s.arriveUtc, '2027-03-11T05:25:00.000Z');
  assert.equal(o.slices[0].durationMinutes, 655);
  assert.equal(o.baggage.checkedBags, 2);
  assert.equal(o.conditions.refundable, false);
  assert.deepEqual(o.conditions.changePenalty, { amount: 75, currency: 'EUR' });
  assert.equal(isoDurationMinutes('P1DT2H5M'), 1565);
});

test('Duffel stay normalisation derives free-cancellation date and dorm rooms', () => {
  const [a, b] = normaliseDuffelStay({ accommodation: { name: 'Casa', rating: 3, review_score: 8.8, location: { address: { line_one: 'Rua 1', city_name: 'Porto', postal_code: '4000', country_code: 'PT' }, geographic_coordinates: { latitude: 41.15, longitude: -8.61 } },
    rooms: [{ name: 'Bed in 8-bed dorm', rates: [{ id: 'rat_1', total_amount: '90.00', total_currency: 'EUR', tax_amount: '6.00', tax_currency: 'EUR', payment_type: 'pay_now', board_type: 'room_only', cancellation_timeline: [{ before: '2027-04-01T00:00:00Z', refund_amount: '90.00' }] }] },
      { name: 'Double room', rates: [{ id: 'rat_2', total_amount: '210.00', total_currency: 'EUR', cancellation_timeline: [] }] }] } }, { checkIn: '2027-04-04', checkOut: '2027-04-07', adults: 1 }, 'now');
  assert.equal(a.roomKind, 'dorm'); assert.equal(a.cancellation.freeUntil, '2027-04-01T00:00:00Z'); assert.equal(a.nights, 3);
  assert.equal(b.roomKind, 'private'); assert.equal(b.cancellation.refundable, false);
});

test('Duffel request headers and unconfigured behaviour', async () => {
  let seen: any;
  setFetch((async (url: any, init: any) => { seen = { url: String(url), init }; return new Response(JSON.stringify({ data: [] }), { status: 200 }); }) as typeof fetch);
  await new DuffelFlights('duffel_test_x').searchPlaces('bru');
  assert.equal(seen.init.headers['Duffel-Version'], 'v2');
  assert.equal(seen.init.headers.Authorization, 'Bearer duffel_test_x');
  await assert.rejects(new DuffelFlights(undefined).searchPlaces('x'), NotConfiguredError);
  setFetch((...a) => fetch(...a));
});

test('HTTP client retries transient errors with bounded attempts', async () => {
  let n = 0;
  setFetch((async () => { n++; return new Response(n < 3 ? 'busy' : '{}', { status: n < 3 ? 503 : 200 }); }) as typeof fetch);
  await requestJson('https://x.example', { provider: 't', operation: 'o', retries: 2 });
  assert.equal(n, 3);
  n = 0;
  setFetch((async () => { n++; return new Response('nope', { status: 503 }); }) as typeof fetch);
  await assert.rejects(requestJson('https://x.example', { provider: 't', operation: 'o', retries: 1 }));
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(requestJson('https://x.example', { provider: 't', operation: 'o', method: 'POST', body: {} }));
  assert.equal(n, 1, 'non-idempotent POST is not retried');
  setFetch((...a) => fetch(...a));
  let active = 0; let peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; });
  assert.equal(peak, 3, 'bounded concurrency');
});

test('Google Places normalisation and Gmail parsing', () => {
  const p = normalisePlace({ id: 'ChIJ1', displayName: { text: 'Flax & Kale' }, formattedAddress: 'C/ Tallers 74', location: { latitude: 41.38, longitude: 2.16 }, googleMapsUri: 'https://maps.google.com/?cid=1', servesVegetarianFood: true, regularOpeningHours: { weekdayDescriptions: ['Monday: 9:00 AM – 11:00 PM'] }, priceRange: { startPrice: {} } });
  assert.equal(p.name, 'Flax & Kale'); assert.equal(p.servesVegetarianFood, true); assert.deepEqual(p.weekdayDescriptions, ['Monday: 9:00 AM – 11:00 PM']);
  const m = parseGmailMessage({ id: 'x', internalDate: '0', payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'a@b' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Booking ref: <b>ABC123</b></p><style>x{}</style>').toString('base64url') } }] } });
  assert.match(m.text, /Booking ref:\s+ABC123/);
});

test('WhatsApp webhook parsing and signature verification', () => {
  const s = parseWhatsAppStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1' }, { id: 'wamid.2', status: 'weird', timestamp: '1' }] } }] }] });
  assert.deepEqual(s.map((x) => x.id), ['wamid.1']);
  const w = new WhatsAppCloud('t', 'p', 'app-secret', 'v23.0');
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
  assert.equal(w.verifySignature(body, sig), true);
  assert.equal(w.verifySignature(body, 'sha256=' + '0'.repeat(64)), false);
  assert.equal(w.verifySignature(body, undefined), false);
});

test('SSRF guard and AI JSON extraction', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":[1,{"b":"}"}]}\n```'), { a: [1, { b: '}' }] });
});

test('integration readiness never reports unconfigured services as configured', () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/DUFFEL|GOOGLE|WHATSAPP|RESEND|ANTHROPIC|BRAVE|BOOKING|OPEN_METEO/.test(k)) delete process.env[k];
  process.env.NODE_ENV = 'production';
  const r = integrationReadiness(loadConfig());
  const keyless = ['database', 'encryption', 'geo_free', 'osm', 'wikimedia', 'callmebot']; // free services that need no credentials
  assert.ok(r.filter((x) => !keyless.includes(x.key)).every((x) => x.status === 'awaiting_credentials' || x.key === 'email' && x.status !== 'configured'), JSON.stringify(r.map((x) => [x.key, x.status])));
  Object.assign(process.env, saved);
});
