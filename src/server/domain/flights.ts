// Deterministic ranking of flight offers actually returned by a provider.
import type { FlightOffer, Money } from '../../shared/types.ts';
import { hhmm, parseHHMM } from './time.ts';

export interface FlightRankContext {
  needsCheckedBag: boolean;
  /** Planning estimate when an offer does not include a checked bag; labelled as an estimate in the explanation. */
  checkedBagEstimate: number;
  valueOfTimePerHour: number;
  /** Ground transfer cost estimates per airport IATA code (home side and destination side). */
  airportTransferCost: Record<string, number>;
  airportTransferMinutes: Record<string, number>;
  currency: string;
}

export interface ScoredFlight {
  offer: FlightOffer;
  effectiveCost: number;
  components: { label: string; amount: number; estimate: boolean }[];
  travelMinutes: number;
  connections: number;
  flags: string[];
}

export interface FlightShortlist {
  recommended: ScoredFlight | null;
  cheapest: ScoredFlight | null;
  convenient: ScoredFlight | null;
  explanation: { recommended: string; cheapest: string; convenient: string | null };
  consideredCount: number;
  excludedCount: number;
  excludedReasons: string[];
}

export function totalTravelMinutes(o: FlightOffer): number {
  return o.slices.reduce((s, sl) => s + sl.durationMinutes, 0);
}

export function connectionCount(o: FlightOffer): number {
  return o.slices.reduce((s, sl) => s + Math.max(0, sl.segments.length - 1), 0);
}

