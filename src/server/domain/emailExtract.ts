// Deterministic reservation extraction from confirmation emails. Email content is untrusted data:
// it is only pattern-matched, never executed or followed, and never treated as instructions.
import crypto from 'node:crypto';

export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: string; // ISO
  text: string;
}

export interface ExtractedReservation {
  kind: 'flight' | 'stay' | 'activity' | 'transport' | 'other';
  providerName: string;
  confirmationCode: string | null;
  startDate: string | null; // YYYY-MM-DD
  endDate: string | null;
  details: Record<string, unknown>;
  confidence: number; // 0..1
  sourceRef: string;
  evidence: string[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

const KNOWN_SENDERS: { re: RegExp; name: string; kind: ExtractedReservation['kind'] }[] = [
  { re: /booking\.com/i, name: 'Booking.com', kind: 'stay' },
  { re: /airbnb\./i, name: 'Airbnb', kind: 'stay' },
  { re: /hostelworld/i, name: 'Hostelworld', kind: 'stay' },
  { re: /expedia/i, name: 'Expedia', kind: 'other' },
  { re: /ryanair/i, name: 'Ryanair', kind: 'flight' },
  { re: /easyjet/i, name: 'easyJet', kind: 'flight' },
  { re: /brusselsairlines|brussels airlines/i, name: 'Brussels Airlines', kind: 'flight' },
  { re: /klm\./i, name: 'KLM', kind: 'flight' },
  { re: /lufthansa/i, name: 'Lufthansa', kind: 'flight' },
  { re: /vueling/i, name: 'Vueling', kind: 'flight' },
  { re: /transavia/i, name: 'Transavia', kind: 'flight' },
  { re: /wizzair|wizz air/i, name: 'Wizz Air', kind: 'flight' },
  { re: /airfrance|air france/i, name: 'Air France', kind: 'flight' },
  { re: /duffel/i, name: 'Duffel', kind: 'flight' },
  { re: /getyourguide/i, name: 'GetYourGuide', kind: 'activity' },
  { re: /viator/i, name: 'Viator', kind: 'activity' },
  { re: /tiqets/i, name: 'Tiqets', kind: 'activity' },
  { re: /sncb|nmbs|belgiantrain/i, name: 'SNCB/NMBS', kind: 'transport' },
  { re: /eurostar/i, name: 'Eurostar', kind: 'transport' },
  { re: /trainline/i, name: 'Trainline', kind: 'transport' },
];

export function isLikelyConfirmation(m: Pick<EmailMessage, 'subject' | 'text'>): boolean {
  const s = `${m.subject}\n${m.text.slice(0, 2000)}`.toLowerCase();
  if (/(newsletter|unsubscribe from marketing|deal of the day|% off|sale ends)/.test(m.subject.toLowerCase())) return false;
  return /(confirm|booking|reservation|itinerary|e-?ticket|your trip|boarding pass)/.test(s);
}

export function parseDates(text: string): string[] {
  const found: { idx: number; date: string }[] = [];
  const add = (idx: number, y: number, mo: number, d: number) => {
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return;
    found.push({ idx, date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` });
  };
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(m.index!, +m[1], +m[2], +m[3]);
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})\b/g)) {
    const mo = MONTHS[m[2].toLowerCase()]; if (mo) add(m.index!, +m[3], mo, +m[1]);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/g)) {
    const mo = MONTHS[m[1].toLowerCase()]; if (mo) add(m.index!, +m[3], mo, +m[2]);
  }
  // dd/mm/yyyy (European convention; ambiguous dates are flagged by lower confidence elsewhere)
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/g)) add(m.index!, +m[3], +m[2], +m[1]);
  return found.sort((a, b) => a.idx - b.idx).map((f) => f.date).filter((d, i, arr) => arr.indexOf(d) === i);
}

function findCode(text: string): string | null {
  const m = /(booking (?:reference|number|code)|confirmation (?:number|code)|reservation (?:number|code)|PNR|record locator|booking ref(?:erence)?\.?)\s*(?:is|:|#|no\.?)?\s*([A-Z0-9]{5,12})\b/i.exec(text);
  return m ? m[2].toUpperCase() : null;
}

function findLabelledDate(text: string, labels: string): string | null {
  const re = new RegExp(`(${labels})[^\\n]{0,40}`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  return parseDates(m[0])[0] ?? null;
}

export function extractReservation(m: EmailMessage): ExtractedReservation | null {
  if (!isLikelyConfirmation(m)) return null;
  const evidence: string[] = [];
  const all = `${m.subject}\n${m.text}`;
  const sender = KNOWN_SENDERS.find((s) => s.re.test(m.from) || s.re.test(m.subject));
  let kind: ExtractedReservation['kind'] = sender?.kind ?? 'other';
  if (/\b(check-?in|check-?out|nights?|guest(s)?|room)\b/i.test(all) && /(hotel|apartment|hostel|property|stay|accommodation|room)/i.test(all) && kind !== 'flight') kind = 'stay';
  const flightNos = [...all.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b/g)]
    .map((x) => `${x[1]}${x[2]}`)
    .filter((f) => !/^(20|19)\d{2}$/.test(f));
  const airports = [...all.matchAll(/\(([A-Z]{3})\)|\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/g)].flatMap((x) => [x[1], x[2], x[3]].filter(Boolean));
  if (kind === 'other' && flightNos.length && airports.length >= 2) kind = 'flight';

  const code = findCode(all);
  if (code) evidence.push(`confirmation code ${code}`);
  const dates = parseDates(all);
  let start: string | null = null; let end: string | null = null;
  const details: Record<string, unknown> = {};
  let conf = 0.2;
  if (sender) { conf += 0.15; evidence.push(`sender ${sender.name}`); }
  if (code) conf += 0.25;

  if (kind === 'stay') {
    start = findLabelledDate(all, 'check-?in|arrival') ?? dates[0] ?? null;
    end = findLabelledDate(all, 'check-?out|departure') ?? dates[1] ?? null;
    const prop = /(?:your (?:booking|reservation|stay) (?:at|in)|booked:?)\s+([^\n.!,]{3,80})/i.exec(all) ?? /^(?:confirmation|booking confirmed)[:\s–-]+([^\n]{3,80})$/im.exec(m.subject);
    if (prop) { details.propertyName = prop[1].trim(); conf += 0.1; evidence.push('property name'); }
    if (start && end) { conf += 0.2; evidence.push('check-in/out dates'); }
  } else if (kind === 'flight') {
    details.flightNumbers = [...new Set(flightNos)].slice(0, 6);
    details.airports = [...new Set(airports)].slice(0, 6);
    start = dates[0] ?? null; end = dates.length > 1 ? dates[dates.length - 1] : null;
    if ((details.flightNumbers as string[]).length) { conf += 0.15; evidence.push('flight numbers'); }
    if (start) { conf += 0.1; evidence.push('travel date'); }
    // A booking confirmation is not proof of check-in.
    details.checkInMentioned = /you(?:'re| are) checked in|boarding pass/i.test(all);
  } else {
    start = dates[0] ?? null;
    if (start) conf += 0.1;
  }
  if (!code && !start) return null;
  return {
    kind, providerName: sender?.name ?? (/^.*?<?([^@<\s]+@[^>\s]+)>?$/.exec(m.from)?.[1].split('@')[1] ?? 'unknown'),
    confirmationCode: code, startDate: start, endDate: end, details, confidence: Math.min(0.95, Math.round(conf * 100) / 100), sourceRef: m.id, evidence,
  };
}

export function dedupeKey(r: Pick<ExtractedReservation, 'kind' | 'providerName' | 'confirmationCode' | 'startDate'>): string {
  if (r.confirmationCode) return `${r.kind}:${r.confirmationCode.toUpperCase()}`;
  return `${r.kind}:` + crypto.createHash('sha256').update(`${r.providerName.toLowerCase()}|${r.startDate ?? ''}`).digest('hex').slice(0, 24);
}

export function associateTrip(r: Pick<ExtractedReservation, 'startDate' | 'endDate'>, trips: { id: string; startDate: string | null; endDate: string | null }[]): string | null {
  if (!r.startDate) return null;
  const candidates = trips.filter((t) => t.startDate && t.endDate && r.startDate! >= addDaysStr(t.startDate, -2) && r.startDate! <= addDaysStr(t.endDate, 1));
  return candidates.length === 1 ? candidates[0].id : null;
}

function addDaysStr(d: string, n: number) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
