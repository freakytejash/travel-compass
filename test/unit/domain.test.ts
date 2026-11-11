import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fromLocal, toLocal, addDays, offsetMinutes } from '../../src/server/domain/time.ts';
import { rankFlights, compareReprice } from '../../src/server/domain/flights.ts';
import { generateDateCombos, computeComboCost, recommendFlex, combosForStayQuotes, planSearch } from '../../src/server/domain/flex.ts';
import { requiredNights, checkCoverage, rankStays } from '../../src/server/domain/stays.ts';
import { scheduleDay, windowsForDate, type DayInput, type Candidate, type MealCandidate } from '../../src/server/domain/itinerary.ts';
import { assessDish } from '../../src/server/domain/diet.ts';
import { computeDepartureTimeline, pretripSendAt, dailySendTimes, retryDelayMs } from '../../src/server/domain/reminders.ts';
import { extractReservation, dedupeKey, associateTrip, parseDates } from '../../src/server/domain/emailExtract.ts';
import { validateItems } from '../../src/server/domain/planQuality.ts';
import { offer, seg, slice, stay } from '../helpers/fixtures.ts';

describe('time zones and DST', () => {
  test('round trips local <-> UTC across DST start in Europe/Brussels', () => {
    assert.equal(fromLocal('2027-03-28T01:30', 'Europe/Brussels').toISOString(), '2027-03-28T00:30:00.000Z');
    assert.equal(fromLocal('2027-03-28T03:30', 'Europe/Brussels').toISOString(), '2027-03-28T01:30:00.000Z');
    // 02:30 does not exist on DST start day; we shift forward past the gap
    assert.equal(toLocal(fromLocal('2027-03-28T02:30', 'Europe/Brussels'), 'Europe/Brussels').slice(11, 16), '03:30');
  });
  test('ambiguous time at DST end resolves to the earlier instant', () => {
    assert.equal(fromLocal('2027-10-31T02:30', 'Europe/Brussels').toISOString(), '2027-10-31T00:30:00.000Z');
  });
  test('offsets and date arithmetic', () => {
    assert.equal(offsetMinutes(new Date('2027-07-01T12:00:00Z'), 'Asia/Kolkata'), 330);
    assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  });
});

