// Unit tests: holiday windows, idea ranking, Travel Explore parsing, booking links, Brevo email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveDaysNeeded, pickWindowsToPrice, scoreIdeas, travelWindows } from '../../src/server/domain/windows.ts';
import { normaliseExplore } from '../../src/server/integrations/serpapi.ts';
import { carLinks, flightLinks, stayLinks, transportLink } from '../../src/server/services/bookAll.ts';
import { BrevoMailer, chooseMailer, emailHtml, parseFrom, ResendMailer } from '../../src/server/integrations/messaging.ts';
import { setFetch } from '../../src/server/integrations/http.ts';

const BE_2027 = [
  { date: '2027-03-29', name: 'Easter Monday' },
  { date: '2027-05-01', name: 'Labour Day' },          // Saturday
  { date: '2027-05-06', name: 'Ascension Day' },       // Thursday
  { date: '2027-05-17', name: 'Whit Monday' },
];
const LW_2027 = [
  { startDate: '2027-03-27', endDate: '2027-03-29', dayCount: 3, needBridgeDay: false },
  { startDate: '2027-05-06', endDate: '2027-05-09', dayCount: 4, needBridgeDay: true },
  { startDate: '2027-05-15', endDate: '2027-05-17', dayCount: 3, needBridgeDay: false },
];

test('leave days skip weekends and public holidays', () => {
  const hol = new Set(['2027-05-06']);
  assert.equal(leaveDaysNeeded('2027-05-06', '2027-05-09', hol), 1, 'Thu holiday, Fri bridge, Sat, Sun → 1 leave day');
  assert.equal(leaveDaysNeeded('2027-03-27', '2027-03-29', new Set(['2027-03-29'])), 0);
});

test('travel windows: long weekends labelled with holidays, holiday weeks, sorted by date, inside range', () => {
  const w = travelWindows({ from: '2027-02-04', until: '2027-06-30', holidays: BE_2027, longWeekends: LW_2027 });
  const easter = w.find((x) => x.id === '2027-03-27_2027-03-29')!;
  assert.equal(easter.kind, 'long_weekend'); assert.equal(easter.nights, 2); assert.equal(easter.leaveDays, 0);
  assert.match(easter.label, /Easter Monday long weekend/);
  const asc = w.find((x) => x.id === '2027-05-06_2027-05-09')!;
  assert.equal(asc.leaveDays, 1); assert.equal(asc.needsBridgeDay, true);
  const week = w.find((x) => x.kind === 'holiday_week' && x.holidays.includes('Ascension Day'))!;
  assert.equal(week.start, '2027-05-01'); assert.equal(week.end, '2027-05-09'); assert.equal(week.nights, 8);
  assert.equal(week.leaveDays, 4, 'Mon–Fri minus the Thursday holiday');
  assert.deepEqual(w.map((x) => x.start), [...w.map((x) => x.start)].sort());
  assert.ok(w.every((x) => x.start >= '2027-02-04' && x.end <= '2027-06-30'));
});

test('travel windows fall back to weekends when a country has no holiday data', () => {
  const w = travelWindows({ from: '2027-02-03', until: '2027-04-30', holidays: [], longWeekends: [] });
  assert.ok(w.length >= 4);
  assert.ok(w.every((x) => x.kind === 'weekend' && new Date(`${x.start}T12:00:00Z`).getUTCDay() === 5 && x.nights === 2 && x.leaveDays === 0));
});

test('windows to price: fewest leave days per night, never overlapping, capped', () => {
  const w = travelWindows({ from: '2027-02-04', until: '2027-06-30', holidays: BE_2027, longWeekends: LW_2027 });
  const pick = pickWindowsToPrice(w, 3);
  assert.equal(pick.length, 3);
  for (let i = 0; i < pick.length; i++) for (let j = i + 1; j < pick.length; j++) assert.ok(pick[i].end <= pick[j].start || pick[j].end <= pick[i].start, 'no overlap');
  assert.ok(pick.every((x) => x.leaveDays <= 1));
});

test('idea scoring: estimated total, budget, weather and stops; cheapest good trip first', () => {
  const base = { windowId: 'w', nights: 3, flightMinutes: 150, stops: 0, weather: null };
  const r = scoreIdeas([
    { ...base, name: 'Lisbon', country: 'Portugal', iata: 'LIS', flightPrice: 95, hotelPerNight: 60, weather: { tempMaxC: 21, precipitationProbability: 10, kind: 'climate' } },
    { ...base, name: 'Oslo', country: 'Norway', iata: 'OSL', flightPrice: 80, hotelPerNight: 110, weather: { tempMaxC: 3, precipitationProbability: 70, kind: 'climate' } },
    { ...base, name: 'Dubai', country: 'UAE', iata: 'DXB', flightPrice: 500, hotelPerNight: 90, flightMinutes: 400, stops: 1 },
    { ...base, name: 'Nowhere', country: '', iata: 'NWH', flightPrice: null, hotelPerNight: 10 },
  ], 400, 'EUR');
  assert.equal(r.length, 3, 'unpriced ideas are dropped, never shown with a made-up price');
  assert.equal(r[0].idea.iata, 'LIS');
  assert.equal(r[0].total, 95 + 180);
  assert.equal(r[0].withinBudget, true);
  const dxb = r.find((x) => x.idea.iata === 'DXB')!;
  assert.equal(dxb.withinBudget, false); assert.ok(dxb.caveats.some((c) => /Over your EUR 400 budget/.test(c)));
  assert.ok(r.find((x) => x.idea.iata === 'OSL')!.caveats.some((c) => /Cold/.test(c)));
});

