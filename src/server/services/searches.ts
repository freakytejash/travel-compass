// Live searches (flights, stays, flexible dates, destination ideas). Run as background jobs; results persisted.
import crypto from 'node:crypto';
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/pg.ts';
import { HttpError } from '../http/core.ts';
import { rankFlights, type FlightRankContext } from '../domain/flights.ts';
import { checkCoverage, rankStays, requiredNights, type StopWindow } from '../domain/stays.ts';
import { combosForStayQuotes, computeComboCost, generateDateCombos, planSearch, recommendFlex, type ComboCost, type CostLine, type DateCombo } from '../domain/flex.ts';
import { rankDestinations, type DestinationEvidence } from '../domain/destinations.ts';
import { addDays, daysBetween, haversineKm } from '../domain/time.ts';
import { mapLimit, NotConfiguredError, QuotaExceededError, explainFailure } from '../integrations/http.ts';
import type { StayProvider } from '../integrations/types.ts';
import type { FlightOffer, Place, StayOption } from '../../shared/types.ts';
import { getProfile, type Profile } from './profile.ts';
import { getOwnedTrip, getStops, type Stop, type Trip } from './trips.ts';

export type SearchKind = 'flight' | 'stay' | 'flex' | 'destinations';

export async function startSearch(ctx: AppContext, userId: string, tripId: string, kind: SearchKind, params: Record<string, unknown> = {}) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  preflight(trip, await getStops(ctx.db, tripId), kind);
  return ctx.db.tx(async (q) => {
    const r = await q.query<{ id: string }>(`INSERT INTO searches(trip_id, kind, status, params) VALUES ($1,$2,'running',$3) RETURNING id`, [tripId, kind, params]);
    const id = r.rows[0].id;
    await ctx.jobs.enqueue(`search.${kind}`, { searchId: id, userId, tripId }, { q, maxAttempts: 2, dedupeKey: `search:${id}` });
    return id;
  });
}

function preflight(trip: Trip, stops: Stop[], kind: SearchKind) {
  const need = (cond: unknown, msg: string) => { if (!cond) throw new HttpError(400, 'trip_incomplete', msg); };
  if (kind === 'destinations') { need(trip.origin, 'Choose where you are travelling from first.'); need(trip.startDate && trip.endDate, 'Choose your travel dates first.'); return; }
  need(trip.startDate && trip.endDate, 'Choose your travel dates first.');
  need(stops.length, 'Add at least one destination.');
  if (kind === 'flight' || kind === 'flex') need(trip.origin, 'Choose where you are travelling from.');
  if (kind === 'flex') need(trip.flexDays > 0, 'Set date flexibility (±1 to ±3 days) to compare dates.');
}