describe('flight ranking', () => {
  const ctx = { needsCheckedBag: true, checkedBagEstimate: 40, valueOfTimePerHour: 15, airportTransferCost: {}, airportTransferMinutes: {}, currency: 'EUR' };
  const direct = offer('direct', 210, [slice([seg('BRU', 'BCN', '2027-03-10T09:00', '2027-03-10T11:05', 'Europe/Brussels', 'Europe/Madrid', 'SN3711')]), slice([seg('BCN', 'BRU', '2027-03-14T12:00', '2027-03-14T14:05', 'Europe/Madrid', 'Europe/Brussels', 'SN3712')])], { baggage: { checkedBags: 1, carryOn: 1, source: 'provider' } });
  const cheapOvernight = offer('cheap', 150, [
    slice([seg('BRU', 'FRA', '2027-03-10T20:00', '2027-03-10T21:00', 'Europe/Brussels', 'Europe/Berlin', 'LH1'), seg('FRA', 'BCN', '2027-03-11T07:00', '2027-03-11T09:10', 'Europe/Berlin', 'Europe/Madrid', 'LH2')]),
    slice([seg('BCN', 'BRU', '2027-03-14T05:30', '2027-03-14T07:35', 'Europe/Madrid', 'Europe/Brussels', 'VY1')]),
  ]);
  test('selects recommended, cheapest and convenient from returned offers only', () => {
    const r = rankFlights([direct, cheapOvernight], ctx);
    assert.equal(r.cheapest?.offer.providerOfferId, 'cheap');
    assert.equal(r.recommended?.offer.providerOfferId, 'direct');
    assert.match(r.explanation.cheapest, /Lowest price among the 2 offers retrieved/);
    assert.match(r.explanation.recommended, /more than the lowest fare/);
    assert.ok(r.cheapest!.flags.some((f) => f.includes('Overnight layover')));
    assert.ok(r.cheapest!.flags.some((f) => f.includes('Very early departure')));
  });
  test('expired offers and currency mismatches are excluded', () => {
    const expired = offer('old', 50, direct.slices, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const usd = offer('usd', 60, direct.slices, { total: { amount: 60, currency: 'USD' } });
    const r = rankFlights([expired, usd, direct], ctx);
    assert.equal(r.consideredCount, 1);
    assert.equal(r.excludedCount, 2);
  });
  test('reprice comparison', () => {
    assert.equal(compareReprice({ amount: 100, currency: 'EUR' }, { amount: 100.2, currency: 'EUR' }), 'unchanged');
    assert.equal(compareReprice({ amount: 100, currency: 'EUR' }, { amount: 120, currency: 'EUR' }), 'increased');
    assert.equal(compareReprice({ amount: 100, currency: 'EUR' }, null), 'unavailable');
  });
});

describe('flexible dates', () => {
  test('±3 days yields independent outbound/return shifts within 7x7 windows', () => {
    const combos = generateDateCombos('2027-03-10', '2027-03-14', 3);
    const outs = new Set(combos.map((c) => c.outbound)); const ins = new Set(combos.map((c) => c.inbound));
    assert.equal(outs.size, 7); assert.equal(ins.size, 7);
    assert.ok(combos.some((c) => c.outShift === -2 && c.inShift === 1), 'independent shifts present');
    assert.deepEqual([combos[0].outShift, combos[0].inShift], [0, 0], 'original first');
    assert.ok(combos.every((c) => c.nights >= 1));
  });
  test('respects nights bounds and provider limits', () => {
    const combos = generateDateCombos('2027-03-10', '2027-03-14', 3, { minNights: 3, maxNights: 5 });
    assert.ok(combos.every((c) => c.nights >= 3 && c.nights <= 5));
    const { toCheck, skipped } = planSearch(combos, 10);
    assert.equal(toCheck.length, 10); assert.equal(skipped.length, combos.length - 10);
  });
  test('complete-cost ranking prefers total trip cost over cheapest flight', () => {
    const combos = generateDateCombos('2027-03-10', '2027-03-14', 1);
    const orig = combos.find((c) => c.outShift === 0 && c.inShift === 0)!;
    const longer = combos.find((c) => c.outShift === -1 && c.inShift === 1)!; // 6 nights, cheap flight
    const shorter = combos.find((c) => c.outShift === 1 && c.inShift === 0)!; // 3 nights
    const ex = { transfers: [{ label: 'Airport transfers (estimate)', amount: 30, kind: 'estimate' as const }], interCity: [], fees: [] };
    const costs = [
      computeComboCost(orig, { amount: 200, offerId: 'a' }, [{ stopName: 'Barcelona', amount: 400, offerId: 's1', nights: 4 }], ex),
      computeComboCost(longer, { amount: 120, offerId: 'b' }, [{ stopName: 'Barcelona', amount: 600, offerId: 's2', nights: 6 }], ex),
      computeComboCost(shorter, { amount: 180, offerId: 'c' }, [{ stopName: 'Barcelona', amount: 300, offerId: 's3', nights: 3 }], ex),
      computeComboCost(combos.find((c) => c.outShift === 0 && c.inShift === 1)!, { amount: 90, offerId: 'd' }, null, ex),
    ];
    const r = recommendFlex(costs, [], []);
    assert.equal(r.recommended?.flight?.offerId, 'c');
    assert.equal(r.savings, 120);
    assert.ok(r.tradeOffs.some((t) => t.includes('Trip length changes from 4 to 3')));
    assert.ok(r.tradeOffs.some((t) => t.includes('could not be fully costed')));
    assert.ok(r.coverage.notes.some((n) => n.includes('no accommodation quotes')));
  });
  test('stay quotes requested for original plus cheapest flight combos', () => {
    const combos = generateDateCombos('2027-03-10', '2027-03-14', 1);
    const priced = combos.map((c, i) => ({ combo: c, flight: 300 - i * 10 }));
    const pick = combosForStayQuotes(priced, 3);
    assert.equal(pick.length, 3);
    assert.equal(pick[0].outShift, 0); assert.equal(pick[0].inShift, 0);
  });
});

describe('accommodation coverage', () => {
  const stops = [
    { stopId: 'a', name: 'Lisbon', arriveDate: '2027-05-01', departDate: '2027-05-04', arrivalTime: '01:30' },
    { stopId: 'b', name: 'Porto', arriveDate: '2027-05-04', departDate: '2027-05-07', overnightTransportNights: ['2027-05-06'] },
  ];
  test('every required night across stops, minus overnight transport', () => {
    const { nights, advice } = requiredNights(stops);
    assert.deepEqual(nights.map((n) => n.date), ['2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05']);
    assert.ok(advice[0].message.includes('2027-04-30'));
  });
  test('detects gaps, overlaps and wrong-stop bookings', () => {
    const { nights } = requiredNights(stops);
    const ok = checkCoverage(nights, [{ id: 'h1', stopId: 'a', checkIn: '2027-05-01', checkOut: '2027-05-04' }, { id: 'h2', stopId: 'b', checkIn: '2027-05-04', checkOut: '2027-05-06' }]);
    assert.equal(ok.ok, true);
    const bad = checkCoverage(nights, [{ id: 'h1', stopId: 'a', checkIn: '2027-05-01', checkOut: '2027-05-03' }, { id: 'h2', stopId: 'b', checkIn: '2027-05-02', checkOut: '2027-05-06' }]);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.gaps.map((g) => g.date), []);
    assert.ok(bad.overlaps.some((o) => o.date === '2027-05-02'));
    assert.ok(bad.wrongStop.some((w) => w.date === '2027-05-03'));
    const gap = checkCoverage(nights, [{ id: 'h1', stopId: 'a', checkIn: '2027-05-01', checkOut: '2027-05-03' }]);
    assert.deepEqual(gap.gaps.map((g) => g.date), ['2027-05-03', '2027-05-04', '2027-05-05']);
  });
  test('ranking respects dorm/private preference and total value', () => {
    const ctx = { preference: 'private' as const, occupancy: 2, currency: 'EUR', activityCentre: { lat: 41.39, lng: 2.17 }, transportHub: null, valueOfTimePerHour: 15, localTransportCostPerKm: 0.5 };
    const r = rankStays([
      stay('dorm', 90, { roomKind: 'dorm' }),
      stay('far', 280, { lat: 41.47, lng: 2.08, reviewScore: 7.5 }),
      stay('central', 300, { reviewScore: 8.7 }),
      stay('lux', 420, { reviewScore: 9.4, rating: 5 }),
    ], ctx);
    assert.equal(r.excluded, 1);
    assert.equal(r.cheapest?.stay.providerOfferId, 'far');
    assert.equal(r.recommended?.stay.providerOfferId, 'central');
    assert.equal(r.comfortable?.stay.providerOfferId, 'lux');
  });
});

