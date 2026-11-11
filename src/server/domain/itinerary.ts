// Deterministic day scheduler. AI chooses and explains candidates; this module assigns times,
// enforces arrival/departure constraints, opening hours, meal windows, pace, weather and daylight.
import type { ItineraryItem, Pace, SourceRef, Venue } from '../../shared/types.ts';
import { fmtHHMM, haversineKm, parseHHMM } from './time.ts';

export interface OpenWindow { open: number; close: number } // minutes since local midnight; close may exceed 1440

export interface Candidate {
  key: string;
  kind: 'activity' | 'hike';
  title: string;
  venue: Venue;
  durationMinutes: number;
  outdoor: boolean;
  /** null = hours unknown for this date (scheduled with an uncertainty note); [] = closed this date. */
  openWindows: OpenWindow[] | null;
  bookingRequired: ItineraryItem['bookingRequired'];
  why: string;
  uncertainty: string;
  sources: SourceRef[];
  retrievedAt: string;
  /** For hikes: must finish this many minutes before sunset. */
  daylightBufferMinutes?: number;
  locked?: { start: number } | null;
}

export interface MealCandidate {
  meal: 'breakfast' | 'lunch' | 'dinner';
  venue: Venue;
  openWindows: OpenWindow[] | null;
  bookingRequired: ItineraryItem['bookingRequired'];
  why: string;
  uncertainty: string;
  sources: SourceRef[];
  retrievedAt: string;
}

export interface DayWeather {
  kind: 'forecast' | 'climate';
  precipitationProbability: number | null; // %
  windMaxKmh: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  sunrise: string | null; // 'HH:mm'
  sunset: string | null;
}

export interface DayInput {
  date: string;
  timeZone: string;
  pace: Pace;
  wakeTime: string; // 'HH:mm'
  prepMinutes: number;
  base: { lat: number; lng: number; name: string } | null; // accommodation or arrival point
  /** Arrival day: earliest local time the traveller is free (after landing, formalities and transfer). */
  availableFrom?: string | null;
  arrivalNote?: string | null;
  /** Departure day: latest local time activities must end (time to leave for the airport/station). */
  availableUntil?: string | null;
  departureNote?: string | null;
  checkIn?: { time: string; venue: Venue | null; title: string } | null;
  checkOut?: { time: string; venue: Venue | null; title: string } | null;
  candidates: Candidate[];
  indoorAlternatives: Candidate[];
  meals: MealCandidate[];
  weather: DayWeather | null;
}

export interface DayResult {
  items: ItineraryItem[];
  missing: string[];
  notes: string[];
}

const PACE_LIMIT: Record<Pace, number> = { relaxed: 2, moderate: 3, packed: 4 };
const MEAL_WINDOWS = {
  breakfast: { earliest: 7 * 60, latest: 10 * 60 + 30, duration: 45 },
  lunch: { earliest: 12 * 60, latest: 14 * 60 + 30, duration: 60 },
  dinner: { earliest: 18 * 60 + 30, latest: 21 * 60 + 30, duration: 90 },
};

export function travelMinutes(a: { lat: number; lng: number } | null, b: { lat: number; lng: number } | null): { minutes: number; mode: string } {
  if (!a || !b) return { minutes: 20, mode: 'local transport (planning assumption)' };
  const km = haversineKm(a, b);
  if (km < 0.15) return { minutes: 0, mode: 'same area' };
  if (km <= 1.5) return { minutes: Math.ceil((km * 1.3 / 4.5) * 60), mode: 'walk' };
  return { minutes: Math.ceil(10 + (km * 1.3 / 20) * 60), mode: 'public transport or taxi (planning assumption)' };
}

function fits(windows: OpenWindow[] | null, start: number, end: number): boolean | null {
  if (windows === null) return null;
  return windows.some((w) => start >= w.open && end <= w.close);
}

function earliestOpenStart(windows: OpenWindow[] | null, from: number, duration: number): number | null {
  if (windows === null) return from;
  const sorted = [...windows].sort((a, b) => a.open - b.open);
  for (const w of sorted) {
    const s = Math.max(from, w.open);
    if (s + duration <= w.close) return s;
  }
  return null;
}

export function weatherUnsuitable(c: Candidate, w: DayWeather | null): string | null {
  if (!c.outdoor || !w) return null;
  if (w.precipitationProbability !== null && w.precipitationProbability >= 60) return `${w.kind === 'forecast' ? 'Forecast' : 'Historical climate'} shows ${w.precipitationProbability}% chance of precipitation`;
  if (w.windMaxKmh !== null && w.windMaxKmh >= 50) return `Strong wind expected (${Math.round(w.windMaxKmh)} km/h)`;
  if (w.tempMaxC !== null && w.tempMaxC >= 35 && c.kind === 'hike') return `Heat (${Math.round(w.tempMaxC)}°C) makes a hike risky`;
  return null;
}

