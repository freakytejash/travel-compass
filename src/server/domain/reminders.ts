// Departure-day timing and notification scheduling.
import { addDays, fromLocal, parseHHMM, toLocal } from './time.ts';

export interface DepartureInput {
  departUtc: string;
  airportTz: string;
  homeTz: string;
  international: boolean;
  checkedBag: boolean;
  checkedIn: boolean;
  /** Door-to-airport transfer minutes. */
  transferMinutes: number;
  transferSource: 'live_traffic' | 'planning_assumption';
  prepMinutes: number;
  /** Extra personal safety margin. */
  extraBufferMinutes?: number;
}

export interface DepartureTimeline {
  arriveAirportUtc: string;
  leaveHomeUtc: string;
  wakeUtc: string;
  arriveAirportLocal: string;
  leaveHomeLocal: string;
  wakeLocal: string;
  airportBufferMinutes: number;
  transferMinutes: number;
  transferSource: DepartureInput['transferSource'];
  explanation: string[];
}

export function airportBuffer(international: boolean, checkedBag: boolean, checkedIn: boolean): number {
  let b = international ? 120 : 90;
  if (!checkedBag && checkedIn) b -= 30;
  if (!checkedIn) b += 15;
  return b;
}

export function computeDepartureTimeline(i: DepartureInput): DepartureTimeline {
  const buffer = airportBuffer(i.international, i.checkedBag, i.checkedIn) + (i.extraBufferMinutes ?? 0);
  const dep = new Date(i.departUtc).getTime();
  const arriveAirport = dep - buffer * 60000;
  const leaveHome = arriveAirport - i.transferMinutes * 60000;
  const wake = leaveHome - i.prepMinutes * 60000;
  const iso = (t: number) => new Date(t).toISOString();
  const explanation = [
    `Airport arrival ${buffer} min before departure (${i.international ? 'international' : 'domestic/Schengen'} flight${i.checkedBag ? ', checked bag' : ''}${i.checkedIn ? '' : ', online check-in not yet confirmed'}).`,
    `Transfer ${i.transferMinutes} min — ${i.transferSource === 'live_traffic' ? 'live traffic estimate at the time of calculation' : 'planning assumption, not live traffic'}.`,
    `Preparation ${i.prepMinutes} min before leaving.`,
  ];
  return {
    arriveAirportUtc: iso(arriveAirport), leaveHomeUtc: iso(leaveHome), wakeUtc: iso(wake),
    arriveAirportLocal: toLocal(new Date(arriveAirport), i.airportTz).slice(0, 16),
    leaveHomeLocal: toLocal(new Date(leaveHome), i.homeTz).slice(0, 16),
    wakeLocal: toLocal(new Date(wake), i.homeTz).slice(0, 16),
    airportBufferMinutes: buffer, transferMinutes: i.transferMinutes, transferSource: i.transferSource, explanation,
  };
}

/** The pre-trip briefing goes out the day before departure at the preferred local time, or immediately if that has passed. */
export function pretripSendAt(departUtc: string, homeTz: string, preferredTime: string, now: Date): { at: Date; late: boolean } {
  parseHHMM(preferredTime);
  const departLocalDate = toLocal(new Date(departUtc), homeTz).slice(0, 10);
  const at = fromLocal(`${addDays(departLocalDate, -1)}T${preferredTime}`, homeTz);
  // Never send a "day before" briefing after departure; if late but before departure, send now.
  if (at.getTime() < now.getTime()) {
    if (now.getTime() < new Date(departUtc).getTime() - 3 * 3600_000) return { at: now, late: true };
    return { at: new Date(NaN), late: true };
  }
  return { at, late: false };
}

/** Daily schedule send instants for each trip day, in the time zone of where the traveller is that day. */
export function dailySendTimes(days: { date: string; timeZone: string }[], preferredTime: string, now: Date): { date: string; at: Date }[] {
  return days
    .map((d) => ({ date: d.date, at: fromLocal(`${d.date}T${preferredTime}`, d.timeZone) }))
    .filter((d) => d.at.getTime() > now.getTime());
}

export function notificationDedupeKey(kind: string, tripId: string, scope: string) {
  return `${kind}:${tripId}:${scope}`;
}

/** Exponential backoff with jitter for job retries, capped. */
export function retryDelayMs(attempt: number, baseMs = 30_000, capMs = 30 * 60_000, rand = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + rand() * (exp / 2));
}