function venue(name: string, lat = 41.39, lng = 2.17) {
  return { name, address: `${name} street 1`, lat, lng, mapsUrl: 'https://maps.example/' + encodeURIComponent(name) };
}
const src = [{ url: 'https://example.org/src', title: 'src', provider: 'test', retrievedAt: '2027-01-01T00:00:00Z' }];
function cand(key: string, extra: Partial<Candidate> = {}): Candidate {
  return { key, kind: 'activity', title: key, venue: venue(key), durationMinutes: 120, outdoor: false, openWindows: [{ open: 600, close: 1080 }], bookingRequired: 'no', why: 'fits', uncertainty: '', sources: src, retrievedAt: '2027-01-01T00:00:00Z', ...extra };
}
function meal(m: MealCandidate['meal'], name: string, windows: MealCandidate['openWindows'] = [{ open: 420, close: 1380 }]): MealCandidate {
  return { meal: m, venue: venue(name), openWindows: windows, bookingRequired: 'no', why: 'vegetarian menu', uncertainty: '', sources: src, retrievedAt: '2027-01-01T00:00:00Z' };
}
function day(extra: Partial<DayInput> = {}): DayInput {
  return { date: '2027-03-11', timeZone: 'Europe/Madrid', pace: 'moderate', wakeTime: '07:30', prepMinutes: 45, base: { lat: 41.39, lng: 2.17, name: 'Hotel' },
    candidates: [cand('Museum A'), cand('Gallery B')], indoorAlternatives: [], meals: [meal('breakfast', 'Cafe X'), meal('lunch', 'Veg Lunch'), meal('dinner', 'Veg Dinner')], weather: null, ...extra };
}

