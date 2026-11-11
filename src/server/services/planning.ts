// Itinerary generation from live sources. Google Places supplies named venues (address, hours, price level, map links);
// web research supplies hike facts and menu evidence; the AI selects and explains using only that data;
// the deterministic scheduler assigns times. Nothing is invented: missing facts are reported as missing.
import type { AppContext } from '../context.ts';
import { recordError } from '../context.ts';
import type { Queryable } from '../db/pg.ts';
import { HttpError } from '../http/core.ts';
import { assessDish, venueDietNote } from '../domain/diet.ts';
import { scheduleDay, windowsForDate, type Candidate, type DayInput, type DayWeather, type MealCandidate } from '../domain/itinerary.ts';
import { validateItems, sanitiseExternalText } from '../domain/planQuality.ts';
import { addDays, addMinutesLocal, dateRange, haversineKm, toLocal } from '../domain/time.ts';
import { airportBuffer } from '../domain/reminders.ts';
import { mapLimit, NotConfiguredError } from '../integrations/http.ts';
import type { PlaceResult } from '../integrations/types.ts';
import type { FlightOffer, ItineraryItem, Pace, SourceRef, Venue } from '../../shared/types.ts';
import { getProfile, type Profile } from './profile.ts';
import { getOwnedTrip, getStops, type Stop, type Trip } from './trips.ts';

export async function requestPlan(ctx: AppContext, userId: string, tripId: string, opts: { date?: string; excludePlaceIds?: string[] } = {}) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  if (!trip.startDate || !trip.endDate || !stops.length) throw new HttpError(400, 'trip_incomplete', 'Add dates and at least one destination before generating a plan.');
  if (opts.date && (opts.date < trip.startDate || opts.date > trip.endDate)) throw new HttpError(400, 'invalid_input', 'That date is outside the trip.');
  await ctx.db.query(`UPDATE trips SET plan_status='generating', plan_message=$3, updated_at=now() WHERE id=$1 AND user_id=$2`, [tripId, userId, opts.date ? `Regenerating ${opts.date}…` : 'Researching current venues, hikes and food…']);
  const jobId = await ctx.jobs.enqueue('plan.generate', { userId, tripId, date: opts.date ?? null, excludePlaceIds: opts.excludePlaceIds ?? [] }, { maxAttempts: 3 });
  return { jobId };
}

interface StopResearch {
  stop: Stop;
  attractions: PlaceResult[];
  indoor: PlaceResult[];
  hikes: PlaceResult[];
  breakfast: PlaceResult[];
  restaurants: PlaceResult[];
  sources: Map<string, { url: string; title: string; text: string; retrievedAt: string; provider: string }>;
  localDishes: { name: string; sourceUrl: string }[];
  retrievedAt: string;
}

function placeKey(p: PlaceResult) { return p.placeId; }