test('Google Travel Explore results are normalised; https-only links and thumbnails', () => {
  const d = normaliseExplore({ destinations: [
    { name: 'Lisbon', country: 'Portugal', destination_airport: { code: 'LIS' }, gps_coordinates: { latitude: 38.72, longitude: -9.14 }, flight_price: 95, hotel_price: 61, start_date: '2027-03-27', end_date: '2027-03-29', flight_duration: 170, number_of_stops: 0, airline: 'TAP', thumbnail: 'https://img.example/lis.jpg', link: 'https://www.google.com/travel/explore?x' },
    { name: 'Weird', country: '', destination_airport: { code: 'xx' }, thumbnail: 'javascript:alert(1)', link: 'http://insecure' },
  ] });
  assert.equal(d[0].iata, 'LIS'); assert.equal(d[0].flightPrice, 95); assert.equal(d[0].hotelPerNight, 61); assert.equal(d[0].flightMinutes, 170);
  assert.equal(d[1].iata, null); assert.equal(d[1].thumbnail, null); assert.equal(d[1].link, null); assert.equal(d[1].flightPrice, null);
});

test('booking links are prefilled https URLs for the exact dates and travellers', () => {
  const all = [...flightLinks('BRU', 'LIS', '2027-03-27', '2027-03-29', 2, 'Brussels'), ...stayLinks('Lisbon', '2027-03-27', '2027-03-29', 2), ...carLinks('LIS', 'Lisbon', '2027-03-27', '2027-03-29'), transportLink('Lisbon', 'Porto')];
  for (const l of all) assert.match(l.url, /^https:\/\//);
  assert.ok(all.find((l) => l.label === 'Skyscanner')!.url.includes('/bru/lis/270327/270329/'));
  assert.ok(all.find((l) => l.label === 'Kayak')!.url.includes('/flights/BRU-LIS/2027-03-27/2027-03-29/2adults'));
  const hostels = new URL(all.find((l) => l.label.startsWith('Hostels'))!.url);
  assert.equal(hostels.searchParams.get('checkin'), '2027-03-27'); assert.equal(hostels.searchParams.get('group_adults'), '2'); assert.equal(hostels.searchParams.get('nflt'), 'ht_id=203');
  assert.ok(all.find((l) => l.label === 'Airbnb')!.url.startsWith('https://www.airbnb.com/s/Lisbon/homes?'));
  assert.ok(all.find((l) => l.label === 'Kayak car rental')!.url.includes('/cars/LIS/2027-03-27/2027-03-29'));
});

test('Brevo sends real email from a verified sender; provider chosen by configuration', async () => {
  assert.deepEqual(parseFrom('Travel Compass <me@gmail.com>'), { name: 'Travel Compass', email: 'me@gmail.com' });
  assert.deepEqual(parseFrom('me@gmail.com'), { email: 'me@gmail.com' });
  const sent: any[] = [];
  setFetch((async (url: any, init: any) => { sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ messageId: '<1@brevo>' }), { status: 201, headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch);
  try {
    const m = new BrevoMailer('xkeysib-test', 'Travel Compass <me@gmail.com>');
    await m.send({ to: 'friend@example.com', subject: 'Verify your Travel Compass email', text: 'Verify your email: https://app.example/verify-email?token=abc' });
    assert.equal(sent[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(sent[0].headers['api-key'], 'xkeysib-test');
    assert.deepEqual(sent[0].body.sender, { name: 'Travel Compass', email: 'me@gmail.com' });
    assert.deepEqual(sent[0].body.to, [{ email: 'friend@example.com' }]);
    assert.match(sent[0].body.htmlContent, /href="https:\/\/app\.example\/verify-email\?token=abc"/);
  } finally { setFetch((...a) => fetch(...a)); }
  assert.ok(chooseMailer({ brevoKey: 'k', resendKey: 'r', from: 'a@b.c', devLog: false }) instanceof BrevoMailer, 'Brevo preferred when set');
  assert.ok(chooseMailer({ resendKey: 'r', from: 'a@b.c', devLog: false }) instanceof ResendMailer);
  assert.equal(chooseMailer({ from: 'a@b.c', devLog: false }).configured(), false, 'no provider and no log-only → not configured, so sign-up refuses instead of silently dropping mail');
  assert.ok(!emailHtml('<script>x</script> https://a.example/?q=1&b=2').includes('<script>'), 'email HTML is escaped');
});