describe('daily itinerary scheduling', () => {
  test('full day includes wake, breakfast, activities, lunch, dinner in order', () => {
    const r = scheduleDay(day());
    const kinds = r.items.map((i) => i.kind);
    assert.ok(kinds.indexOf('wake') < kinds.indexOf('breakfast'));
    assert.ok(kinds.includes('lunch') && kinds.includes('dinner'));
    assert.equal(r.missing.length, 0);
    const lunch = r.items.find((i) => i.kind === 'lunch')!;
    assert.ok(lunch.startLocal.slice(11) >= '12:00' && lunch.startLocal.slice(11) <= '14:30');
  });
  test('arrival day has no programme before landing', () => {
    const r = scheduleDay(day({ availableFrom: '14:10', arrivalNote: 'Arrive BCN 12:55, transfer to city' }));
    assert.ok(r.items.every((i) => i.startLocal.slice(11) >= '14:10'));
    assert.ok(!r.items.some((i) => i.kind === 'breakfast' || i.kind === 'wake'));
  });
  test('departure day protects airport buffer', () => {
    const r = scheduleDay(day({ availableUntil: '13:00', departureNote: 'Leave for BCN airport', checkOut: { time: '11:00', venue: null, title: 'Check out' } }));
    for (const it of r.items) if (it.kind !== 'travel') assert.ok(it.endLocal.slice(11) <= '13:00', `${it.title} ends ${it.endLocal}`);
    assert.ok(!r.items.some((i) => i.kind === 'dinner'));
  });
  test('very early departure moves wake-up and checkout before leaving', () => {
    const r = scheduleDay(day({ availableUntil: '03:00', departureNote: 'Leave for airport', checkOut: { time: '11:00', venue: null, title: 'Check out' } }));
    for (const it of r.items) if (it.kind !== 'travel') assert.ok(it.endLocal.slice(11) <= '03:00', `${it.kind} ${it.startLocal}-${it.endLocal}`);
    assert.ok(r.items.some((i) => i.kind === 'wake') && r.items.some((i) => i.kind === 'checkout'));
  });
  test('closed venues are not scheduled; weather swaps outdoor hike for indoor alternative', () => {
    const hike = cand('Ridge Trail', { kind: 'hike', outdoor: true, durationMinutes: 240, openWindows: [{ open: 0, close: 1440 }] });
    const r = scheduleDay(day({
      candidates: [cand('Closed Museum', { openWindows: [] }), hike],
      indoorAlternatives: [cand('Science Museum')],
      weather: { kind: 'forecast', precipitationProbability: 80, windMaxKmh: 20, tempMaxC: 14, tempMinC: 8, sunrise: '07:40', sunset: '18:50' },
    }));
    assert.ok(!r.items.some((i) => i.title === 'Closed Museum'));
    assert.ok(!r.items.some((i) => i.title === 'Ridge Trail'));
    assert.ok(r.items.some((i) => i.title === 'Science Museum'));
    assert.ok(r.notes.some((n) => n.includes('80% chance')));
  });
  test('hike must finish before sunset with margin', () => {
    const hike = cand('Long Hike', { kind: 'hike', outdoor: true, durationMinutes: 600, openWindows: null });
    const r = scheduleDay(day({ candidates: [hike], weather: { kind: 'forecast', precipitationProbability: 10, windMaxKmh: 10, tempMaxC: 15, tempMinC: 5, sunrise: '07:40', sunset: '17:30' } }));
    assert.ok(!r.items.some((i) => i.title === 'Long Hike'));
  });
  test('missing meal venues are reported, never filled with placeholders', () => {
    const r = scheduleDay(day({ meals: [meal('breakfast', 'Cafe X')] }));
    assert.ok(r.missing.some((m) => m.startsWith('lunch')));
    assert.ok(r.missing.some((m) => m.startsWith('dinner')));
    assert.deepEqual(validateItems(r.items), []);
  });
  test('parses opening hours', () => {
    const w = windowsForDate(['Monday: 9:00 AM – 5:00 PM', 'Tuesday: Closed', 'Wednesday: 11:00 AM – 2:30 PM, 6:00 – 11:00 PM', 'Thursday: Open 24 hours'], '2027-03-10');
    assert.deepEqual(w, [{ open: 660, close: 870 }, { open: 1080, close: 1380 }]);
    assert.deepEqual(windowsForDate(['Tuesday: Closed'], '2027-03-09'), []);
    assert.equal(windowsForDate(null, '2027-03-09'), null);
  });
});