export function scheduleDay(inputArg: DayInput): DayResult {
  let input = inputArg;
  const items: ItineraryItem[] = [];
  const missing: string[] = [];
  const notes: string[] = [];
  const d = input.date;
  const at = (m: number) => `${d}T${fmtHHMM(m)}`;
  const isArrival = !!input.availableFrom;
  const dayEnd = input.availableUntil ? parseHHMM(input.availableUntil) : 22 * 60;
  // Early departure: wake up early enough to get ready and check out before leaving.
  let wakeMin = parseHHMM(input.wakeTime);
  const needed = input.prepMinutes + (input.checkOut ? 15 : 0);
  if (!isArrival && input.availableUntil && wakeMin + needed > dayEnd) {
    wakeMin = Math.max(0, dayEnd - needed);
    notes.push(`Early departure: wake up at ${fmtHHMM(wakeMin)} to leave on time.`);
    if (input.checkOut) input = { ...input, checkOut: { ...input.checkOut, time: fmtHHMM(Math.min(dayEnd, wakeMin + needed)) } };
  }
  const wakeTime = fmtHHMM(wakeMin);
  const dayStart = input.availableFrom ? parseHHMM(input.availableFrom) : wakeMin + input.prepMinutes;
  if (dayEnd <= dayStart) {
    notes.push('No free time on this day between travel commitments.');
  }

  const push = (it: Omit<ItineraryItem, 'sources' | 'retrievedAt'> & Partial<Pick<ItineraryItem, 'sources' | 'retrievedAt'>>) =>
    items.push({ sources: [], retrievedAt: null, ...it });

  if (!isArrival) {
    push({ kind: 'wake', startLocal: at(wakeMin), endLocal: at(wakeMin + input.prepMinutes), title: 'Wake up and get ready', venue: null, why: `Based on a ${wakeTime} wake-up and ${input.prepMinutes} minutes of preparation.`, bookingRequired: 'no', uncertainty: '' });
  } else if (input.arrivalNote) {
    push({ kind: 'travel', startLocal: at(dayStart), endLocal: at(dayStart), title: input.arrivalNote, venue: null, why: 'Activities start only after you have landed and reached the city.', bookingRequired: 'no', uncertainty: '' });
  }

  let cursor = dayStart;
  let here: { lat: number; lng: number } | null = input.base;

  const placeMeal = (meal: 'breakfast' | 'lunch' | 'dinner', required: boolean): boolean => {
    const win = MEAL_WINDOWS[meal];
    const cands = input.meals.filter((m) => m.meal === meal);
    if (!cands.length) {
      if (required) missing.push(`${meal}: no verified venue was found`);
      return false;
    }
    for (const c of cands) {
      const tr = travelMinutes(here, c.venue);
      const from = Math.max(cursor + tr.minutes, win.earliest);
      const start = earliestOpenStart(c.openWindows, from, win.duration);
      if (start === null || start > win.latest || start + win.duration > dayEnd) continue;
      if (tr.minutes > 0) push({ kind: 'transfer', startLocal: at(start - tr.minutes), endLocal: at(start), title: `Travel to ${c.venue.name} (${tr.mode})`, venue: null, why: '', bookingRequired: 'no', uncertainty: tr.mode.includes('assumption') ? 'Travel time is a planning estimate.' : '' });
      const hoursUnknown = c.openWindows === null ? 'Opening hours for this date could not be confirmed. ' : '';
      push({ kind: meal, startLocal: at(start), endLocal: at(start + win.duration), title: `${meal[0].toUpperCase()}${meal.slice(1)} at ${c.venue.name}`, venue: c.venue, why: c.why, bookingRequired: c.bookingRequired, uncertainty: (hoursUnknown + c.uncertainty).trim(), sources: c.sources, retrievedAt: c.retrievedAt });
      cursor = start + win.duration; here = c.venue;
      return true;
    }
    if (required) missing.push(`${meal}: candidate venues are closed or too far for the available time`);
    return false;
  };

  if (input.checkOut) {
    const t = parseHHMM(input.checkOut.time);
    // Checkout happens after breakfast; breakfast is attempted first if time allows.
    if (cursor <= MEAL_WINDOWS.breakfast.latest) placeMeal('breakfast', false);
    const s = Math.min(Math.max(cursor, Math.min(t, dayEnd) - 15), Math.max(dayStart, dayEnd - 15));
    push({ kind: 'checkout', startLocal: at(s), endLocal: at(s + 15), title: input.checkOut.title, venue: input.checkOut.venue, why: 'Check out before the property deadline; ask to store luggage if your departure is later.', bookingRequired: 'no', uncertainty: '' });
    cursor = s + 15;
  } else if (cursor <= MEAL_WINDOWS.breakfast.latest) {
    placeMeal('breakfast', !isArrival);
  }

  // Choose activities: drop weather-unsuitable outdoor ones in favour of indoor alternatives.
  const limit = PACE_LIMIT[input.pace];
  const chosen: Candidate[] = [];
  const alternatives = [...input.indoorAlternatives];
  for (const c of input.candidates) {
    const reason = weatherUnsuitable(c, input.weather);
    if (reason) {
      const alt = alternatives.shift();
      notes.push(`${c.title} replaced${alt ? ` by ${alt.title}` : ''}: ${reason}.`);
      if (alt) chosen.push(alt);
      continue;
    }
    chosen.push(c);
  }
  // Nearest-neighbour ordering from the base keeps the day geographically practical.
  const ordered: Candidate[] = [];
  let pos = here;
  const pool = [...chosen];
  while (pool.length) {
    pool.sort((a, b) => (pos ? haversineKm(pos, a.venue) - haversineKm(pos, b.venue) : 0));
    const next = pool.shift()!; ordered.push(next); pos = next.venue;
  }

  let budget = limit;
  let lunchDone = false;
  let checkInDone = false;
  const placeCheckIn = () => {
    if (!input.checkIn || checkInDone) return;
    const t = Math.max(parseHHMM(input.checkIn.time), cursor);
    if (t + 20 > dayEnd) return;
    const tr = travelMinutes(here, input.checkIn.venue ?? input.base);
    push({ kind: 'checkin', startLocal: at(t + tr.minutes), endLocal: at(t + tr.minutes + 20), title: input.checkIn.title, venue: input.checkIn.venue, why: 'Check in once rooms are available; drop luggage earlier if you arrive before check-in time.', bookingRequired: 'no', uncertainty: '' });
    cursor = t + tr.minutes + 20; here = input.checkIn.venue ?? input.base;
    checkInDone = true;
  };
  for (const c of ordered) {
    if (input.checkIn && !checkInDone && cursor >= parseHHMM(input.checkIn.time)) placeCheckIn();
    const weight = c.kind === 'hike' ? 2 : 1;
    if (budget - weight < 0) continue;
    if (!lunchDone && cursor >= 11 * 60 + 30 && cursor <= MEAL_WINDOWS.lunch.latest) lunchDone = placeMeal('lunch', true);
    const tr = travelMinutes(here, c.venue);
    let start = earliestOpenStart(c.openWindows, cursor + tr.minutes, c.durationMinutes);
    if (start === null) { notes.push(`${c.title} skipped: closed or not enough opening time left at the available times.`); continue; }
    let end = start + c.durationMinutes;
    if (c.kind === 'hike') {
      const sunset = input.weather?.sunset ? parseHHMM(input.weather.sunset) : null;
      if (sunset !== null && end > sunset - (c.daylightBufferMinutes ?? 60)) { notes.push(`${c.title} skipped: would not finish with a daylight margin before sunset (${input.weather!.sunset}).`); continue; }
      if (sunset === null) notes.push(`Sunset time unavailable; check daylight before starting ${c.title}.`);
    }
    // Keep lunch possible: if the activity would swallow the whole lunch window, place lunch first.
    if (!lunchDone && start < MEAL_WINDOWS.lunch.latest && end > MEAL_WINDOWS.lunch.latest && start >= MEAL_WINDOWS.lunch.earliest - 60) {
      lunchDone = placeMeal('lunch', true);
      const tr2 = travelMinutes(here, c.venue);
      start = earliestOpenStart(c.openWindows, cursor + tr2.minutes, c.durationMinutes) ?? -1;
      if (start < 0) { notes.push(`${c.title} skipped after lunch: closed.`); continue; }
      end = start + c.durationMinutes;
    }
    if (end > dayEnd) { notes.push(`${c.title} skipped: not enough time before ${fmtHHMM(dayEnd)}.`); continue; }
    // Never let an activity make lunch impossible when lunch could otherwise fit today.
    const lunchPossible = !lunchDone && input.meals.some((m) => m.meal === 'lunch') && dayEnd >= MEAL_WINDOWS.lunch.earliest + MEAL_WINDOWS.lunch.duration && cursor <= MEAL_WINDOWS.lunch.latest;
    if (lunchPossible && start < MEAL_WINDOWS.lunch.earliest && (end > MEAL_WINDOWS.lunch.latest || end + MEAL_WINDOWS.lunch.duration > dayEnd)) {
      notes.push(`${c.title} not scheduled before lunch: it would leave no time for lunch.`);
      continue;
    }
    if (tr.minutes > 0) push({ kind: 'transfer', startLocal: at(start - tr.minutes), endLocal: at(start), title: `Travel to ${c.venue.name} (${tr.mode})`, venue: null, why: '', bookingRequired: 'no', uncertainty: tr.mode.includes('assumption') ? 'Travel time is a planning estimate.' : '' });
    const hoursNote = fits(c.openWindows, start, end) === null ? 'Opening hours for this date could not be confirmed. ' : '';
    push({ kind: c.kind, startLocal: at(start), endLocal: at(end), title: c.title, venue: c.venue, why: c.why, bookingRequired: c.bookingRequired, uncertainty: (hoursNote + c.uncertainty).trim(), sources: c.sources, retrievedAt: c.retrievedAt, locked: !!c.locked });
    cursor = end; here = c.venue; budget -= weight;
    if (input.pace !== 'packed' && budget > 0 && cursor + 30 <= dayEnd) {
      push({ kind: 'break', startLocal: at(cursor), endLocal: at(cursor + 30), title: 'Break', venue: null, why: 'Buffer for rest and delays, matched to your travel pace.', bookingRequired: 'no', uncertainty: '' });
      cursor += 30;
    }
  }

  const lunchFits = dayStart <= MEAL_WINDOWS.lunch.latest && dayEnd >= MEAL_WINDOWS.lunch.earliest + MEAL_WINDOWS.lunch.duration;
  if (!lunchDone && lunchFits) {
    if (cursor < MEAL_WINDOWS.lunch.earliest) cursor = MEAL_WINDOWS.lunch.earliest - 10;
    placeMeal('lunch', true);
  }

  placeCheckIn();

  const dinnerFits = dayEnd >= MEAL_WINDOWS.dinner.earliest + MEAL_WINDOWS.dinner.duration;
  if (dinnerFits) placeMeal('dinner', true);

  const activityCount = items.filter((i) => i.kind === 'activity' || i.kind === 'hike').length;
  const freeHours = (dayEnd - dayStart) / 60;
  if (activityCount === 0 && freeHours >= 5) missing.push('activities: no verified activity could be scheduled');
  if (input.departureNote && input.availableUntil) {
    push({ kind: 'travel', startLocal: at(dayEnd), endLocal: at(dayEnd), title: input.departureNote, venue: null, why: 'Departure buffer protected: nothing is scheduled after this time.', bookingRequired: 'no', uncertainty: '' });
  }
  items.sort((a, b) => a.startLocal.localeCompare(b.startLocal));
  // Make long unscheduled gaps explicit rather than silently empty.
  for (let i = 0; i < items.length - 1; i++) {
    const end = parseHHMM(items[i].endLocal.slice(11, 16)); const next = parseHHMM(items[i + 1].startLocal.slice(11, 16));
    if (next - end >= 90 && items[i].kind !== 'travel') {
      items.splice(i + 1, 0, { kind: 'break', startLocal: at(end), endLocal: at(next), title: 'Free time', venue: null, why: 'Unscheduled time to rest or explore nearby at your own pace.', bookingRequired: 'no', uncertainty: '', sources: [], retrievedAt: null });
      i++;
    }
  }
  return { items, missing: [...new Set(missing)], notes: [...new Set(notes)] };
}