export async function getSearch(ctx: AppContext, userId: string, searchId: string) {
  const r = await ctx.db.query<any>('SELECT s.* FROM searches s JOIN trips t ON t.id=s.trip_id WHERE s.id=$1 AND t.user_id=$2', [searchId, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Search not found');
  const s = r.rows[0];
  const offers = (await ctx.db.query<any>('SELECT * FROM offers WHERE search_id=$1 ORDER BY role NULLS LAST, total_amount', [searchId])).rows;
  return { id: s.id, kind: s.kind, status: s.status, params: s.params, result: s.result, error: s.error, createdAt: s.created_at, finishedAt: s.finished_at,
    offers: offers.map((o) => ({ id: o.id, kind: o.kind, stopId: o.stop_id, provider: o.provider, data: o.data, total: { amount: Number(o.total_amount), currency: o.currency }, quotedAt: o.quoted_at, expiresAt: o.expires_at, role: o.role, explanation: o.explanation, selected: o.selected })) };
}

async function finish(db: Queryable, searchId: string, status: 'complete' | 'partial' | 'failed', result: unknown, error: string | null = null) {
  await db.query('UPDATE searches SET status=$2, result=$3, error=$4, finished_at=now() WHERE id=$1', [searchId, status, result ?? null, error]);
}

export async function failSearch(ctx: AppContext, searchId: string, e: Error) {
  const msg = explainFailure(e);
  await finish(ctx.db, searchId, 'failed', null, msg);
}

// ---------------------------------------------------------------- helpers
function airportOf(p: Place | null | undefined): string | null {
  if (!p) return null;
  if (p.iata && p.kind === 'airport') return p.iata;
  return p.airports?.[0]?.iata ?? p.iata ?? null;
}

export interface OriginAirport { iata: string; name: string; lat: number | null; lng: number | null; km: number | null }

/**
 * Departure airports to search: the chosen origin (and its airports), the traveller's saved departure airports and,
 * when the flight source can search several airports at once, every other sizeable airport within NEARBY_AIRPORT_KM
 * of home. The ranking then adds the cost and time of getting to each airport, so a cheaper fare from a farther
 * airport only wins when it is cheaper overall.
 */
export async function originAirports(ctx: AppContext, trip: Pick<Trip, 'origin'>, profile: Pick<Profile, 'departureAirports' | 'homePlace'>): Promise<OriginAirport[]> {
  const fl = ctx.providers.flights;
  const max = fl.multiAirport ? ctx.cfg.limits.maxOriginAirports : 3;
  const home = trip.origin ?? profile.homePlace ?? null;
  const list = new Map<string, OriginAirport>();
  const add = (iata: string, name: string, lat: number | null, lng: number | null) => {
    if (!iata || list.has(iata)) return;
    list.set(iata, { iata, name, lat, lng, km: home && lat !== null && lng !== null ? Math.round(haversineKm(home, { lat, lng })) : null });
  };
  const o = airportOf(trip.origin);
  if (o) { const c = airportCoords(trip.origin, o); add(o, trip.origin!.kind === 'airport' ? trip.origin!.name : trip.origin!.airports?.find((a) => a.iata === o)?.name ?? o, c?.lat ?? null, c?.lng ?? null); }
  if (trip.origin?.kind === 'city') for (const a of trip.origin.airports ?? []) add(a.iata, a.name, a.lat, a.lng);
  for (const a of profile.departureAirports ?? []) {
    const info = fl.airportInfo ? await fl.airportInfo(a.iata).catch(() => null) : null;
    add(a.iata, a.name, info?.lat ?? null, info?.lng ?? null);
  }
  // Also when an airport was picked: a cheaper airport nearby may still win once the transfer is priced in.
  if (fl.multiAirport && fl.nearbyAirports && home) {
    for (const a of await fl.nearbyAirports(home.lat, home.lng, ctx.cfg.limits.nearbyAirportKm, max + 2).catch(() => [])) add(a.iata, a.name, a.lat, a.lng);
  }
  return [...list.values()].slice(0, max);
}

/** Comma-joined origin when the provider can search several airports at once; otherwise the closest airport. */
function originParam(ctx: AppContext, airports: OriginAirport[]): string | undefined {
  return ctx.providers.flights.multiAirport ? airports.map((a) => a.iata).join(',') : airports[0]?.iata;
}

function airportCoords(p: Place | null | undefined, iata: string) {
  if (!p) return null;
  const a = p.airports?.find((x) => x.iata === iata);
  if (a) return { lat: a.lat, lng: a.lng };
  return p.kind === 'airport' && p.iata === iata ? { lat: p.lat, lng: p.lng } : null;
}

async function rankContext(ctx: AppContext, trip: Trip, stops: Stop[], profile: Profile, airports: OriginAirport[]): Promise<{ rc: FlightRankContext; notes: string[] }> {
  const notes: string[] = [];
  const cost: Record<string, number> = {}; const minutes: Record<string, number> = {};
  const home = profile.homePlace ?? trip.origin;
  for (const a of airports) {
    if (!home || a.lat === null || a.lng === null) continue;
    const ac = { lat: a.lat, lng: a.lng };
    const km = haversineKm(home, ac) * 1.3;
    let mins = Math.round(15 + (km / 60) * 60);
    if (ctx.providers.routes.configured()) {
      try { mins = (await ctx.providers.routes.travelMinutes(home, ac, new Date(`${trip.startDate}T06:00:00Z`), 'DRIVE')).minutes; }
      catch { notes.push(`Transfer time to ${a.iata} is a planning estimate (route service unavailable).`); }
    }
    minutes[a.iata] = mins; cost[a.iata] = Math.round(km * 0.25 * 2);
  }
  const dest = stops[0]?.place; const last = stops[stops.length - 1]?.place;
  for (const p of [dest, last]) {
    if (!p) continue;
    for (const ap of p.airports ?? []) {
      const km = haversineKm(p, ap) * 1.3;
      minutes[ap.iata] = Math.round(15 + (km / 35) * 60); cost[ap.iata] = Math.round(Math.max(5, km * 0.2) * 2);
    }
  }
  notes.push('Ground-transfer costs are planning estimates (about €0.25/km by car to departure airports; public-transport level at the destination), not quotes.');
  return { rc: { needsCheckedBag: profile.checkedBag, checkedBagEstimate: 45, valueOfTimePerHour: profile.valueOfTimePerHour, airportTransferCost: cost, airportTransferMinutes: minutes, currency: trip.currency }, notes };
}

async function searchFlightsAcross(ctx: AppContext, userId: string, origins: string[], dest: string, back: string, out: string, inb: string, adults: number, currency: string) {
  // One search for all airports when the provider supports it (saves the free monthly allowance).
  const groups = ctx.providers.flights.multiAirport ? [origins.join(',')] : origins;
  const results = await mapLimit(groups, ctx.cfg.limits.providerConcurrency, (o) => ctx.providers.flights.searchOffers({
    slices: [{ origin: o, destination: dest, departureDate: out }, { origin: back, destination: o, departureDate: inb }], adults, currency, userId,
  }));
  const offers: FlightOffer[] = []; const failed: string[] = []; let lastErr: Error | null = null;
  results.forEach((r, i) => { if (r.ok) offers.push(...r.value.offers); else { failed.push(groups[i]); lastErr = r.error; } });
  if (!offers.length && lastErr) throw lastErr;
  return { offers, failed };
}

/** Explains which airport won and how far the others are. */
function airportChoiceNote(airports: OriginAirport[], best: FlightOffer | undefined, rc: FlightRankContext): string | null {
  if (airports.length < 2) return null;
  const list = airports.map((a) => `${a.iata}${a.km !== null ? ` (${a.km} km)` : ''}`).join(', ');
  const from = best?.slices[0]?.from;
  const won = airports.find((a) => a.iata === from);
  return `Searched ${airports.length} airports near you: ${list}.${won ? ` Best overall leaves from ${won.iata}${won.km !== null ? `, ${won.km} km away` : ''}${rc.airportTransferCost[won.iata] !== undefined ? ` (about ${rc.currency} ${rc.airportTransferCost[won.iata]} to get there and back, included in the comparison)` : ''}.` : ''}`;
}

async function storeOffers(q: Queryable, tripId: string, searchId: string, kind: 'flight' | 'stay', stopId: string | null, items: { provider: string; providerOfferId: string; data: unknown; total: { amount: number; currency: string }; quotedAt: string; expiresAt: string | null; role: string | null; explanation: string }[]) {
  for (const it of items) {
    await q.query(`INSERT INTO offers(trip_id, kind, stop_id, search_id, provider, provider_offer_id, data, total_amount, currency, quoted_at, expires_at, role, explanation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tripId, kind, stopId, searchId, it.provider, it.providerOfferId, it.data, it.total.amount, it.total.currency, it.quotedAt, it.expiresAt, it.role, it.explanation]);
  }
}

// ---------------------------------------------------------------- flights
export async function runFlightSearch(ctx: AppContext, searchId: string, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  const airports = await originAirports(ctx, trip, profile);
  const origins = airports.map((a) => a.iata);
  const dest = airportOf(stops[0].place); const back = airportOf(stops[stops.length - 1].place);
  if (!origins.length || !dest || !back) return finish(ctx.db, searchId, 'failed', null, 'An airport could not be determined for the origin or destination. Choose a city with an airport or a specific airport.');
  const { offers, failed } = await searchFlightsAcross(ctx, userId, origins, dest, back, trip.startDate!, trip.endDate!, trip.adults, trip.currency);
  const { rc, notes } = await rankContext(ctx, trip, stops, profile, airports);
  const complete = offers.filter((o) => !o.incomplete);
  const ranked = rankFlights(complete.length ? complete : offers, rc, ctx.now());
  if (complete.length < offers.length) notes.push(`${offers.length - complete.length} more outbound options are shown at their lowest round-trip price; the return flight is chosen when you select one.`);
  if (offers.some((o) => o.provider === 'serpapi')) notes.push('Prices come from Google Flights at search time. Baggage and fare rules are not reported by this source — check them with the seller before paying.');
  const choice = airportChoiceNote(airports, ranked.recommended?.offer, rc);
  if (choice) notes.unshift(choice);
  if (failed.length && !ctx.providers.flights.multiAirport) notes.push(`Searches from ${failed.join(', ')} failed; results cover ${origins.filter((o) => !failed.includes(o)).join(', ')} only.`);
  if (stops.length > 1) notes.push('Travel between your destinations is not included in these fares.');
  const roleOf = new Map<FlightOffer, string>();
  if (ranked.cheapest) roleOf.set(ranked.cheapest.offer, 'cheapest');
  if (ranked.convenient) roleOf.set(ranked.convenient.offer, 'convenient');
  if (ranked.recommended) roleOf.set(ranked.recommended.offer, 'recommended');
  const scoredByOffer = new Map([ranked.recommended, ranked.cheapest, ranked.convenient].filter(Boolean).map((s) => [s!.offer, s!]));
  const keep = [...offers].sort((a, b) => a.total.amount - b.total.amount).slice(0, 25);
  for (const o of roleOf.keys()) if (!keep.includes(o)) keep.push(o);
  await ctx.db.tx(async (q) => {
    await storeOffers(q, tripId, searchId, 'flight', null, keep.map((o) => {
      const role = roleOf.get(o) ?? null;
      const s = scoredByOffer.get(o);
      return { provider: o.provider, providerOfferId: o.providerOfferId, data: { offer: o, scoring: s ? { effectiveCost: s.effectiveCost, components: s.components, flags: s.flags } : null }, total: o.total, quotedAt: o.quotedAt, expiresAt: o.expiresAt, role,
        explanation: role === 'recommended' ? ranked.explanation.recommended : role === 'cheapest' ? ranked.explanation.cheapest : role === 'convenient' ? ranked.explanation.convenient ?? '' : '' };
    }));
    // Clear roles from older searches so the trip shows the current shortlist only.
    await q.query(`UPDATE offers SET role=NULL WHERE trip_id=$1 AND kind='flight' AND search_id<>$2 AND NOT selected`, [tripId, searchId]);
    await finish(q, searchId, ranked.recommended ? (failed.length ? 'partial' : 'complete') : 'failed',
      { considered: ranked.consideredCount, excluded: ranked.excludedCount, excludedReasons: ranked.excludedReasons.slice(0, 10), origins, airports, notes },
      ranked.recommended ? null : 'No bookable offers were returned for these dates. Try other dates or airports.');
  });
}

// ---------------------------------------------------------------- stays
function stopWindows(stops: Stop[], arrivalTime: string | null): StopWindow[] {
  return stops.map((s, i) => ({ stopId: s.id, name: s.place.name, arriveDate: s.arriveDate, departDate: s.departDate, arrivalTime: i === 0 ? arrivalTime : null }));
}

async function selectedFlight(db: Queryable, tripId: string): Promise<FlightOffer | null> {
  const r = await db.query<any>(`SELECT data FROM offers WHERE trip_id=$1 AND kind='flight' AND selected ORDER BY quoted_at DESC LIMIT 1`, [tripId]);
  return r.rows[0]?.data?.offer ?? null;
}

async function searchStaysForWindow(ctx: AppContext, userId: string, stop: Stop, checkIn: string, checkOut: string, adults: number, currency: string) {
  const providers = ctx.providers.stays.filter((p) => p.configured());
  if (!providers.length) throw new NotConfiguredError('Accommodation providers', ['DUFFEL_STAYS_ENABLED or BOOKING_DEMAND_API_TOKEN']);
  const res = await mapLimit(providers, 2, (p: StayProvider) => p.search({ lat: stop.place.lat, lng: stop.place.lng, radiusKm: 5, checkIn, checkOut, adults, rooms: 1, currency, userId, placeName: stop.place.cityName ?? stop.place.name.replace(/\s*\([A-Z]{3}\)$/, '') }));
  const options: StayOption[] = []; const failed: string[] = [];
  res.forEach((r, i) => (r.ok ? options.push(...r.value) : failed.push(providers[i].name)));
  if (!options.length && failed.length === providers.length) throw (res.find((r) => !r.ok) as { error: Error }).error;
  return { options, failed };
}

function airbnbExternalLink(stop: Stop, checkIn: string, checkOut: string, adults: number) {
  const q = new URLSearchParams({ checkin: checkIn, checkout: checkOut, adults: String(adults) });
  return `https://www.airbnb.com/s/${encodeURIComponent(stop.place.cityName ?? stop.place.name)}/homes?${q}`;
}

export async function runStaySearch(ctx: AppContext, searchId: string, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  const flight = await selectedFlight(ctx.db, tripId);
  const arrivalLocal = flight?.slices[0]?.segments.at(-1)?.arriveLocal ?? null;
  const windows = stopWindows(stops, arrivalLocal && arrivalLocal.slice(0, 10) === stops[0].arriveDate ? arrivalLocal.slice(11, 16) : null);
  const { nights, advice } = requiredNights(windows);
  const perStop: any[] = []; let anyFailed = false;
  const chosen: { id: string; stopId: string; checkIn: string; checkOut: string }[] = [];
  for (const stop of stops) {
    if (stop.departDate <= stop.arriveDate) continue;
    const entry: any = { stopId: stop.id, stopName: stop.place.name, checkIn: stop.arriveDate, checkOut: stop.departDate, nights: daysBetween(stop.arriveDate, stop.departDate),
      externalOptions: [{ provider: 'Airbnb', url: airbnbExternalLink(stop, stop.arriveDate, stop.departDate, trip.adults), note: 'External search only: Travel Compass has no authorised Airbnb live inventory, so no Airbnb listings or prices are shown here.' }] };
    try {
      const { options, failed } = await searchStaysForWindow(ctx, userId, stop, stop.arriveDate, stop.departDate, trip.adults, trip.currency);
      if (failed.length) { anyFailed = true; entry.failedProviders = failed; }
      const centre = await activityCentre(ctx.db, tripId, stop);
      const ranked = rankStays(options, { preference: profile.accommodationPref, occupancy: trip.adults, currency: trip.currency, activityCentre: centre, transportHub: stop.place.airports?.[0] ?? null, valueOfTimePerHour: profile.valueOfTimePerHour, localTransportCostPerKm: 0.5 }, ctx.now());
      entry.considered = ranked.considered; entry.excluded = ranked.excluded;
      const roles = new Map<StayOption, string>();
      if (ranked.cheapest) roles.set(ranked.cheapest.stay, 'cheapest');
      if (ranked.comfortable) roles.set(ranked.comfortable.stay, 'comfortable');
      if (ranked.recommended) roles.set(ranked.recommended.stay, 'recommended');
      const notesFor = new Map([ranked.recommended, ranked.cheapest, ranked.comfortable].filter(Boolean).map((s) => [s!.stay, s!]));
      const keep = [...options].sort((a, b) => a.total.amount - b.total.amount).slice(0, 20);
      for (const o of roles.keys()) if (!keep.includes(o)) keep.push(o);
      await storeOffers(ctx.db, tripId, searchId, 'stay', stop.id, keep.map((o) => {
        const s = notesFor.get(o); const role = roles.get(o) ?? null;
        const why = role === 'recommended' ? `Best total value among ${ranked.considered} suitable options returned: ${o.total.currency} ${o.total.amount.toFixed(2)} for ${o.nights} nights. ${s?.notes.join(' ') ?? ''}`
          : role === 'cheapest' ? `Cheapest suitable stay among the options returned. ${s?.notes.join(' ') ?? ''}` : role === 'comfortable' ? `Higher-rated alternative. ${s?.notes.join(' ') ?? ''}` : '';
        return { provider: o.provider, providerOfferId: o.providerOfferId, data: { stay: o, distanceToActivitiesKm: s?.distanceToActivitiesKm ?? null }, total: o.total, quotedAt: o.quotedAt, expiresAt: o.expiresAt, role, explanation: why.trim() };
      }));
      if (ranked.recommended) chosen.push({ id: ranked.recommended.stay.providerOfferId, stopId: stop.id, checkIn: stop.arriveDate, checkOut: stop.departDate });
      else entry.error = ranked.considered === 0 && options.length ? 'Options were returned but none matched your room preference and occupancy.' : 'No availability was returned for these dates.';
    } catch (e) {
      anyFailed = true;
      entry.error = explainFailure(e, 'The accommodation service did not respond. Please retry.');
    }
    perStop.push(entry);
  }
  await ctx.db.query(`UPDATE offers SET role=NULL WHERE trip_id=$1 AND kind='stay' AND search_id<>$2 AND NOT selected`, [tripId, searchId]);
  const coverage = checkCoverage(nights, chosen);
  const ok = perStop.every((p) => !p.error);
  await finish(ctx.db, searchId, ok && !anyFailed ? 'complete' : chosen.length ? 'partial' : 'failed', { perStop, coverage, advice, requiredNights: nights.length }, ok ? null : 'Some destinations have no recommended stay yet.');
}

async function activityCentre(db: Queryable, tripId: string, stop: Stop) {
  const r = await db.query<any>(`SELECT i.venue FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE d.trip_id=$1 AND d.stop_id=$2 AND i.kind IN ('activity','hike','lunch','dinner') AND i.venue IS NOT NULL`, [tripId, stop.id]);
  const pts = r.rows.map((x) => x.venue).filter((v) => typeof v?.lat === 'number');
  if (!pts.length) return { lat: stop.place.lat, lng: stop.place.lng };
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
}

// ---------------------------------------------------------------- flexible dates
export async function runFlexSearch(ctx: AppContext, searchId: string, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  const airports = await originAirports(ctx, trip, profile);
  const origin = originParam(ctx, airports);
  const dest = airportOf(stops[0].place); const back = airportOf(stops[stops.length - 1].place);
  if (!origin || !dest || !back) return finish(ctx.db, searchId, 'failed', null, 'An airport could not be determined for the origin or destination.');
  const today = ctx.now().toISOString().slice(0, 10);
  const firstStopNights = daysBetween(stops[0].arriveDate, stops[0].departDate);
  const lastStopNights = daysBetween(stops[stops.length - 1].arriveDate, stops[stops.length - 1].departDate);
  const combos = generateDateCombos(trip.startDate!, trip.endDate!, trip.flexDays, { earliest: addDays(today, 1) })
    // Multi-stop: shifts change only the first and last stays; each must keep at least one night.
    .filter((c) => stops.length === 1 || (firstStopNights - c.outShift >= 1 && lastStopNights + c.inShift >= 1));
  const { toCheck, skipped } = planSearch(combos, ctx.cfg.limits.flexMaxCombos);
  const { rc } = await rankContext(ctx, trip, stops, profile, airports);
  const flightRes = await mapLimit(toCheck, ctx.cfg.limits.providerConcurrency, async (c) => {
    const key = `flex:${origin}:${dest}:${back}:${c.outbound}:${c.inbound}:${trip.adults}:${trip.currency}`;
    const cached = await cacheGet<FlightOffer[]>(ctx, key);
    const offers = cached ?? (await ctx.providers.flights.searchOffers({ slices: [{ origin, destination: dest, departureDate: c.outbound }, { origin: back, destination: origin, departureDate: c.inbound }], adults: trip.adults, currency: trip.currency, userId, depth: 'quick' })).offers;
    if (!cached) await cacheSet(ctx, key, offers, 10);
    const ranked = rankFlights(offers, rc, ctx.now());
    return ranked.recommended ? { amount: ranked.recommended.offer.total.amount, offerId: ranked.recommended.offer.providerOfferId, offer: ranked.recommended.offer } : null;
  });
  const failed: DateCombo[] = []; const priced: { combo: DateCombo; flight: number; offerId: string; offer: FlightOffer }[] = [];
  flightRes.forEach((r, i) => { if (r.ok && r.value) priced.push({ combo: toCheck[i], flight: r.value.amount, offerId: r.value.offerId, offer: r.value.offer }); else failed.push(toCheck[i]); });
  if (!priced.length) return finish(ctx.db, searchId, 'failed', { coverage: { checked: 0, skipped: skipped.length, failed: failed.length } }, 'No flight offers could be retrieved for the flexible date range.');

  const stayCombos = combosForStayQuotes(priced, ctx.cfg.limits.flexStayQuoteCombos);
  const stayAmounts = new Map<DateCombo, { stopName: string; amount: number; offerId: string; nights: number }[] | null>();
  const staysConfigured = ctx.providers.stays.some((p) => p.configured());
  if (staysConfigured) {
    const res = await mapLimit(stayCombos, 2, async (c) => {
      const lines: { stopName: string; amount: number; offerId: string; nights: number }[] = [];
      for (const [i, s] of stops.entries()) {
        const checkIn = i === 0 ? c.outbound : s.arriveDate;
        const checkOut = i === stops.length - 1 ? c.inbound : s.departDate;
        if (checkOut <= checkIn) continue;
        const { options } = await searchStaysForWindow(ctx, userId, s, checkIn, checkOut, trip.adults, trip.currency);
        const ranked = rankStays(options, { preference: profile.accommodationPref, occupancy: trip.adults, currency: trip.currency, activityCentre: { lat: s.place.lat, lng: s.place.lng }, transportHub: null, valueOfTimePerHour: profile.valueOfTimePerHour, localTransportCostPerKm: 0.5 }, ctx.now());
        if (!ranked.recommended) return null;
        lines.push({ stopName: s.place.name, amount: ranked.recommended.stay.total.amount, offerId: ranked.recommended.stay.providerOfferId, nights: daysBetween(checkIn, checkOut) });
      }
      return lines;
    });
    res.forEach((r, i) => stayAmounts.set(stayCombos[i], r.ok ? r.value : null));
  }
  // Transfers: to whichever home airport the combination's flight uses, plus destination airports.
  const transfersFor = (offer: FlightOffer): CostLine[] => [...new Set([offer.slices[0]?.from, dest, back])].filter((a): a is string => !!a && rc.airportTransferCost[a] !== undefined)
    .map((a) => ({ label: `Ground transfers ${a} (planning estimate)`, amount: rc.airportTransferCost[a], kind: 'estimate' }));
  const costs: ComboCost[] = priced.map((p) => computeComboCost(p.combo, { amount: p.flight, offerId: p.offerId }, stayAmounts.get(p.combo) ?? null, { transfers: transfersFor(p.offer), interCity: [], fees: [] }));
  const rec = recommendFlex(costs, skipped, failed);
  if (!staysConfigured) rec.coverage.notes.push('Accommodation quotes are unavailable, so complete trip costs cannot be compared yet; only flight prices are shown.');
  const status = rec.recommended ? (failed.length || skipped.length ? 'partial' : 'complete') : 'partial';
  await finish(ctx.db, searchId, status, {
    origin, dest, back,
    combos: costs.map((c) => ({ ...c, combo: c.combo })),
    recommendation: rec.recommended ? { combo: rec.recommended.combo, total: rec.recommended.total, lines: rec.recommended.lines } : null,
    original: rec.original ? { combo: rec.original.combo, total: rec.original.total, lines: rec.original.lines, complete: rec.original.complete } : null,
    savings: rec.savings, savingsSupportedByQuotes: rec.savingsSupportedByQuotes, tradeOffs: rec.tradeOffs, coverage: rec.coverage,
    skipped: skipped.map((c) => `${c.outbound}→${c.inbound}`), failed: failed.map((c) => `${c.outbound}→${c.inbound}`),
  }, rec.recommended ? null : 'Complete trip costs could not be compared; see coverage notes.');
}

async function cacheGet<T>(ctx: AppContext, key: string): Promise<T | null> {
  const r = await ctx.db.query<{ value: T }>('SELECT value FROM provider_cache WHERE key=$1 AND expires_at > $2', [crypto.createHash('sha256').update(key).digest('hex'), ctx.now()]);
  return r.rows[0]?.value ?? null;
}
async function cacheSet(ctx: AppContext, key: string, value: unknown, ttlMin: number) {
  await ctx.db.query('INSERT INTO provider_cache(key, value, expires_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at',
    [crypto.createHash('sha256').update(key).digest('hex'), JSON.stringify(value), new Date(ctx.now().getTime() + ttlMin * 60000)]);
}

// ---------------------------------------------------------------- destination ideas
interface AiDestination { city: string; country: string; iata: string; interestTags: string[]; rationale: string }

export async function runDestinationSearch(ctx: AppContext, searchId: string, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const profile = await getProfile(ctx, userId);
  const airports = await originAirports(ctx, trip, profile);
  const origin = originParam(ctx, airports);
  if (!origin) return finish(ctx.db, searchId, 'failed', null, 'Choose an origin with an airport.');
  const nights = daysBetween(trip.startDate!, trip.endDate!);
  // Preferred: Google Travel Explore — ONE search, real flight + hotel prices from all nearby airports, no AI needed.
  if (ctx.providers.explore?.configured()) return exploreDestinations(ctx, searchId, userId, trip, profile, airports, nights);
  const ideas = await ctx.providers.ai.json<{ destinations: AiDestination[] }>({
    operation: 'destinations.ideas', userId, maxTokens: 1500,
    system: 'You suggest travel destinations. Output only real cities served by commercial airports. Do not state prices, weather or opening facts; those are verified separately.',
    user: JSON.stringify({ task: 'Suggest 8 diverse destinations (cities) for this traveller. Return {"destinations":[{"city","country","iata" (main airport IATA code),"interestTags" (subset of the traveller interests that genuinely fit),"rationale" (one sentence about fit, no prices/weather)}]}',
      origin: trip.origin?.name, originAirport: origin, startDate: trip.startDate, nights, interests: profile.interests, pace: profile.pace, hiking: profile.hikingExperience, diet: profile.diet, budgetTotal: trip.budgetTotal, currency: trip.currency }),
  });
  const candidates = (ideas.destinations ?? []).filter((d) => /^[A-Z]{3}$/.test(d.iata) && !airports.some((a) => a.iata === d.iata)).slice(0, ctx.cfg.limits.destinationCandidates);
  const verified = await mapLimit(candidates, ctx.cfg.limits.providerConcurrency, async (d): Promise<DestinationEvidence | null> => {
    const places = await ctx.providers.flights.searchPlaces(d.iata);
    const place = places.find((p) => p.iata === d.iata) ?? places.find((p) => p.airports?.some((a) => a.iata === d.iata));
    if (!place) return null; // AI suggestion could not be verified against the airport database
    const fl = await ctx.providers.flights.searchOffers({ slices: [{ origin, destination: d.iata, departureDate: trip.startDate! }, { origin: d.iata, destination: origin, departureDate: trip.endDate! }], adults: trip.adults, currency: trip.currency, userId, depth: 'quick' }).catch(() => null);
    const cheapest = fl?.offers.filter((o) => o.total.currency === trip.currency).sort((a, b) => a.total.amount - b.total.amount)[0] ?? null;
    let stay: DestinationEvidence['stay'] = null;
    if (ctx.providers.stays.some((p) => p.configured())) {
      const s = await searchStaysForWindow(ctx, userId, { id: 'x', position: 0, place, arriveDate: trip.startDate!, departDate: trip.endDate! }, trip.startDate!, trip.endDate!, trip.adults, trip.currency).catch(() => null);
      const r = s ? rankStays(s.options, { preference: profile.accommodationPref, occupancy: trip.adults, currency: trip.currency, activityCentre: place, transportHub: null, valueOfTimePerHour: profile.valueOfTimePerHour, localTransportCostPerKm: 0.5 }, ctx.now()) : null;
      if (r?.recommended) stay = { amount: r.recommended.stay.total.amount, currency: trip.currency, nights };
    }
    let weather: DestinationEvidence['weather'] = null;
    if (ctx.providers.weather.configured() && place.timeZone) {
      const dates = [trip.startDate!, addDays(trip.startDate!, Math.floor(nights / 2)), trip.endDate!];
      const w = await ctx.providers.weather.forDates(place.lat, place.lng, dates, place.timeZone).catch(() => ({} as Record<string, any>));
      const vals = Object.values(w);
      if (vals.length) {
        const avg = (k: 'tempMaxC' | 'precipitationProbability') => { const xs = vals.map((x: any) => x[k]).filter((x: any) => x !== null); return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null; };
        weather = { kind: vals.every((x: any) => x.kind === 'forecast') ? 'forecast' : 'climate', tempMaxC: avg('tempMaxC'), precipitationProbability: avg('precipitationProbability'), periodLabel: `${trip.startDate} – ${trip.endDate}` };
      }
    }
    return { place: { ...place, name: `${d.city}, ${d.country}` }, aiRationale: d.rationale, interestTags: d.interestTags ?? [], flight: cheapest ? { amount: cheapest.total.amount, currency: cheapest.total.currency, travelMinutes: cheapest.slices.reduce((s, x) => s + x.durationMinutes, 0), offerId: cheapest.providerOfferId } : null, stay, weather };
  });
  const evidence = verified.filter((r) => r.ok && r.value).map((r) => (r as { ok: true; value: DestinationEvidence }).value);
  const ranked = rankDestinations(evidence, trip.budgetTotal, profile.interests);
  await finish(ctx.db, searchId, ranked.length ? 'complete' : 'failed', {
    destinations: ranked.map((r) => ({ place: r.evidence.place, score: r.score, total: r.total, withinBudget: r.withinBudget, reasons: r.reasons, caveats: r.caveats, flight: r.evidence.flight, stay: r.evidence.stay, weather: r.evidence.weather })),
    note: 'Ideas are suggested by AI and then checked against live flight, accommodation and weather data. Prices are the lowest among offers retrieved at search time.',
    unverified: candidates.length - evidence.length,
  }, ranked.length ? null : 'No destination could be verified with live data.');
}

async function exploreDestinations(ctx: AppContext, searchId: string, userId: string, trip: Trip, profile: Profile, airports: OriginAirport[], nights: number) {
  const { resolveDestination } = await import('./ideas.ts');
  const r = await ctx.providers.explore!.explore({ departureIds: airports.map((a) => a.iata), outboundDate: trip.startDate!, returnDate: trip.endDate!, currency: trip.currency, adults: trip.adults, userId });
  const cands = r.destinations.filter((d) => d.iata && d.flightPrice !== null && !airports.some((a) => a.iata === d.iata))
    .sort((a, b) => (a.flightPrice! + (a.hotelPerNight ?? 0) * nights) - (b.flightPrice! + (b.hotelPerNight ?? 0) * nights)).slice(0, 10);
  const evidence = (await mapLimit(cands, 3, async (d): Promise<DestinationEvidence | null> => {
    const place = await resolveDestination(ctx, { name: d.name, iata: d.iata!, lat: d.lat, lng: d.lng });
    if (!place) return null;
    let weather: DestinationEvidence['weather'] = null;
    if (ctx.providers.weather.configured()) {
      const dates = [trip.startDate!, addDays(trip.startDate!, Math.floor(nights / 2)), trip.endDate!];
      const w = await ctx.providers.weather.forDates(place.lat, place.lng, dates, place.timeZone ?? 'auto').catch(() => ({} as Record<string, any>));
      const vals = Object.values(w) as any[];
      if (vals.length) {
        const avg = (k: string) => { const xs = vals.map((x) => x[k]).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null; };
        weather = { kind: vals.every((x) => x.kind === 'forecast') ? 'forecast' : 'climate', tempMaxC: avg('tempMaxC'), precipitationProbability: avg('precipitationProbability'), periodLabel: `${trip.startDate} – ${trip.endDate}` };
      }
    }
    return { place: { ...place, name: `${d.name}${d.country ? `, ${d.country}` : ''}` }, aiRationale: `${d.stops === 0 ? 'Direct flights' : 'Flights'}${d.airline ? ` with ${d.airline}` : ''}${d.flightMinutes ? ` (${Math.round(d.flightMinutes / 6) / 10} h)` : ''} from ${airports.map((a) => a.iata).join('/')}.`,
      interestTags: [], flight: { amount: d.flightPrice!, currency: trip.currency, travelMinutes: d.flightMinutes ?? 0, offerId: `explore:${d.iata}` },
      stay: d.hotelPerNight !== null ? { amount: Math.round(d.hotelPerNight * nights), currency: trip.currency, nights } : null, weather };
  })).filter((x) => x.ok && x.value).map((x) => (x as { ok: true; value: DestinationEvidence }).value);
  const ranked = rankDestinations(evidence, trip.budgetTotal, profile.interests);
  await finish(ctx.db, searchId, ranked.length ? 'complete' : 'failed', {
    destinations: ranked.map((x) => ({ place: x.evidence.place, score: x.score, total: x.total, withinBudget: x.withinBudget, reasons: x.reasons, caveats: x.caveats, flight: x.evidence.flight, stay: x.evidence.stay, weather: x.evidence.weather })),
    note: `Cheapest destinations for your dates from Google Travel Explore (one search covering ${airports.map((a) => a.iata).join(', ')}). Flight prices are round-trip from-prices; stay = Google's hotel from-price × ${nights} night${nights > 1 ? 's' : ''}. Pick one to get exact flights and hotels.`,
    unverified: cands.length - evidence.length,
  }, ranked.length ? null : 'No destinations with prices were returned for these dates. Try other dates or a nearby bigger airport.');
}