describe('vegetarian assessment', () => {
  test('name alone is never enough', () => {
    assert.equal(assessDish({ name: 'Tomato soup', sourceText: 'Seasonal tomatoes, cream' }, 'vegetarian').status, 'uncertain');
  });
  test('hidden animal ingredients and traditional risks', () => {
    assert.equal(assessDish({ name: 'Vegetable pad thai', sourceText: 'rice noodles, tofu, fish sauce', labelled: 'vegetarian', sourceUrl: 'x' }, 'vegetarian').status, 'not_suitable');
    assert.equal(assessDish({ name: 'Mushroom risotto', sourceText: 'arborio rice, porcini', labelled: 'vegetarian', sourceUrl: 'https://m' }, 'vegetarian').status, 'likely');
    assert.equal(assessDish({ name: 'French onion soup', sourceText: 'onions, gruyère' }, 'vegetarian').status, 'uncertain');
    assert.equal(assessDish({ name: 'Caesar salad', sourceText: 'romaine, anchovy dressing' }, 'vegetarian').status, 'not_suitable');
  });
  test('negations and explicit labels', () => {
    assert.equal(assessDish({ name: 'Falafel wrap', sourceText: 'chickpeas, tahini (V)', labelled: 'vegan', sourceUrl: 'https://menu' }, 'vegan').status, 'confirmed');
    assert.equal(assessDish({ name: 'Som tam jay', sourceText: 'papaya salad without fish sauce', labelled: 'vegan', sourceUrl: 'https://menu' }, 'vegan').status, 'likely');
    assert.equal(assessDish({ name: 'Cheese toastie', sourceText: 'cheddar, bread', labelled: 'vegetarian', sourceUrl: 'https://m' }, 'vegan').status, 'not_suitable');
  });
});

describe('reminders', () => {
  test('departure timeline from flight time, buffer, transfer and prep', () => {
    const t = computeDepartureTimeline({ departUtc: '2027-03-10T08:00:00Z', airportTz: 'Europe/Brussels', homeTz: 'Europe/Brussels', international: false, checkedBag: true, checkedIn: false, transferMinutes: 35, transferSource: 'planning_assumption', prepMinutes: 45 });
    assert.equal(t.arriveAirportLocal, '2027-03-10T07:15');
    assert.equal(t.leaveHomeLocal, '2027-03-10T06:40');
    assert.equal(t.wakeLocal, '2027-03-10T05:55');
    assert.ok(t.explanation[1].includes('planning assumption'));
  });
  test('pre-trip briefing is the day before at preferred local time', () => {
    const r = pretripSendAt('2027-03-10T08:00:00Z', 'Europe/Brussels', '18:00', new Date('2027-03-01T00:00:00Z'));
    assert.equal(r.at.toISOString(), '2027-03-09T17:00:00.000Z');
    const late = pretripSendAt('2027-03-10T20:00:00Z', 'Europe/Brussels', '18:00', new Date('2027-03-10T10:00:00Z'));
    assert.equal(late.late, true);
    assert.equal(late.at.toISOString(), '2027-03-10T10:00:00.000Z');
  });
  test('daily schedule send time follows the local time zone of each day', () => {
    const r = dailySendTimes([{ date: '2027-03-11', timeZone: 'Europe/Madrid' }, { date: '2027-03-12', timeZone: 'Asia/Tokyo' }], '07:30', new Date('2027-01-01'));
    assert.equal(r[0].at.toISOString(), '2027-03-11T06:30:00.000Z');
    assert.equal(r[1].at.toISOString(), '2027-03-11T22:30:00.000Z');
  });
  test('retry backoff grows and is capped', () => {
    assert.ok(retryDelayMs(1, 1000, 10000, () => 1) === 1000);
    assert.ok(retryDelayMs(10, 1000, 10000, () => 1) === 10000);
  });
});