export function scoreFlight(o: FlightOffer, ctx: FlightRankContext): ScoredFlight {
  const components: ScoredFlight['components'] = [{ label: 'Fare total', amount: o.total.amount, estimate: false }];
  const flags: string[] = [];
  if (ctx.needsCheckedBag && o.baggage.checkedBags < 1) {
    components.push({ label: 'Checked bag (not included; planning estimate)', amount: ctx.checkedBagEstimate, estimate: true });
    flags.push(o.baggage.source === 'unknown' ? 'Baggage allowance not reported by provider' : 'No checked bag included');
  }
  const airports = new Set<string>();
  for (const sl of o.slices) { airports.add(sl.from); airports.add(sl.to); }
  let transferMinutes = 0;
  for (const a of airports) {
    const c = ctx.airportTransferCost[a];
    if (c !== undefined) components.push({ label: `Ground transfer ${a} (both ways counted once per airport use)`, amount: c, estimate: true });
    transferMinutes += ctx.airportTransferMinutes[a] ?? 0;
  }
  const travelMinutes = totalTravelMinutes(o);
  const timeCost = ((travelMinutes + transferMinutes) / 60) * ctx.valueOfTimePerHour;
  components.push({ label: 'Value of travel time', amount: Math.round(timeCost * 100) / 100, estimate: true });

  let penalty = 0;
  for (const sl of o.slices) {
    for (const l of sl.layovers) {
      if (l.overnight) { penalty += 60; flags.push(`Overnight layover at ${l.airport}`); }
      else if (l.minutes > 300) { penalty += 20; flags.push(`Long layover at ${l.airport} (${Math.round(l.minutes / 60)}h)`); }
      if (l.minutes < 50) { penalty += 25; flags.push(`Tight connection at ${l.airport} (${l.minutes} min)`); }
    }
    const first = sl.segments[0]; const last = sl.segments[sl.segments.length - 1];
    const dep = parseHHMM(hhmm(first.departLocal)); const arr = parseHHMM(hhmm(last.arriveLocal));
    if (dep < 6 * 60) { penalty += 30; flags.push(`Very early departure ${hhmm(first.departLocal)} from ${sl.from}`); }
    if (arr >= 23 * 60 || arr < 5 * 60) { penalty += 40; flags.push(`Late-night arrival ${hhmm(last.arriveLocal)} at ${sl.to} (limited public transport)`); }
  }
  if (penalty) components.push({ label: 'Inconvenience (timing, layovers)', amount: penalty, estimate: true });
  const effectiveCost = Math.round(components.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  return { offer: o, effectiveCost, components, travelMinutes, connections: connectionCount(o), flags };
}

function fmt(m: Money) { return `${m.currency} ${m.amount.toFixed(2)}`; }
function hrs(min: number) { return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; }

export function rankFlights(offers: FlightOffer[], ctx: FlightRankContext, now = new Date()): FlightShortlist {
  const excludedReasons: string[] = [];
  const valid = offers.filter((o) => {
    if (o.total.currency !== ctx.currency) { excludedReasons.push(`${o.providerOfferId}: currency ${o.total.currency} differs from ${ctx.currency}`); return false; }
    if (o.expiresAt && new Date(o.expiresAt) <= now) { excludedReasons.push(`${o.providerOfferId}: offer expired`); return false; }
    return true;
  });
  const scored = valid.map((o) => scoreFlight(o, ctx));
  if (!scored.length) {
    return { recommended: null, cheapest: null, convenient: null, explanation: { recommended: 'No valid offers were returned.', cheapest: '', convenient: null }, consideredCount: 0, excludedCount: offers.length, excludedReasons };
  }
  const byEffective = [...scored].sort((a, b) => a.effectiveCost - b.effectiveCost || a.offer.total.amount - b.offer.total.amount);
  const byPrice = [...scored].sort((a, b) => a.offer.total.amount - b.offer.total.amount || a.travelMinutes - b.travelMinutes);
  const recommended = byEffective[0];
  const cheapest = byPrice[0];
  // Convenient: fewest connections, then shortest travel time, within 35% of the recommended fare, and not the same offer.
  const convenientPool = scored
    .filter((s) => s !== recommended && s.offer.total.amount <= recommended.offer.total.amount * 1.35)
    .filter((s) => s.connections < recommended.connections || s.travelMinutes < recommended.travelMinutes - 45)
    .sort((a, b) => a.connections - b.connections || a.travelMinutes - b.travelMinutes);
  const convenient = convenientPool[0] ?? null;

  const n = scored.length;
  let recText = `Best overall value among the ${n} offers retrieved: ${fmt(recommended.offer.total)} fare, ${hrs(recommended.travelMinutes)} total flying time, ${recommended.connections} connection(s).`;
  if (recommended !== cheapest) {
    const diff = recommended.offer.total.amount - cheapest.offer.total.amount;
    recText += ` It costs ${cheapest.offer.total.currency} ${diff.toFixed(2)} more than the lowest fare but saves on ${describeSavings(recommended, cheapest)}.`;
  } else {
    recText += ' It is also the lowest price among the offers retrieved.';
  }
  if (recommended.flags.length) recText += ` Note: ${recommended.flags.join('; ')}.`;
  const cheapText = `Lowest price among the ${n} offers retrieved: ${fmt(cheapest.offer.total)}.` + (cheapest.flags.length ? ` Trade-offs: ${cheapest.flags.join('; ')}.` : '');
  const convText = convenient ? `More convenient: ${convenient.connections} connection(s), ${hrs(convenient.travelMinutes)} flying time, for ${fmt(convenient.offer.total)}.` : null;
  return { recommended, cheapest, convenient, explanation: { recommended: recText, cheapest: cheapText, convenient: convText }, consideredCount: n, excludedCount: offers.length - n, excludedReasons };
}

function describeSavings(a: ScoredFlight, b: ScoredFlight): string {
  const parts: string[] = [];
  const timeSaved = b.travelMinutes - a.travelMinutes;
  if (timeSaved > 0) parts.push(`${hrs(timeSaved)} of travel time`);
  if (a.connections < b.connections) parts.push(`${b.connections - a.connections} fewer connection(s)`);
  const bagA = a.components.find((c) => c.label.startsWith('Checked bag'));
  const bagB = b.components.find((c) => c.label.startsWith('Checked bag'));
  if (!bagA && bagB) parts.push('baggage (a checked bag is included)');
  const fa = a.flags.length; const fb = b.flags.length;
  if (fa < fb) parts.push('inconvenient timings/layovers');
  return parts.length ? parts.join(', ') : 'ground transfers and timing';
}

/** Compares a repriced offer with the selected one. */
export function compareReprice(original: Money, repriced: Money | null, tolerance = 0.005): 'unchanged' | 'increased' | 'decreased' | 'unavailable' {
  if (!repriced) return 'unavailable';
  if (repriced.currency !== original.currency) return 'increased';
  const d = repriced.amount - original.amount;
  if (Math.abs(d) <= original.amount * tolerance) return 'unchanged';
  return d > 0 ? 'increased' : 'decreased';
}