async function researchStop(ctx: AppContext, userId: string, stop: Stop, profile: Profile, exclude: Set<string>): Promise<StopResearch> {
  const near = { lat: stop.place.lat, lng: stop.place.lng, radiusM: 8000 };
  const city = stop.place.cityName ?? stop.place.name.replace(/\s*\([A-Z]{3}\)$/, '');
  const diet = profile.diet === 'none' ? '' : profile.diet;
  const q = async (query: string, includedType?: string, radiusM = 8000) => (await ctx.providers.places.textSearch(query, { near: { ...near, radiusM }, includedType, max: 12, userId }))
    .filter((p) => (p.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL' && !exclude.has(p.placeId) && typeof p.lat === 'number');
  const interests = (profile.interests ?? []).slice(0, 3);
  const [attractions, interestHits, indoor, breakfast, restaurants, hikes] = await Promise.all([
    q(`top sights in ${city}`, 'tourist_attraction'),
    Promise.all(interests.map((i) => q(`${i} in ${city}`))).then((r) => r.flat()),
    q(`museum in ${city}`, 'museum'),
    q(`${diet || 'good'} breakfast cafe in ${city}`),
    q(`${diet || 'local'} restaurant in ${city}`, 'restaurant'),
    profile.hikingExperience !== 'none' ? q(`hiking trail near ${city}`, 'hiking_area', 40000) : Promise.resolve([] as PlaceResult[]),
  ]);
  const uniq = (xs: PlaceResult[]) => { const seen = new Set<string>(); return xs.filter((x) => (seen.has(x.placeId) ? false : (seen.add(x.placeId), true))); };
  const r: StopResearch = {
    stop, attractions: uniq([...interestHits, ...attractions]).slice(0, 18), indoor: uniq(indoor).slice(0, 6), hikes: uniq(hikes).slice(0, 5),
    breakfast: uniq(breakfast).filter((p) => p.servesBreakfast !== false).slice(0, 6),
    restaurants: uniq(restaurants).filter((p) => diet ? p.servesVegetarianFood !== false : true).slice(0, 10),
    sources: new Map(), localDishes: [], retrievedAt: new Date().toISOString(),
  };
  // Web research is optional enrichment; failures reduce detail but never introduce invented facts.
  if (ctx.providers.research.configured()) {
    const pages: string[] = [];
    try {
      const dishes = await ctx.providers.research.search(`${city} traditional ${diet || 'local'} dishes to try`, { count: 4, country: stop.place.countryCode, userId });
      pages.push(...dishes.slice(0, 2).map((d) => d.url));
    } catch (e) { await recordError(ctx, 'research.dishes', e, { city }); }
    for (const h of r.hikes.slice(0, 3)) {
      try {
        const res = await ctx.providers.research.search(`${h.name} trail distance elevation gain official`, { count: 4, country: stop.place.countryCode, userId });
        pages.push(...res.slice(0, 2).map((x) => x.url));
      } catch (e) { await recordError(ctx, 'research.hike', e, { hike: h.name }); }
    }
    for (const rest of [...r.restaurants.slice(0, 5), ...r.breakfast.slice(0, 2)]) if (rest.website?.startsWith('https://')) pages.push(rest.website);
    const fetched = await mapLimit([...new Set(pages)].slice(0, 14), 4, (u) => ctx.providers.research.fetchText(u));
    for (const f of fetched) if (f.ok) r.sources.set(f.value.url, { ...f.value, provider: 'web' });
  }
  // Structured source facts (e.g. OpenStreetMap tags such as diet:vegetarian or route distance) are citable evidence.
  for (const p of [...r.hikes, ...r.restaurants, ...r.breakfast, ...r.attractions]) {
    if (p.facts && !r.sources.has(p.mapsUrl)) r.sources.set(p.mapsUrl, { url: p.mapsUrl, title: `${p.name} — ${p.attributions[0] ?? 'map data'}`, text: `${p.name}: ${p.facts}`, retrievedAt: r.retrievedAt, provider: 'map_data' });
  }
  return r;
}

interface AiDayPlan {
  date: string;
  activities: { placeId: string; durationMinutes: number; outdoor: boolean; bookingRequired: 'yes' | 'no' | 'recommended' | 'unknown'; why: string; uncertainty: string; admission?: { text: string; sourceUrl: string } | null }[];
  hikes: { placeId: string; durationMinutes: number; why: string; facts: { distanceKm?: number | null; elevationGainM?: number | null; difficulty?: string | null; permit?: string | null; closures?: string | null; access?: string | null; equipment?: string | null; sourceUrl?: string | null }; uncertainty: string }[];
  breakfast: string[]; lunch: string[]; dinner: string[];
}
interface AiPlan {
  days: AiDayPlan[];
  restaurants: { placeId: string; why: string; dishes: { name: string; sourceUrl: string; evidence: string; labelled: 'vegetarian' | 'vegan' | null }[] }[];
  localDishes: { name: string; note: string; sourceUrl: string }[];
}

function compactPlace(p: PlaceResult) {
  return { placeId: p.placeId, name: p.name, address: p.address, types: p.types.slice(0, 4), rating: p.rating, summary: p.summary, hours: p.weekdayDescriptions, vegetarianOptions: p.servesVegetarianFood, reservable: p.reservable, website: p.website, sourceUrl: p.mapsUrl, facts: p.facts ?? null };
}

async function aiSelect(ctx: AppContext, userId: string, r: StopResearch, dates: string[], profile: Profile, weather: Record<string, DayWeather>): Promise<AiPlan | null> {
  if (!ctx.providers.ai.configured()) return null;
  const sources = [...r.sources.values()].map((s) => `<untrusted_source url="${s.url}">${sanitiseExternalText(s.text, 3500)}</untrusted_source>`).join('\n');
  const payload = {
    task: 'Choose venues for each date using ONLY the candidate placeIds below. Facts (distance, elevation, prices, dishes, permits, closures) must come from the untrusted sources and cite the exact source URL; otherwise leave them null and explain in uncertainty. Use only dishes that appear in a source. Return JSON {days:[{date, activities:[{placeId,durationMinutes,outdoor,bookingRequired,why,uncertainty,admission:{text,sourceUrl}|null}], hikes:[{placeId,durationMinutes,why,facts:{distanceKm,elevationGainM,difficulty,permit,closures,access,equipment,sourceUrl},uncertainty}], breakfast:[placeId, alt placeId], lunch:[placeId, alt], dinner:[placeId, alt]}], restaurants:[{placeId, why, dishes:[{name, sourceUrl, evidence (<=20 words copied from source), labelled:"vegetarian"|"vegan"|null}]}], localDishes:[{name,note,sourceUrl}]}',
    traveller: { diet: profile.diet, allergies: profile.allergies, dietaryNotes: profile.dietaryNotes, pace: profile.pace, interests: profile.interests, hikingExperience: profile.hikingExperience, preferredDifficulty: profile.hikingDifficulty },
    rules: ['Vary venues across days; never repeat an activity.', 'Keep each day geographically compact.', 'Hikes only if suitable for the traveller ability; do not treat a map listing as proof that a trail is open.', 'Do not choose outdoor plans on days whose weather is poor; the scheduler will also swap them.', `Max activities per day: ${profile.pace === 'relaxed' ? 2 : profile.pace === 'moderate' ? 3 : 4} (a hike counts as two).`],
    dates: dates.map((d) => ({ date: d, weather: weather[d] ?? null })),
    candidates: { attractions: r.attractions.map(compactPlace), indoor: r.indoor.map(compactPlace), hikes: r.hikes.map(compactPlace), breakfast: r.breakfast.map(compactPlace), restaurants: r.restaurants.map(compactPlace) },
  };
  return ctx.providers.ai.json<AiPlan>({ operation: 'plan.select', userId, maxTokens: 4000, system: 'You are a meticulous travel planner. You select from verified candidates and never invent venues, prices or facts.', user: `${JSON.stringify(payload)}\n\nSOURCES:\n${sources}` });
}

/** Deterministic fallback when AI is unavailable: highest-rated real candidates, no dish claims. */
function fallbackSelect(r: StopResearch, dates: string[]): AiPlan {
  const byRating = (xs: PlaceResult[]) => [...xs].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const attractions = byRating(r.attractions); const b = byRating(r.breakfast); const rest = byRating(r.restaurants);
  return {
    days: dates.map((d, i) => ({
      date: d,
      activities: attractions.slice(i * 2, i * 2 + 2).map((p) => ({ placeId: p.placeId, durationMinutes: 120, outdoor: p.types.some((t) => /park|garden|beach|viewpoint|natural/.test(t)), bookingRequired: 'unknown' as const, why: p.rating !== null ? `Rated ${p.rating} on Google${p.summary ? ` — ${p.summary}` : ''}.` : `${p.summary ?? 'Notable place in current map data'}.`, uncertainty: 'Selected without AI review; check suitability.', admission: null })),
      hikes: [], breakfast: b.slice(i % Math.max(1, b.length), (i % Math.max(1, b.length)) + 2).map((p) => p.placeId),
      lunch: rest.slice((i * 2) % Math.max(1, rest.length), ((i * 2) % Math.max(1, rest.length)) + 2).map((p) => p.placeId),
      dinner: rest.slice((i * 2 + 1) % Math.max(1, rest.length), ((i * 2 + 1) % Math.max(1, rest.length)) + 2).map((p) => p.placeId),
    })),
    restaurants: [], localDishes: [],
  };
}

function venueFrom(p: PlaceResult, extra: Partial<Venue> = {}): Venue {
  let price: Venue['price'] = null;
  if (p.priceRange?.start?.units) {
    const cur = p.priceRange.start.currencyCode ?? '';
    price = { text: `${cur} ${p.priceRange.start.units}${p.priceRange.end?.units ? `–${p.priceRange.end.units}` : '+'} per person (Google Places price range)`, provenance: 'source', sourceUrl: p.mapsUrl };
  } else if (p.priceLevel) {
    price = { text: `${p.priceLevel.replace('PRICE_LEVEL_', '').toLowerCase().replace(/_/g, ' ')} price level (Google Places)`, provenance: 'source', sourceUrl: p.mapsUrl };
  }
  return { name: p.name, address: p.address, lat: p.lat, lng: p.lng, mapsUrl: p.mapsUrl, website: p.website, openingHours: p.weekdayDescriptions, price, placeId: p.placeId, ...extra };
}

function placeSource(p: PlaceResult, retrievedAt: string): SourceRef {
  const osm = p.placeId.startsWith('osm:');
  return { url: p.mapsUrl, title: `${p.name} on ${osm ? 'OpenStreetMap' : 'Google Maps'}${p.attributions.length && !osm ? ` (${p.attributions.join(', ')})` : osm ? ' (© OpenStreetMap contributors)' : ''}`, provider: osm ? 'openstreetmap' : 'google_places', retrievedAt };
}

/** Build per-day inputs and schedule. */
function buildDay(date: string, stop: Stop, r: StopResearch, sel: AiPlan, dayPlan: AiDayPlan | undefined, profile: Profile, weather: DayWeather | null, constraints: Partial<DayInput>, pace: Pace) {
  const all = new Map([...r.attractions, ...r.indoor, ...r.hikes, ...r.breakfast, ...r.restaurants].map((p) => [placeKey(p), p]));
  const validUrl = (u?: string | null) => (u && r.sources.has(u) ? u : null);
  const src = (u: string | null): SourceRef[] => (u ? [{ url: u, title: r.sources.get(u)!.title, provider: 'web', retrievedAt: r.sources.get(u)!.retrievedAt }] : []);
  const candidates: Candidate[] = [];
  for (const a of dayPlan?.activities ?? []) {
    const p = all.get(a.placeId); if (!p) continue;
    const admissionUrl = validUrl(a.admission?.sourceUrl);
    candidates.push({ key: p.placeId, kind: 'activity', title: p.name, venue: venueFrom(p, admissionUrl ? { price: { text: a.admission!.text, provenance: 'source', sourceUrl: admissionUrl } } : {}),
      durationMinutes: Math.min(Math.max(a.durationMinutes || 90, 45), 300), outdoor: !!a.outdoor, openWindows: windowsForDate(p.weekdayDescriptions, date),
      bookingRequired: a.bookingRequired ?? 'unknown', why: a.why, uncertainty: [a.uncertainty, admissionUrl ? '' : 'Admission price not confirmed by a current source.'].filter(Boolean).join(' '),
      sources: [placeSource(p, r.retrievedAt), ...src(admissionUrl)], retrievedAt: r.retrievedAt });
  }
  for (const h of dayPlan?.hikes ?? []) {
    const p = all.get(h.placeId); if (!p) continue;
    const f = h.facts ?? {}; const fUrl = validUrl(f.sourceUrl);
    const facts = fUrl ? [f.distanceKm ? `${f.distanceKm} km` : null, f.elevationGainM ? `+${f.elevationGainM} m` : null, f.difficulty, f.permit ? `Permit: ${f.permit}` : null, f.closures ? `Closures: ${f.closures}` : null, f.access ? `Access: ${f.access}` : null, f.equipment ? `Bring: ${f.equipment}` : null].filter(Boolean).join(' · ') : '';
    candidates.push({ key: p.placeId, kind: 'hike', title: p.name, venue: venueFrom(p), durationMinutes: Math.min(Math.max(h.durationMinutes || 180, 60), 540), outdoor: true, openWindows: windowsForDate(p.weekdayDescriptions, date),
      bookingRequired: f.permit && fUrl ? 'yes' : 'unknown', why: `${h.why}${facts ? ` (${facts})` : ''}`,
      uncertainty: [fUrl ? '' : 'Distance, elevation and current trail status could not be confirmed from an official source — check locally before setting out.', h.uncertainty, 'Check official trail notices for closures on the day.'].filter(Boolean).join(' '),
      sources: [placeSource(p, r.retrievedAt), ...src(fUrl)], retrievedAt: r.retrievedAt, daylightBufferMinutes: 60 });
  }
  const indoorAlternatives: Candidate[] = r.indoor.filter((p) => !candidates.some((c) => c.key === p.placeId)).slice(0, 3).map((p) => ({
    key: p.placeId, kind: 'activity', title: p.name, venue: venueFrom(p), durationMinutes: 120, outdoor: false, openWindows: windowsForDate(p.weekdayDescriptions, date),
    bookingRequired: 'unknown', why: `Indoor alternative${p.summary ? `: ${p.summary}` : ''}.`, uncertainty: 'Admission price not confirmed by a current source.', sources: [placeSource(p, r.retrievedAt)], retrievedAt: r.retrievedAt,
  }));
  const restaurantInfo = new Map(sel.restaurants.map((x) => [x.placeId, x]));
  const meals: MealCandidate[] = [];
  for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
    // AI picks first; then other researched venues as fallbacks in case the picks are closed or too far at that time.
    const pool = (meal === 'breakfast' ? r.breakfast : r.restaurants).filter((x) => profile.diet === 'none' || x.servesVegetarianFood).map((x) => x.placeId);
    const ids = [...new Set([...(dayPlan?.[meal] ?? []).slice(0, 3), ...pool])].slice(0, 6);
    for (const id of ids) {
      const p = all.get(id); if (!p) continue;
      const info = restaurantInfo.get(id);
      const dishes = (info?.dishes ?? []).filter((d) => validUrl(d.sourceUrl)).map((d) => {
        const srcText = r.sources.get(d.sourceUrl)!.text;
        // Accept a label only if the source text itself shows the dish name near a vegetarian/vegan marker.
        const idx = srcText.toLowerCase().indexOf(d.name.toLowerCase().slice(0, 25));
        // Evidence window: the dish's own menu entry only (up to the next sentence/entry), never neighbouring dishes.
        const tail = idx >= 0 ? srcText.slice(idx, idx + 160) : '';
        const cut = tail.slice(d.name.length).search(/[.;\n•|]|\s{2,}/);
        const near = idx >= 0 ? tail.slice(0, cut >= 0 ? d.name.length + cut : tail.length) : '';
        const labelled = idx >= 0 && /(\bvegan\b|\(vg\))/i.test(near) ? 'vegan' : idx >= 0 && /(\bvegetarian\b|\bveggie\b|\(v\))/i.test(near) ? 'vegetarian' : null;
        const a = assessDish({ name: d.name, sourceText: near || d.evidence, labelled, sourceUrl: d.sourceUrl }, profile.diet);
        return { name: d.name, dietStatus: a.status, note: a.reasons.join(' ') };
      }).filter((d) => d.dietStatus !== 'not_suitable');
      const osm = p.placeId.startsWith('osm:');
      const fullyVeg = /diet:(vegetarian|vegan)=only/.test(p.facts ?? '');
      const listed = !p.servesVegetarianFood ? '' : fullyVeg ? 'Fully vegetarian/vegan venue according to OpenStreetMap (community-maintained). ' : osm ? 'OpenStreetMap lists vegetarian options. ' : 'Google Places lists vegetarian options. ';
      const dietNote = profile.diet === 'none' ? '' : `${listed}${venueDietNote(dishes.map((d) => d.dietStatus), profile.diet)}`;
      const allergyNote = profile.allergies.length ? ` Tell staff about your allergies (${profile.allergies.join(', ')}); allergen information is not verified.` : '';
      meals.push({ meal, venue: venueFrom(p, { dishes }), openWindows: windowsForDate(p.weekdayDescriptions, date), bookingRequired: p.reservable ? 'recommended' : 'unknown',
        why: info?.why ?? (p.summary ?? (p.rating !== null ? `Rated ${p.rating} on Google.` : 'Selected from current map data near your route.')), uncertainty: (dietNote + allergyNote).trim(),
        sources: [placeSource(p, r.retrievedAt), ...dishes.length ? (info?.dishes ?? []).filter((d) => validUrl(d.sourceUrl)).slice(0, 2).flatMap((d) => src(d.sourceUrl)) : []], retrievedAt: r.retrievedAt });
    }
  }
  const input: DayInput = { date, timeZone: stop.place.timeZone ?? 'UTC', pace, wakeTime: profile.wakeTime, prepMinutes: profile.prepMinutes, base: { lat: stop.place.lat, lng: stop.place.lng, name: stop.place.name }, candidates, indoorAlternatives, meals, weather, ...constraints };
  const out = scheduleDay(input);
  return out;
}

/** Arrival/departure constraints from the selected flight (real times) or labelled assumptions. */
function travelConstraints(date: string, trip: Trip, stops: Stop[], flight: FlightOffer | null, profile: Profile): { c: Partial<DayInput>; notes: string[] } {
  const notes: string[] = [];
  const c: Partial<DayInput> = {};
  const first = stops[0]; const last = stops[stops.length - 1];
  if (date === trip.startDate) {
    const seg = flight?.slices[0]?.segments.at(-1);
    if (seg) {
      const landLocal = toLocal(seg.arriveUtc, first.place.timeZone ?? seg.arriveTz).slice(0, 16);
      const ap = first.place.airports?.find((a) => a.iata === seg.to);
      const transfer = ap ? Math.round(20 + (haversineKm(ap, first.place) * 1.3 / 35) * 60) : 45;
      const free = addMinutesLocal(landLocal, 45 + transfer, first.place.timeZone ?? seg.arriveTz);
      if (landLocal.slice(0, 10) === date) {
        c.availableFrom = free.slice(0, 10) === date ? free.slice(11, 16) : '23:59';
        c.arrivalNote = `Land at ${seg.to} ${landLocal.slice(11, 16)} (flight ${seg.flightNumber}); allow ~45 min for arrival formalities and ~${transfer} min transfer (planning estimate).`;
      }
    } else {
      c.availableFrom = '14:00';
      c.arrivalNote = 'Arrival time unknown — no flight selected yet. Afternoon arrival assumed.';
      notes.push('Arrival-day timing is an assumption until you select a flight; regenerate this day afterwards.');
    }
    c.checkIn = { time: '15:00', venue: null, title: `Check in at your ${first.place.name} accommodation` };
  }
  if (date === trip.endDate) {
    const seg = flight?.slices[1]?.segments[0];
    if (seg) {
      const depLocal = toLocal(seg.departUtc, last.place.timeZone ?? seg.departTz).slice(0, 16);
      const ap = last.place.airports?.find((a) => a.iata === seg.from);
      const transfer = ap ? Math.round(20 + (haversineKm(ap, last.place) * 1.3 / 35) * 60) : 45;
      const buffer = airportBuffer(true, profile.checkedBag, false);
      const leave = addMinutesLocal(depLocal, -(buffer + transfer), last.place.timeZone ?? seg.departTz);
      c.availableUntil = leave.slice(0, 10) === date ? leave.slice(11, 16) : '00:00';
      c.departureNote = `Leave for ${seg.from} airport (flight ${seg.flightNumber} departs ${depLocal.slice(11, 16)}; ${buffer} min airport buffer + ~${transfer} min transfer).`;
    } else {
      c.availableUntil = '12:00';
      c.departureNote = 'Departure time unknown — no return flight selected. Midday departure assumed.';
      notes.push('Departure-day timing is an assumption until you select a flight.');
    }
    c.checkOut = { time: '11:00', venue: null, title: 'Check out (confirm the property deadline)' };
  }
  // Moving between stops: check out of the previous stop in the morning, travel, check in at the new one.
  const idx = stops.findIndex((s) => s.arriveDate === date && s !== first);
  if (idx > 0) {
    c.checkOut = { time: '10:30', venue: null, title: `Check out in ${stops[idx - 1].place.name}` };
    c.availableFrom = '13:30';
    c.arrivalNote = `Travel ${stops[idx - 1].place.name} → ${stops[idx].place.name} (book transport separately; timing is a planning assumption).`;
    c.checkIn = { time: '15:00', venue: null, title: `Check in at your ${stops[idx].place.name} accommodation` };
    notes.push('Inter-city travel time is a planning assumption; no transport has been booked.');
  }
  return { c, notes };
}

export function stopForDate(stops: Stop[], date: string): Stop {
  return stops.find((s) => s.arriveDate <= date && date < s.departDate) ?? stops[stops.length - 1];
}

async function saveDay(q: Queryable, tripId: string, stop: Stop, date: string, result: { items: ItineraryItem[]; missing: string[]; notes: string[] }, weather: DayWeather | null, r: StopResearch | null, metaByKey: Map<string, Record<string, unknown>>) {
  const quality = validateItems(result.items);
  const missing = [...result.missing, ...quality.map((x) => `${x.itemTitle}: ${x.problem}`)];
  const status = missing.length ? 'incomplete' : 'complete';
  const day = await q.query<{ id: string }>(
    `INSERT INTO itinerary_days(trip_id, day_date, stop_id, time_zone, status, missing, notes, weather, generated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (trip_id, day_date) DO UPDATE SET stop_id=EXCLUDED.stop_id, time_zone=EXCLUDED.time_zone, status=EXCLUDED.status, missing=EXCLUDED.missing, notes=EXCLUDED.notes, weather=EXCLUDED.weather, generated_at=now(), version=itinerary_days.version+1
     RETURNING id`,
    [tripId, date, stop.id, stop.place.timeZone ?? 'UTC', status, JSON.stringify(missing), JSON.stringify(result.notes), weather]);
  const dayId = day.rows[0].id;
  await q.query('DELETE FROM itinerary_items WHERE day_id=$1', [dayId]);
  for (const [pos, it] of result.items.entries()) {
    const ids: string[] = [];
    for (const s of it.sources) {
      const ins = await q.query<{ id: string }>(`INSERT INTO research_sources(trip_id, url, title, provider, retrieved_at, excerpt) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (trip_id, url, retrieved_at) DO UPDATE SET title=EXCLUDED.title RETURNING id`,
        [tripId, s.url, s.title.slice(0, 300), s.provider, s.retrievedAt, r?.sources.get(s.url)?.text.slice(0, 500) ?? '']);
      ids.push(ins.rows[0].id);
    }
    await q.query(`INSERT INTO itinerary_items(day_id, position, kind, start_local, end_local, title, venue, why, booking_required, uncertainty, source_ids, retrieved_at, locked, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [dayId, pos, it.kind, it.startLocal, it.endLocal, it.title, it.venue, it.why, it.bookingRequired, it.uncertainty, JSON.stringify(ids), it.retrievedAt, !!it.locked, metaByKey.get(it.venue?.placeId ?? '') ?? {}]);
  }
  return status;
}

/** Job handler: generate all days (or one day). A failed run never overwrites an existing good day. */
export async function runPlanJob(ctx: AppContext, p: { userId: string; tripId: string; date: string | null; excludePlaceIds: string[] }) {
  const trip = await getOwnedTrip(ctx, p.userId, p.tripId);
  const stops = await getStops(ctx.db, p.tripId);
  const profile = await getProfile(ctx, p.userId);
  if (!ctx.providers.places.configured()) {
    await ctx.db.query(`UPDATE trips SET plan_status=CASE WHEN EXISTS (SELECT 1 FROM itinerary_days WHERE trip_id=$1) THEN 'incomplete' ELSE 'failed' END, plan_message=$2 WHERE id=$1`,
      [p.tripId, 'Live venue research is not available yet, so a plan could not be generated. Your saved trip is unchanged.']);
    return;
  }
  const flightRow = await ctx.db.query<any>(`SELECT data FROM offers WHERE trip_id=$1 AND kind='flight' AND selected ORDER BY quoted_at DESC LIMIT 1`, [p.tripId]);
  const flight: FlightOffer | null = flightRow.rows[0]?.data?.offer ?? null;
  const allDates = dateRange(trip.startDate!, trip.endDate!);
  const dates = p.date ? [p.date] : allDates;
  const byStop = new Map<string, string[]>();
  for (const d of dates) { const s = stopForDate(stops, d); byStop.set(s.id, [...(byStop.get(s.id) ?? []), d]); }
  const exclude = new Set(p.excludePlaceIds);
  // Venues already used on other days are excluded when regenerating one day.
  if (p.date) {
    const used = await ctx.db.query<any>(`SELECT i.venue->>'placeId' AS pid FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE d.trip_id=$1 AND d.day_date<>$2 AND i.kind IN ('activity','hike')`, [p.tripId, p.date]);
    for (const u of used.rows) if (u.pid) exclude.add(u.pid);
  }
  const results: { date: string; status: string }[] = []; const failures: string[] = [];
  for (const [stopId, stopDates] of byStop) {
    const stop = stops.find((s) => s.id === stopId)!;
    let research: StopResearch; let weather: Record<string, DayWeather> = {};
    try {
      research = await researchStop(ctx, p.userId, stop, profile, exclude);
      if (ctx.providers.weather.configured() && stop.place.timeZone) {
        weather = await ctx.providers.weather.forDates(stop.place.lat, stop.place.lng, stopDates, stop.place.timeZone).catch(async (e) => { await recordError(ctx, 'weather', e); return {}; });
      }
    } catch (e) {
      await recordError(ctx, 'plan.research', e, { tripId: p.tripId, stop: stop.place.name });
      failures.push(`${stop.place.name}: ${e instanceof NotConfiguredError ? 'service not available' : 'research service did not respond'}`);
      continue; // keep existing days for this stop untouched
    }
    if (!research.attractions.length && !research.restaurants.length) { failures.push(`${stop.place.name}: no venues returned`); continue; }
    let sel: AiPlan | null = null;
    try { sel = await aiSelect(ctx, p.userId, research, stopDates, profile, weather); }
    catch (e) { await recordError(ctx, 'plan.ai', e, { tripId: p.tripId }); }
    const usedFallback = !sel;
    sel ??= fallbackSelect(research, stopDates);
    const metaByKey = new Map<string, Record<string, unknown>>();
    for (const d of sel.days) {
      for (const a of d.activities ?? []) metaByKey.set(a.placeId, { durationMinutes: a.durationMinutes, outdoor: a.outdoor });
      for (const h of d.hikes ?? []) metaByKey.set(h.placeId, { durationMinutes: h.durationMinutes, outdoor: true, hike: h.facts });
    }
    for (const date of stopDates) {
      const { c, notes } = travelConstraints(date, trip, stops, flight, profile);
      const out = buildDay(date, stop, research, sel, sel.days.find((d) => d.date === date), profile, weather[date] ?? null, c, profile.pace);
      out.notes.push(...notes);
      if (usedFallback) out.notes.push('Venues were chosen by rating because the AI planner was unavailable; explanations are limited.');
      if (weather[date]?.kind === 'climate') out.notes.push('Weather shown is historical climate for this date, not a forecast.');
      const dishes = sel.localDishes.filter((d) => research.sources.has(d.sourceUrl)).slice(0, 4);
      if (dishes.length) out.notes.push(`Local dishes to look for: ${dishes.map((d) => `${d.name} (${d.note})`).join('; ')} — check each is ${profile.diet === 'none' ? 'to your taste' : profile.diet} as prepared.`);
      const status = await ctx.db.tx((q) => saveDay(q, p.tripId, stop, date, out, weather[date] ?? null, research, metaByKey));
      results.push({ date, status });
    }
  }
  const days = await ctx.db.query<{ status: string }>('SELECT status FROM itinerary_days WHERE trip_id=$1', [p.tripId]);
  const total = allDates.length;
  const complete = days.rows.filter((d) => d.status === 'complete').length;
  const planStatus = days.rows.length === 0 ? 'failed' : complete === total && !failures.length ? 'complete' : 'incomplete';
  const message = failures.length ? `Some days could not be refreshed: ${failures.join('; ')}. Previously saved days were kept. Retry when ready.`
    : planStatus === 'complete' ? `Plan generated from current sources (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC).` : `${total - complete} day(s) are incomplete — see the missing items on each day.`;
  await ctx.db.query('UPDATE trips SET plan_status=$2, plan_message=$3, status=CASE WHEN status=\'draft\' THEN \'planned\' ELSE status END, updated_at=now() WHERE id=$1', [p.tripId, planStatus, message]);
  if (failures.length && !results.length) throw new Error(`plan generation failed: ${failures.join('; ')}`);
  await scheduleTripNotifications(ctx, p.userId, p.tripId).catch((e) => recordError(ctx, 'notifications.schedule', e));
}

// Late import to avoid a cycle.
import { scheduleTripNotifications } from './notifications.ts';

/** Deterministic re-timing of a saved day after a manual edit (remove, move, pace change). No new research. */
export async function rescheduleDay(ctx: AppContext, userId: string, tripId: string, dayDate: string, change: { removeItemId?: string; addItem?: ItineraryItem & { meta?: any }; pace?: Pace; expectedVersion?: number; mustPlace?: string }) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  return ctx.db.tx(async (q) => {
    const dayR = await q.query<any>('SELECT * FROM itinerary_days WHERE trip_id=$1 AND day_date=$2 FOR UPDATE', [tripId, dayDate]);
    const day = dayR.rows[0];
    if (!day) throw new HttpError(404, 'not_found', 'Day not found');
    if (change.expectedVersion !== undefined && change.expectedVersion !== day.version) throw new HttpError(409, 'version_conflict', 'This day was changed elsewhere. Reload to see the latest version.');
    const items = (await q.query<any>('SELECT * FROM itinerary_items WHERE day_id=$1 ORDER BY position', [day.id])).rows.filter((i) => i.id !== change.removeItemId);
    const sources = new Map((await q.query<any>('SELECT * FROM research_sources WHERE trip_id=$1', [tripId])).rows.map((s) => [s.id, { url: s.url, title: s.title, provider: s.provider, retrievedAt: s.retrieved_at }]));
    const toSrc = (ids: string[]) => ids.map((id) => sources.get(id)).filter(Boolean) as SourceRef[];
    const candidates: Candidate[] = items.filter((i) => (i.kind === 'activity' || i.kind === 'hike') && i.venue).map((i) => ({
      key: i.venue.placeId ?? i.id, kind: i.kind, title: i.title, venue: i.venue, durationMinutes: i.meta?.durationMinutes ?? minutesOf(i.start_local, i.end_local), outdoor: !!i.meta?.outdoor,
      openWindows: windowsForDate(i.venue.openingHours, dayDate), bookingRequired: i.booking_required, why: i.why, uncertainty: i.uncertainty, sources: toSrc(i.source_ids), retrievedAt: i.retrieved_at, daylightBufferMinutes: 60,
    }));
    if (change.addItem?.venue) {
      const a = change.addItem;
      candidates.unshift({ key: a.venue!.placeId ?? a.title, kind: a.kind === 'hike' ? 'hike' : 'activity', title: a.title, venue: a.venue!, durationMinutes: a.meta?.durationMinutes ?? minutesOf(a.startLocal, a.endLocal), outdoor: !!a.meta?.outdoor, openWindows: windowsForDate(a.venue!.openingHours, dayDate), bookingRequired: a.bookingRequired, why: a.why, uncertainty: a.uncertainty, sources: a.sources, retrievedAt: a.retrievedAt ?? new Date().toISOString() });
    }
    const meals: MealCandidate[] = items.filter((i) => ['breakfast', 'lunch', 'dinner'].includes(i.kind) && i.venue).map((i) => ({ meal: i.kind, venue: i.venue, openWindows: windowsForDate(i.venue.openingHours, dayDate), bookingRequired: i.booking_required, why: i.why, uncertainty: i.uncertainty, sources: toSrc(i.source_ids), retrievedAt: i.retrieved_at }));
    const stop = stopForDate(stops, dayDate);
    const flightRow = await q.query<any>(`SELECT data FROM offers WHERE trip_id=$1 AND kind='flight' AND selected ORDER BY quoted_at DESC LIMIT 1`, [tripId]);
    const { c, notes } = travelConstraints(dayDate, trip, stops, flightRow.rows[0]?.data?.offer ?? null, profile);
    const out = scheduleDay({ date: dayDate, timeZone: stop.place.timeZone ?? 'UTC', pace: change.pace ?? profile.pace, wakeTime: profile.wakeTime, prepMinutes: profile.prepMinutes, base: { lat: stop.place.lat, lng: stop.place.lng, name: stop.place.name }, candidates, indoorAlternatives: [], meals, weather: day.weather, ...c });
    out.notes.push(...notes);
    if (change.mustPlace && !out.items.some((x) => (x.venue?.placeId ?? x.title) === change.mustPlace)) {
      throw new HttpError(409, 'cannot_fit', `${change.addItem?.title ?? 'This activity'} does not fit on ${dayDate} (opening hours, daylight or available time). Nothing was changed.`, { details: { notes: out.notes } });
    }
    const metaByKey = new Map<string, Record<string, unknown>>(items.filter((i) => i.venue?.placeId).map((i) => [i.venue.placeId, i.meta]));
    if (change.addItem?.venue?.placeId) metaByKey.set(change.addItem.venue.placeId, change.addItem.meta ?? {});
    // saveDay re-inserts sources; reuse existing ids by URL to avoid duplicates
    await saveDay(q, tripId, stop, dayDate, out, day.weather, null, metaByKey);
    return out;
  });
}

function minutesOf(a: string, b: string) { return Math.max(30, Math.round((Date.parse(b + ':00Z') - Date.parse(a + ':00Z')) / 60000)); }

export async function moveItem(ctx: AppContext, userId: string, tripId: string, itemId: string, toDate: string) {
  await getOwnedTrip(ctx, userId, tripId);
  const r = await ctx.db.query<any>(`SELECT i.*, d.day_date FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE i.id=$1 AND d.trip_id=$2`, [itemId, tripId]);
  const it = r.rows[0];
  if (!it) throw new HttpError(404, 'not_found', 'Item not found');
  if (!['activity', 'hike'].includes(it.kind)) throw new HttpError(400, 'invalid_input', 'Only activities and hikes can be moved; meals are re-planned per day.');
  const srcs = (await ctx.db.query<any>('SELECT url, title, provider, retrieved_at FROM research_sources WHERE id = ANY($1::uuid[])', [it.source_ids])).rows.map((s) => ({ url: s.url, title: s.title, provider: s.provider, retrievedAt: s.retrieved_at }));
  if (toDate === it.day_date) throw new HttpError(400, 'invalid_input', 'Choose a different day.');
  await rescheduleDay(ctx, userId, tripId, toDate, { mustPlace: it.venue?.placeId ?? it.title, addItem: { kind: it.kind, startLocal: it.start_local, endLocal: it.end_local, title: it.title, venue: it.venue, why: it.why, bookingRequired: it.booking_required, uncertainty: it.uncertainty, sources: srcs, retrievedAt: it.retrieved_at, meta: it.meta } });
  await rescheduleDay(ctx, userId, tripId, it.day_date, { removeItemId: itemId });
  return { moved: true };
}

export { addDays };
