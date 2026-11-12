// Trip ideas: "when and where should I go?"
// 1. Date windows from the traveller's public holidays and long weekends (Nager.Date, free).
// 2. For the best few windows, one Google Travel Explore search each from ALL airports near home (SerpApi):
//    cheapest destinations with a round-trip flight price and a hotel from-price.
// 3. Weather for the strongest candidates (Open-Meteo), then ranking by estimated total cost, travel time and weather.
// Choosing an idea creates a trip and immediately starts the flight, stay and itinerary searches.
import type { AppContext } from '../context.ts';
import { recordError } from '../context.ts';
import { HttpError } from '../http/core.ts';
import { addDays, daysBetween } from '../domain/time.ts';
import { pickWindowsToPrice, scoreIdeas, travelWindows, type IdeaCandidate, type TravelWindow } from '../domain/windows.ts';
import { mapLimit, NotConfiguredError, QuotaExceededError, explainFailure } from '../integrations/http.ts';
import type { Place } from '../../shared/types.ts';
import { getProfile } from './profile.ts';
import { originAirports } from './searches.ts';
import * as trips from './trips.ts';
import * as searches from './searches.ts';
import * as planning from './planning.ts';

export interface IdeaParams { origin: Place; country: string; months: number; adults: number; budget: number | null; currency: string; windowIds?: string[] }

/** Holiday-aware travel windows for a country (public: costs no paid searches). */
export async function windowsFor(ctx: AppContext, country: string, months: number) {
  const today = ctx.now().toISOString().slice(0, 10);
  const from = addDays(today, 3); const until = addDays(today, Math.round(months * 30.5));
  const years = [...new Set([Number(from.slice(0, 4)), Number(until.slice(0, 4))])];
  const h = ctx.providers.holidays;
  const holidays = h ? (await Promise.all(years.map((y) => h.publicHolidays(y, country).catch(() => [])))).flat() : [];
  const longWeekends = h ? (await Promise.all(years.map((y) => h.longWeekends(y, country).catch(() => [])))).flat() : [];
  const windows = travelWindows({ from, until, holidays, longWeekends, minCount: 4 });
  return {
    country: country.toUpperCase(), windows,
    upcomingHolidays: holidays.filter((x) => x.global !== false && x.date >= today && x.date <= until).map((x) => ({ date: x.date, name: x.name, localName: x.localName })),
    source: holidays.length ? { name: 'Nager.Date public holidays', url: `https://date.nager.at/PublicHoliday/Country/${country.toUpperCase()}` } : null,
    note: holidays.length ? 'Leave days count weekdays that are not public holidays. Regional holidays are not included.' : 'No public-holiday data for this country, so plain weekends are shown.',
  };
}

export async function startIdeas(ctx: AppContext, userId: string, p: Omit<IdeaParams, 'country'> & { country?: string }) {
  if (!ctx.providers.explore?.configured()) throw new NotConfiguredError('Trip ideas with live prices', ['SERPAPI_API_KEY']);
  const country = (p.country ?? p.origin.countryCode ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'invalid_input', 'Choose a home city so we know which public holidays apply.');
  const params: IdeaParams = { ...p, country };
  const r = await ctx.db.query<{ id: string }>(`INSERT INTO trip_ideas(user_id, status, params) VALUES ($1,'running',$2) RETURNING id`, [userId, params]);
  await ctx.jobs.enqueue('ideas.run', { ideaId: r.rows[0].id, userId }, { maxAttempts: 2, dedupeKey: `ideas:${r.rows[0].id}` });
  return r.rows[0].id;
}

export async function getIdeas(ctx: AppContext, userId: string, id: string) {
  await searches.expireStale(ctx.db);
  const r = await ctx.db.query<any>('SELECT * FROM trip_ideas WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Trip ideas not found');
  const x = r.rows[0];
  return { id: x.id, status: x.status, params: x.params, result: x.result, error: x.error, chosenTripId: x.chosen_trip_id, createdAt: x.created_at, finishedAt: x.finished_at };
}

