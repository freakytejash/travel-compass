// Accommodation night-coverage rules and ranking.
import type { StayOption } from '../../shared/types.ts';
import { addDays, dateRange, daysBetween, haversineKm } from './time.ts';

export interface StopWindow {
  stopId: string;
  name: string;
  arriveDate: string; // date the traveller arrives at the stop (local)
  departDate: string; // date the traveller leaves the stop (local)
  /** Local arrival clock time at the stop if known ('HH:mm'). Early-morning arrivals may need the previous night. */
  arrivalTime?: string | null;
  /** Nights spent on overnight transport leaving this stop (dates of those nights) – no bed required. */
  overnightTransportNights?: string[];
}

export interface RequiredNight { date: string; stopId: string; name: string }
export interface CoverageAdvice { stopId: string; message: string }

/**
 * Nights requiring accommodation. A night is identified by its check-in date.
 * - Each stop needs the nights from arriveDate up to (but excluding) departDate.
 * - Nights on overnight transport are excluded.
 * - Arrivals between 00:00 and 06:00 produce advice to also book the preceding night (to have a room on arrival);
 *   that night is not added automatically, because it is a cost decision for the traveller.
 */
export function requiredNights(stops: StopWindow[]): { nights: RequiredNight[]; advice: CoverageAdvice[] } {
  const nights: RequiredNight[] = [];
  const advice: CoverageAdvice[] = [];
  for (const s of stops) {
    if (s.departDate < s.arriveDate) throw new Error(`Stop ${s.name} departs before it arrives`);
    const skip = new Set(s.overnightTransportNights ?? []);
    for (let d = s.arriveDate; d < s.departDate; d = addDays(d, 1)) {
      if (!skip.has(d)) nights.push({ date: d, stopId: s.stopId, name: s.name });
    }
    if (s.arrivalTime && s.arrivalTime < '06:00') {
      advice.push({ stopId: s.stopId, message: `You arrive in ${s.name} at ${s.arrivalTime}. Standard check-in is in the afternoon; consider booking the night of ${addDays(s.arriveDate, -1)} so a room is ready, or plan a luggage drop.` });
    }
  }
  const seen = new Map<string, RequiredNight>();
  for (const n of nights) {
    const prev = seen.get(n.date);
    if (prev) throw new Error(`Stops ${prev.name} and ${n.name} both claim the night of ${n.date}`);
    seen.set(n.date, n);
  }
  return { nights, advice };
}

export interface CoverageReport {
  ok: boolean;
  gaps: RequiredNight[];
  overlaps: { date: string; stays: string[] }[];
  wrongStop: { date: string; stay: string; expectedStop: string }[];
}

export function checkCoverage(required: RequiredNight[], stays: { id: string; stopId: string; checkIn: string; checkOut: string }[]): CoverageReport {
  const byNight = new Map<string, { id: string; stopId: string }[]>();
  for (const s of stays) {
    if (s.checkOut <= s.checkIn) continue;
    for (const d of dateRange(s.checkIn, addDays(s.checkOut, -1))) {
      const arr = byNight.get(d) ?? []; arr.push({ id: s.id, stopId: s.stopId }); byNight.set(d, arr);
    }
  }
  const gaps: RequiredNight[] = []; const overlaps: CoverageReport['overlaps'] = []; const wrongStop: CoverageReport['wrongStop'] = [];
  for (const n of required) {
    const covering = byNight.get(n.date) ?? [];
    if (!covering.length) gaps.push(n);
    if (covering.length > 1) overlaps.push({ date: n.date, stays: covering.map((c) => c.id) });
    for (const c of covering) if (c.stopId !== n.stopId) wrongStop.push({ date: n.date, stay: c.id, expectedStop: n.name });
  }
  for (const [date, covering] of byNight) {
    if (!required.some((r) => r.date === date) && covering.length) overlaps.push({ date, stays: covering.map((c) => c.id) });
  }
  return { ok: !gaps.length && !overlaps.length && !wrongStop.length, gaps, overlaps, wrongStop };
}