/** Parse Google-style weekday descriptions ("Monday: 9:00 AM – 5:00 PM", "Closed", "Open 24 hours") into windows for a date. */
export function windowsForDate(weekdayDescriptions: string[] | null | undefined, date: string): OpenWindow[] | null {
  if (!weekdayDescriptions || !weekdayDescriptions.length) return null;
  const dayName = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const line = weekdayDescriptions.find((l) => l.toLowerCase().startsWith(dayName.toLowerCase()));
  if (!line) return null;
  const rest = line.slice(line.indexOf(':') + 1).trim();
  if (/closed/i.test(rest)) return [];
  if (/24 hours/i.test(rest)) return [{ open: 0, close: 1440 }];
  const out: OpenWindow[] = [];
  for (const part of rest.split(',')) {
    const m = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*[–-]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i.exec(part.replace(/ /g, ' '));
    if (!m) continue;
    const to24 = (h: number, mi: number, ap?: string, fallbackAp?: string) => {
      const a = (ap ?? fallbackAp)?.toUpperCase();
      let hh = h % 12; if (a === 'PM') hh += 12; if (!a) hh = h;
      return hh * 60 + mi;
    };
    const open = to24(Number(m[1]), Number(m[2] ?? 0), m[3], m[6]);
    let close = to24(Number(m[4]), Number(m[5] ?? 0), m[6]);
    if (close <= open) close += 1440;
    out.push({ open, close });
  }
  return out.length ? out : null;
}
