// Travel windows: when is it cheapest in leave days to go away? Built from the traveller's country's public
// holidays and long weekends (Nager.Date), with plain weekends as a fallback.
import { addDays, dateRange, daysBetween } from './time.ts';

export interface HolidayLike { date: string; name: string; global?: boolean }
export interface LongWeekendLike { startDate: string; endDate: string; dayCount: number; needBridgeDay: boolean }

export interface TravelWindow {
  id: string;            // `${start}_${end}`
  start: string;         // departure date
  end: string;           // return date
  nights: number;
  kind: 'long_weekend' | 'holiday_week' | 'weekend';
  label: string;         // e.g. "Christmas Day long weekend"
  holidays: string[];    // holiday names inside the window
  leaveDays: number;     // weekdays off work needed (not weekends, not public holidays)
  needsBridgeDay: boolean;
}

const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat

export function leaveDaysNeeded(start: string, end: string, holidayDates: Set<string>): number {
  return dateRange(start, end).filter((d) => { const w = weekday(d); return w !== 0 && w !== 6 && !holidayDates.has(d); }).length;
}

function mk(start: string, end: string, kind: TravelWindow['kind'], hol: HolidayLike[], holidayDates: Set<string>, needsBridgeDay: boolean): TravelWindow {
  const names = [...new Set(hol.filter((h) => h.date >= start && h.date <= end).map((h) => h.name))];
  const nights = daysBetween(start, end);
  const label = names.length ? `${names.join(' & ')} ${kind === 'holiday_week' ? 'week' : 'long weekend'}` : kind === 'weekend' ? 'Weekend getaway' : 'Long weekend';
  return { id: `${start}_${end}`, start, end, nights, kind, label, holidays: names, leaveDays: leaveDaysNeeded(start, end, holidayDates), needsBridgeDay };
}

/**
 * Candidate trip windows between `from` and `until`, best first by date.
 * - every long weekend (3+ days off, possibly with one bridge day);
 * - a "holiday week" around each weekday public holiday (Sat → following/preceding Sun, 8 nights max) for longer trips;
 * - plain Fri→Sun weekends when there are fewer than `minCount` holiday windows.
 */
export function travelWindows(o: { from: string; until: string; holidays: HolidayLike[]; longWeekends: LongWeekendLike[]; minCount?: number; includeWeeks?: boolean }): TravelWindow[] {
  const nationwide = o.holidays.filter((h) => h.global !== false);
  const holidayDates = new Set(nationwide.map((h) => h.date));
  const out = new Map<string, TravelWindow>();
  const inRange = (s: string, e: string) => s >= o.from && e <= o.until && e > s;
  for (const lw of o.longWeekends) {
    if (!inRange(lw.startDate, lw.endDate)) continue;
    const w = mk(lw.startDate, lw.endDate, 'long_weekend', nationwide, holidayDates, lw.needBridgeDay);
    out.set(w.id, w);
  }
  if (o.includeWeeks !== false) {
    for (const h of nationwide) {
      const wd = weekday(h.date);
      if (wd === 0 || wd === 6) continue;
      // Saturday before → Sunday after: a full week away using the holiday to save one leave day.
      const start = addDays(h.date, -((wd + 1) % 7)); const end = addDays(start, 8);
      if (!inRange(start, end)) continue;
      const w = mk(start, end, 'holiday_week', nationwide, holidayDates, false);
      if (!out.has(w.id)) out.set(w.id, w);
    }
  }
  const list = [...out.values()];
  if (list.length < (o.minCount ?? 4)) {
    // Fallback: the next few Friday → Sunday weekends (Friday evening departure assumed).
    let d = o.from;
    while (weekday(d) !== 5) d = addDays(d, 1);
    for (let i = 0; i < 6 && list.length < (o.minCount ?? 4) + 2; i++, d = addDays(d, 7)) {
      const end = addDays(d, 2);
      if (!inRange(d, end) || out.has(`${d}_${end}`)) continue;
      const w = mk(d, end, 'weekend', nationwide, holidayDates, false);
      w.leaveDays = 0; // evening departure after work
      list.push(w);
    }
  }
  return list.sort((a, b) => a.start.localeCompare(b.start) || a.nights - b.nights);
}

