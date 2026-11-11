// Time-zone utilities built on Intl (IANA tz database bundled with Node). Handles DST transitions.

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try { dtf(tz); return true; } catch { return false; }
}

/** UTC instant -> local wall-clock 'YYYY-MM-DDTHH:mm:ss' in tz. */
export function toLocal(instant: Date | string, tz: string): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = Object.fromEntries(dtf(tz).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Offset of tz from UTC in minutes at a given instant. */
export function offsetMinutes(instant: Date, tz: string): number {
  const local = toLocal(instant, tz);
  const asUtc = Date.parse(local + 'Z');
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * Local wall-clock time in tz -> UTC instant. For times skipped by a DST jump, returns the instant just after the gap;
 * for ambiguous (repeated) times, returns the earlier instant.
 */
export function fromLocal(local: string, tz: string): Date {
  const norm = local.length === 16 ? local + ':00' : local;
  const guess = Date.parse(norm + 'Z');
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  const o2 = offsetMinutes(new Date(t), tz);
  t = guess - o2 * 60000;
  if (toLocal(new Date(t), tz) !== norm) {
    // Either a gap (no such local time) or we picked the later of two ambiguous instants.
    const earlier = guess - offsetMinutes(new Date(t - 3600_000), tz) * 60000;
    if (toLocal(new Date(earlier), tz) === norm) return new Date(earlier);
    return new Date(t); // gap: shift forward
  }
  // Ambiguous wall time (DST end): prefer the earlier of the two instants.
  for (const delta of [3600_000, 1800_000]) {
    if (toLocal(new Date(t - delta), tz) === norm) return new Date(t - delta);
  }
  return new Date(t);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function dateRange(start: string, endInclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= endInclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export function addMinutesLocal(local: string, minutes: number, tz: string): string {
  return toLocal(new Date(fromLocal(local, tz).getTime() + minutes * 60000), tz).slice(0, 16);
}

export function minutesBetween(aIso: string | Date, bIso: string | Date): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000);
}

export function hhmm(local: string): string { return local.slice(11, 16); }

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid time ${s}`);
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`Invalid time ${s}`);
  return h * 60 + mi;
}

export function fmtHHMM(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371; const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat); const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