export interface StayRankContext {
  preference: 'any' | 'private' | 'dorm';
  occupancy: number;
  currency: string;
  /** Centroid of planned activities, and the main arrival transport hub. */
  activityCentre: { lat: number; lng: number } | null;
  transportHub: { lat: number; lng: number } | null;
  valueOfTimePerHour: number;
  /** Planning assumption for local transport cost per km beyond walking distance. */
  localTransportCostPerKm: number;
}

export interface ScoredStay {
  stay: StayOption;
  effectiveCost: number;
  distanceToActivitiesKm: number | null;
  distanceToHubKm: number | null;
  notes: string[];
}

export function scoreStay(s: StayOption, ctx: StayRankContext): ScoredStay {
  const notes: string[] = [];
  let cost = s.total.amount;
  if (s.dueAtProperty && s.dueAtProperty.amount > 0 && s.dueAtProperty.currency === s.total.currency) {
    notes.push(`${s.dueAtProperty.currency} ${s.dueAtProperty.amount.toFixed(2)} payable at the property is included in the total.`);
  }
  const dAct = ctx.activityCentre ? haversineKm(s, ctx.activityCentre) : null;
  const dHub = ctx.transportHub ? haversineKm(s, ctx.transportHub) : null;
  if (dAct !== null && dAct > 1.5) {
    const dailyKm = (dAct - 1.5) * 2;
    const transport = dailyKm * ctx.localTransportCostPerKm * s.nights;
    const time = ((dailyKm / 20) * ctx.valueOfTimePerHour) * s.nights;
    cost += transport + time;
    notes.push(`About ${dAct.toFixed(1)} km from planned activities (adds daily travel).`);
  }
  if (s.cancellation.refundable === false) { cost += s.total.amount * 0.05; notes.push('Non-refundable.'); }
  else if (s.cancellation.freeUntil) notes.push(`Free cancellation until ${s.cancellation.freeUntil.slice(0, 10)}.`);
  if (s.reviewScore !== null) {
    if (s.reviewScore < 7) { cost += s.total.amount * 0.08; notes.push(`Lower guest score (${s.reviewScore.toFixed(1)}).`); }
    else if (s.reviewScore >= 8.5) cost -= s.total.amount * 0.03;
  } else notes.push('No guest review score available.');
  return { stay: s, effectiveCost: Math.round(cost * 100) / 100, distanceToActivitiesKm: dAct, distanceToHubKm: dHub, notes };
}

export function suitable(s: StayOption, ctx: StayRankContext): boolean {
  if (s.total.currency !== ctx.currency) return false;
  if (s.occupancy < ctx.occupancy) return false;
  if (ctx.preference === 'private' && s.roomKind === 'dorm') return false;
  if (ctx.preference === 'dorm' && s.roomKind === 'private') return false;
  return true;
}

export function rankStays(options: StayOption[], ctx: StayRankContext, now = new Date()) {
  const usable = options.filter((o) => suitable(o, ctx) && !(o.expiresAt && new Date(o.expiresAt) <= now));
  const scored = usable.map((o) => scoreStay(o, ctx));
  if (!scored.length) return { recommended: null, cheapest: null, comfortable: null, considered: 0, excluded: options.length };
  const recommended = [...scored].sort((a, b) => a.effectiveCost - b.effectiveCost)[0];
  const cheapest = [...scored].sort((a, b) => a.stay.total.amount - b.stay.total.amount)[0];
  const comfortable = scored
    .filter((s) => s !== recommended && s.stay.total.amount <= recommended.stay.total.amount * 1.6)
    .filter((s) => (s.stay.reviewScore ?? 0) > (recommended.stay.reviewScore ?? 0) || (s.stay.rating ?? 0) > (recommended.stay.rating ?? 0))
    .sort((a, b) => (b.stay.reviewScore ?? 0) - (a.stay.reviewScore ?? 0) || (b.stay.rating ?? 0) - (a.stay.rating ?? 0))[0] ?? null;
  return { recommended, cheapest, comfortable, considered: scored.length, excluded: options.length - scored.length };
}

export function stayNights(checkIn: string, checkOut: string) { return daysBetween(checkIn, checkOut); }