export async function latestIdeas(ctx: AppContext, userId: string) {
  const r = await ctx.db.query<any>(`SELECT id FROM trip_ideas WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  return r.rows.length ? getIdeas(ctx, userId, r.rows[0].id) : null;
}

async function finish(ctx: AppContext, id: string, status: 'complete' | 'partial' | 'failed', result: unknown, error: string | null) {
  await ctx.db.query('UPDATE trip_ideas SET status=$2, result=$3, error=$4, finished_at=now() WHERE id=$1', [id, status, result ?? null, error]);
}

export async function failIdeas(ctx: AppContext, id: string, e: Error) {
  await finish(ctx, id, 'failed', null, explainFailure(e));
}

interface Candidate extends IdeaCandidate { lat: number | null; lng: number | null; thumbnail: string | null; link: string | null; airline: string | null; window: TravelWindow }

export async function runIdeas(ctx: AppContext, id: string, userId: string) {
  const row = await getIdeas(ctx, userId, id);
  const p = row.params as IdeaParams;
  const profile = await getProfile(ctx, userId);
  const airports = await originAirports(ctx, { origin: p.origin }, { departureAirports: profile.departureAirports, homePlace: p.origin });
  if (!airports.length) return finish(ctx, id, 'failed', null, 'No airport was found near your home city. Choose a bigger city or add a departure airport in your profile.');
  const { windows, source, note } = await windowsFor(ctx, p.country, p.months);
  const chosenWindows = p.windowIds?.length ? windows.filter((w) => p.windowIds!.includes(w.id)).slice(0, ctx.cfg.limits.ideaWindows) : pickWindowsToPrice(windows, ctx.cfg.limits.ideaWindows);
  if (!chosenWindows.length) return finish(ctx, id, 'failed', { windows }, 'No suitable dates were found in that period.');

  const explore = ctx.providers.explore!;
  const priced = await mapLimit(chosenWindows, 2, (w) => explore.explore({ departureIds: airports.map((a) => a.iata), outboundDate: w.start, returnDate: w.end, currency: p.currency, adults: p.adults, userId }));
  const cands: Candidate[] = []; const failedWindows: string[] = []; let lastErr: Error | null = null;
  priced.forEach((r, i) => {
    const w = chosenWindows[i];
    if (!r.ok) { failedWindows.push(w.label); lastErr = r.error; return; }
    for (const d of r.value.destinations) {
      if (!d.iata || airports.some((a) => a.iata === d.iata)) continue;
      cands.push({ windowId: w.id, window: w, name: d.name, country: d.country, iata: d.iata, flightPrice: d.flightPrice !== null ? d.flightPrice : null, hotelPerNight: d.hotelPerNight, nights: w.nights,
        flightMinutes: d.flightMinutes, stops: d.stops, lat: d.lat, lng: d.lng, thumbnail: d.thumbnail, link: d.link, airline: d.airline, weather: null });
    }
  });
  if (!cands.length) {
    if (lastErr) throw lastErr;
    return finish(ctx, id, 'failed', { windows, airports }, 'No destinations with prices were returned for these dates.');
  }
  // Weather for the cheapest few per window (free; forecast within ~15 days, otherwise historical climate).
  const pre = scoreIdeas(cands, p.budget, p.currency);
  const top = pre.slice(0, 24).map((s) => s.idea as Candidate);
  if (ctx.providers.weather.configured()) {
    await mapLimit(top.filter((c) => c.lat !== null && c.lng !== null).slice(0, 12), 3, async (c) => {
      const dates = [c.window.start, addDays(c.window.start, Math.floor(c.nights / 2)), c.window.end];
      const w = await ctx.providers.weather.forDates(c.lat!, c.lng!, dates, 'auto').catch(() => ({} as Record<string, any>));
      const vals = Object.values(w) as any[];
      if (!vals.length) return;
      const avg = (k: string) => { const xs = vals.map((x) => x[k]).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
      c.weather = { kind: vals.every((x) => x.kind === 'forecast') ? 'forecast' : 'climate', tempMaxC: avg('tempMaxC'), precipitationProbability: avg('precipitationProbability') };
    });
  }
  const ranked = scoreIdeas(top, p.budget, p.currency);
  // Keep variety: at most 3 ideas per window and one entry per destination per window.
  const perWindow = new Map<string, number>(); const seen = new Set<string>(); const ideas: any[] = [];
  for (const s of ranked) {
    const c = s.idea as Candidate; const key = `${c.windowId}:${c.iata}`;
    if (seen.has(key) || (perWindow.get(c.windowId) ?? 0) >= 4) continue;
    seen.add(key); perWindow.set(c.windowId, (perWindow.get(c.windowId) ?? 0) + 1);
    ideas.push({
      index: ideas.length, window: c.window, destination: { name: c.name, country: c.country, iata: c.iata, lat: c.lat, lng: c.lng, thumbnail: c.thumbnail },
      flight: { price: c.flightPrice, minutes: c.flightMinutes, stops: c.stops, airline: c.airline }, hotelPerNight: c.hotelPerNight, nights: c.nights,
      total: s.total, withinBudget: s.withinBudget, weather: c.weather, reasons: s.reasons, caveats: s.caveats, link: c.link,
    });
    if (ideas.length >= 12) break;
  }
  const notes = [
    `Prices are Google Travel Explore from-prices for ${p.adults} adult${p.adults > 1 ? 's' : ''} at search time, from any of ${airports.map((a) => a.iata).join(', ')}. Hotel prices are per night; the total is an estimate (flight + nights × hotel). When you choose an idea we fetch exact flights and stays.`,
    note,
  ];
  if (failedWindows.length) notes.push(`Prices could not be retrieved for: ${failedWindows.join(', ')}.`);
  await finish(ctx, id, failedWindows.length ? 'partial' : 'complete', { airports, windows, pricedWindows: chosenWindows.map((w) => w.id), ideas, notes, holidaySource: source }, null);
}

/** Matches a Travel Explore destination to a city Place whose first airport is the one priced (falls back to the airport). */
export async function resolveDestination(ctx: AppContext, d: { name: string; iata: string; lat: number | null; lng: number | null }): Promise<Place | null> {
  const iata = d.iata;
  const places = await ctx.providers.flights.searchPlaces(d.name).catch(() => [] as Place[]);
  let place = places.find((x) => x.kind === 'city' && x.airports?.some((a) => a.iata === iata))
    ?? places.find((x) => x.kind === 'city' && d.lat !== null && d.lng !== null && Math.abs(x.lat - d.lat) < 0.6 && Math.abs(x.lng - d.lng) < 0.6);
  if (!place) place = (await ctx.providers.flights.searchPlaces(iata).catch(() => [] as Place[])).find((x) => x.iata === iata);
  if (!place) return null;
  if (!place.airports?.some((a) => a.iata === iata)) {
    const ap = await ctx.providers.flights.airportInfo?.(iata).catch(() => null);
    if (ap) place = { ...place, iata, airports: [{ iata, name: ap.name, lat: ap.lat, lng: ap.lng }, ...(place.airports ?? [])] };
  } else {
    const aps = place.airports ?? [];
    place = { ...place, iata, airports: [...aps.filter((a) => a.iata === iata), ...aps.filter((a) => a.iata !== iata)] };
  }
  return place;
}

/** Creates a trip from an idea and starts the live flight, accommodation and itinerary searches. */
export async function chooseIdea(ctx: AppContext, userId: string, id: string, index: number) {
  const row = await getIdeas(ctx, userId, id);
  const idea = row.result?.ideas?.find((x: any) => x.index === index);
  if (!idea) throw new HttpError(404, 'not_found', 'That trip idea is no longer available. Search again.');
  const p = row.params as IdeaParams;
  const place = await resolveDestination(ctx, idea.destination);
  if (!place) throw new HttpError(502, 'provider_error', 'The destination could not be matched to an airport. Try another idea.');
  const w: TravelWindow = idea.window;
  const trip = await trips.createTrip(ctx, userId, {
    title: `${idea.destination.name} · ${w.label}`.slice(0, 120), origin: p.origin, adults: p.adults, startDate: w.start, endDate: w.end,
    flexDays: 0, budgetTotal: p.budget, currency: p.currency, stops: [{ place, arriveDate: w.start, departDate: w.end }],
  });
  await ctx.db.query('UPDATE trip_ideas SET chosen_trip_id=$2 WHERE id=$1', [id, trip.id]);
  const started: string[] = [];
  for (const kind of ['flight', 'stay'] as const) {
    try { await searches.startSearch(ctx, userId, trip.id, kind); started.push(kind); } catch (e) { await recordError(ctx, 'ideas.choose', e as Error, { kind }); }
  }
  try { await planning.requestPlan(ctx, userId, trip.id); started.push('plan'); } catch (e) { await recordError(ctx, 'ideas.choose', e as Error, { kind: 'plan' }); }
  return { tripId: trip.id, started, nights: daysBetween(w.start, w.end) };
}