/** Picks the windows to price: prefer few leave days per night away, spread over different dates. */
export function pickWindowsToPrice(windows: TravelWindow[], max: number): TravelWindow[] {
  const ranked = [...windows].sort((a, b) => (a.leaveDays / Math.max(1, a.nights)) - (b.leaveDays / Math.max(1, b.nights)) || a.start.localeCompare(b.start));
  const chosen: TravelWindow[] = [];
  for (const w of ranked) {
    if (chosen.length >= max) break;
    if (chosen.some((c) => !(w.end <= c.start || w.start >= c.end))) continue; // no overlapping windows
    chosen.push(w);
  }
  return chosen.sort((a, b) => a.start.localeCompare(b.start));
}

export interface IdeaCandidate {
  windowId: string;
  name: string; country: string; iata: string;
  flightPrice: number | null; hotelPerNight: number | null; nights: number;
  flightMinutes: number | null; stops: number | null;
  weather?: { tempMaxC: number | null; precipitationProbability: number | null; kind: 'forecast' | 'climate' } | null;
}

export interface ScoredIdea<T extends IdeaCandidate = IdeaCandidate> { idea: T; total: number | null; totalIsEstimate: boolean; withinBudget: boolean | null; score: number; reasons: string[]; caveats: string[] }

/** Ranks destination ideas by estimated total cost (flight + nights × hotel from-price), travel time, stops and weather. */
export function scoreIdeas<T extends IdeaCandidate>(ideas: T[], budget: number | null, currency: string): ScoredIdea<T>[] {
  return ideas.filter((i) => i.flightPrice !== null).map((i) => {
    const hotel = i.hotelPerNight !== null ? i.hotelPerNight * i.nights : null;
    const total = i.flightPrice! + (hotel ?? 0);
    const reasons: string[] = []; const caveats: string[] = [];
    let score = total;
    if (i.flightMinutes !== null) { score += (i.flightMinutes / 60) * 12; if (i.flightMinutes <= 150) reasons.push(`Short flight (${Math.round(i.flightMinutes / 60 * 10) / 10} h)`); }
    if (i.stops === 0) reasons.push('Direct flight available'); else if ((i.stops ?? 0) > 0) { score += 40 * i.stops!; caveats.push(`${i.stops} stop${i.stops! > 1 ? 's' : ''} on the cheapest flight`); }
    if (hotel === null) caveats.push('No hotel price shown — total covers the flight only');
    const w = i.weather;
    if (w?.tempMaxC !== null && w?.tempMaxC !== undefined) {
      if (w.tempMaxC >= 18 && w.tempMaxC <= 30) { score -= 25; reasons.push(`Pleasant ${w.kind === 'forecast' ? 'forecast' : 'typical weather'} (~${Math.round(w.tempMaxC)}°C)`); }
      else if (w.tempMaxC < 8) { score += 20; caveats.push(`Cold (${w.kind === 'forecast' ? 'forecast' : 'typically'} ~${Math.round(w.tempMaxC)}°C)`); }
    }
    if ((w?.precipitationProbability ?? 0) >= 60) { score += 15; caveats.push(`Rain likely (${Math.round(w!.precipitationProbability!)}%)`); }
    const withinBudget = budget === null ? null : total <= budget;
    if (withinBudget === true) reasons.push(`Fits your ${currency} ${budget} budget (estimate)`);
    if (withinBudget === false) { score += 1000; caveats.push(`Over your ${currency} ${budget} budget (estimate ${currency} ${Math.round(total)})`); }
    return { idea: i, total: Math.round(total), totalIsEstimate: true, withinBudget, score, reasons, caveats };
  }).sort((a, b) => a.score - b.score);
}
