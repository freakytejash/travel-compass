// Flexible-date search planning and complete-trip-cost comparison.
import { addDays, daysBetween } from './time.ts';

export interface DateCombo {
  outbound: string;
  inbound: string;
  outShift: number;
  inShift: number;
  nights: number;
}

export interface ComboOptions {
  minNights?: number;
  maxNights?: number;
  /** Earliest allowed outbound date (e.g. today + 1). */
  earliest?: string;
}

/** All combinations with independently shifted outbound and return dates within ±flex days. */
export function generateDateCombos(start: string, end: string, flex: number, opts: ComboOptions = {}): DateCombo[] {
  if (flex < 0 || flex > 3) throw new Error('flex must be between 0 and 3');
  const baseNights = daysBetween(start, end);
  const minNights = opts.minNights ?? Math.max(1, baseNights - flex * 2);
  const maxNights = opts.maxNights ?? baseNights + flex * 2;
  const combos: DateCombo[] = [];
  for (let o = -flex; o <= flex; o++) {
    for (let i = -flex; i <= flex; i++) {
      const outbound = addDays(start, o); const inbound = addDays(end, i);
      const nights = daysBetween(outbound, inbound);
      if (nights < minNights || nights > maxNights || nights < 1) continue;
      if (opts.earliest && outbound < opts.earliest) continue;
      combos.push({ outbound, inbound, outShift: o, inShift: i, nights });
    }
  }
  // Original dates first, then by distance from original so that, if a provider limit truncates the plan,
  // the closest alternatives are checked first.
  combos.sort((a, b) => (Math.abs(a.outShift) + Math.abs(a.inShift)) - (Math.abs(b.outShift) + Math.abs(b.inShift)) || a.outShift - b.outShift || a.inShift - b.inShift);
  return combos;
}

export function planSearch(combos: DateCombo[], maxRequests: number): { toCheck: DateCombo[]; skipped: DateCombo[] } {
  return { toCheck: combos.slice(0, maxRequests), skipped: combos.slice(maxRequests) };
}

export interface CostLine { label: string; amount: number; kind: 'quote' | 'estimate' }

export interface ComboCost {
  combo: DateCombo;
  flight: { amount: number; offerId: string } | null;
  stays: { stopName: string; amount: number; offerId: string; nights: number }[] | null;
  lines: CostLine[];
  total: number | null; // null when any required component could not be quoted
  complete: boolean;
  missing: string[];
}

export function computeComboCost(
  combo: DateCombo,
  flight: ComboCost['flight'],
  stays: ComboCost['stays'],
  extras: { transfers: CostLine[]; interCity: CostLine[]; fees: CostLine[] },
): ComboCost {
  const lines: CostLine[] = [];
  const missing: string[] = [];
  if (flight) lines.push({ label: 'Flights (quoted)', amount: flight.amount, kind: 'quote' }); else missing.push('flights');
  if (stays) for (const s of stays) lines.push({ label: `Accommodation ${s.stopName} (${s.nights} nights, quoted)`, amount: s.amount, kind: 'quote' });
  else missing.push('accommodation');
  lines.push(...extras.transfers, ...extras.interCity, ...extras.fees);
  const complete = missing.length === 0;
  const total = complete ? Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 : null;
  return { combo, flight, stays, lines, total, complete, missing };
}

export interface FlexRecommendation {
  original: ComboCost | null;
  recommended: ComboCost | null;
  cheapestFlightCombo: ComboCost | null;
  savings: number | null;
  savingsSupportedByQuotes: boolean;
  tradeOffs: string[];
  coverage: { checked: number; flightOnly: number; skipped: number; failed: number; notes: string[] };
}

export function recommendFlex(costs: ComboCost[], skipped: DateCombo[], failed: DateCombo[]): FlexRecommendation {
  const original = costs.find((c) => c.combo.outShift === 0 && c.combo.inShift === 0) ?? null;
  const complete = costs.filter((c) => c.complete && c.total !== null);
  const recommended = [...complete].sort((a, b) => a.total! - b.total! || (Math.abs(a.combo.outShift) + Math.abs(a.combo.inShift)) - (Math.abs(b.combo.outShift) + Math.abs(b.combo.inShift)))[0] ?? null;
  const withFlight = costs.filter((c) => c.flight);
  const cheapestFlightCombo = [...withFlight].sort((a, b) => a.flight!.amount - b.flight!.amount)[0] ?? null;
  const tradeOffs: string[] = [];
  let savings: number | null = null;
  let supported = false;
  if (recommended && original?.complete && original.total !== null) {
    savings = Math.round((original.total - recommended.total!) * 100) / 100;
    supported = recommended.lines.filter((l) => l.kind === 'estimate').every((l) => original.lines.some((o) => o.label === l.label && o.amount === l.amount));
    if (recommended.combo.nights !== original.combo.nights) {
      tradeOffs.push(`Trip length changes from ${original.combo.nights} to ${recommended.combo.nights} nights.`);
    }
  }
  if (cheapestFlightCombo && recommended && cheapestFlightCombo.combo !== recommended.combo) {
    if (cheapestFlightCombo.complete && cheapestFlightCombo.total !== null) {
      const extra = cheapestFlightCombo.total - recommended.total!;
      tradeOffs.push(`The cheapest flights (${cheapestFlightCombo.combo.outbound} → ${cheapestFlightCombo.combo.inbound}) save ${(recommended.flight!.amount - cheapestFlightCombo.flight!.amount).toFixed(2)} on flights but make the complete trip ${extra.toFixed(2)} more expensive, mainly because of accommodation for ${cheapestFlightCombo.combo.nights} nights.`);
    } else {
      tradeOffs.push(`The cheapest flights (${cheapestFlightCombo.combo.outbound} → ${cheapestFlightCombo.combo.inbound}) could not be fully costed, so they are not recommended without accommodation quotes.`);
    }
  }
  const flightOnly = costs.filter((c) => c.flight && !c.complete).length;
  const notes: string[] = [];
  if (skipped.length) notes.push(`${skipped.length} date combination(s) were not checked because of provider request limits.`);
  if (failed.length) notes.push(`${failed.length} date combination(s) failed to return quotes.`);
  if (flightOnly) notes.push(`${flightOnly} combination(s) have flight quotes but no accommodation quotes, so their complete cost is unknown.`);
  if (!supported && savings !== null) notes.push('Savings include planning estimates that differ between the date options.');
  return {
    original, recommended, cheapestFlightCombo, savings, savingsSupportedByQuotes: supported, tradeOffs,
    coverage: { checked: costs.length, flightOnly, skipped: skipped.length, failed: failed.length, notes },
  };
}

/** Pick which combos deserve accommodation quotes: the original plus the cheapest-by-flight ones (bounded). */
export function combosForStayQuotes(flightPriced: { combo: DateCombo; flight: number }[], limit: number): DateCombo[] {
  const sorted = [...flightPriced].sort((a, b) => a.flight - b.flight).map((x) => x.combo);
  const orig = flightPriced.find((x) => x.combo.outShift === 0 && x.combo.inShift === 0)?.combo;
  const out: DateCombo[] = orig ? [orig] : [];
  for (const c of sorted) { if (out.length >= limit) break; if (!out.includes(c)) out.push(c); }
  return out;
}