describe('email extraction', () => {
  const flightEmail = { id: 'm1', from: 'Brussels Airlines <noreply@brusselsairlines.com>', subject: 'Your booking confirmation', date: '2027-01-05T10:00:00Z',
    text: 'Thank you. Booking reference: X7KQ2L\nSN3711 Brussels (BRU) → Barcelona (BCN) 10 March 2027 09:00\nSN3712 BCN → BRU 14 March 2027' };
  test('extracts flight reservation with code, flights and dates', () => {
    const r = extractReservation(flightEmail)!;
    assert.equal(r.kind, 'flight');
    assert.equal(r.confirmationCode, 'X7KQ2L');
    assert.deepEqual(r.details.flightNumbers, ['SN3711', 'SN3712']);
    assert.equal(r.startDate, '2027-03-10');
    assert.equal(r.details.checkInMentioned, false);
    assert.ok(r.confidence >= 0.7);
  });
  test('extracts stay and deduplicates repeated confirmations', () => {
    const e1 = { id: 'm2', from: 'Booking.com <customer.service@booking.com>', subject: 'Your booking at Hotel Arts is confirmed', date: '2027-01-06T10:00:00Z', text: 'Confirmation number: 4021133398\nCheck-in: Wed 10 Mar 2027 from 15:00\nCheck-out: Sun 14 Mar 2027 until 11:00\n2 guests' };
    const e2 = { ...e1, id: 'm3', subject: 'Reminder: your booking at Hotel Arts' };
    const a = extractReservation(e1)!; const b = extractReservation(e2)!;
    assert.equal(a.kind, 'stay');
    assert.equal(a.startDate, '2027-03-10'); assert.equal(a.endDate, '2027-03-14');
    assert.equal(dedupeKey(a), dedupeKey(b));
  });
  test('ignores marketing and associates trips by date', () => {
    assert.equal(extractReservation({ id: 'x', from: 'deals@x.com', subject: '50% off sale ends today', date: '', text: 'book now' }), null);
    assert.equal(associateTrip({ startDate: '2027-03-10', endDate: null }, [{ id: 't1', startDate: '2027-03-10', endDate: '2027-03-14' }, { id: 't2', startDate: '2027-06-01', endDate: '2027-06-05' }]), 't1');
    assert.deepEqual(parseDates('on 2027-03-10 and March 12, 2027'), ['2027-03-10', '2027-03-12']);
  });
});

describe('plan quality guard', () => {
  test('flags placeholder content from the old prototype', () => {
    const bad = [{ kind: 'lunch' as const, startLocal: '2027-03-11T12:00', endLocal: '2027-03-11T13:00', title: 'Find a vegetarian lunch spot', venue: null, why: '', bookingRequired: 'unknown' as const, uncertainty: '', sources: [], retrievedAt: null },
      { kind: 'activity' as const, startLocal: '2027-03-11T14:00', endLocal: '2027-03-11T16:00', title: 'Venue needs current research', venue: null, why: '', bookingRequired: 'unknown' as const, uncertainty: '', sources: [], retrievedAt: null }];
    const issues = validateItems(bad);
    assert.ok(issues.length >= 3);
  });
});
