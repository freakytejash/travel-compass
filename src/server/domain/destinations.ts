// Scores destination candidates using quoted prices, weather (forecast or historical climate) and interests.
import type { Place } from '../../shared/types.ts';

export interface DestinationEvidence {
  place: Place;
  aiRationale: string; // why the AI proposed it (interest fit), shown as explanation, not as a verified fact
  interestTags: string[];
  flight: { amount: number; currency: string; travelMinutes: number; offerId: string } | null;
  stay: { amount: number; currency: string; nights: number } | null;
  weather: { kind: 'forecast' | 'climate'; tempMaxC: number | null; precipitationProbability: number | null; periodLabel: string } | null;
}

export interface ScoredDestination {
  evidence: DestinationEvidence;
  score: number;
  total: number | null;
  withinBudget: boolean | null;
  reasons: string[];
  caveats: string[];
}

export function scoreDestination(e: DestinationEvidence, budget: number | null, interests: string[]): ScoredDestination {
  const reasons: string[] = []; const caveats: string[] = [];
  let score = 50;
  const matched = e.interestTags.filter((t) => interests.map((i) => i.toLowerCase()).includes(t.toLowerCase()));
  if (matched.length) { score += 8 * matched.length; reasons.push(`Matches your interests: ${matched.join(', ')}.`); }
  if (e.aiRationale) reasons.push(e.aiRationale);
  let total: number | null = null;
  if (e.flight && e.stay) {
    total = Math.round((e.flight.amount + e.stay.amount) * 100) / 100;
    reasons.push(`Quoted flights ${e.flight.currency} ${e.flight.amount.toFixed(0)} + accommodation ${e.stay.currency} ${e.stay.amount.toFixed(0)} for ${e.stay.nights} nights = ${e.flight.currency} ${total.toFixed(0)}.`);
  } else {
    if (!e.flight) caveats.push('No flight quote could be retrieved.');
    if (!e.stay) caveats.push('No accommodation quote could be retrieved.');
  }
  let within: boolean | null = null;
  if (total !== null && budget) {
    within = total <= budget * 0.75; // leave room for food, activities and local transport
    score += within ? 15 : -20;
    if (!within) caveats.push(`Flights and accommodation alone use ${Math.round((total / budget) * 100)}% of your budget.`);
  }
  if (e.flight) {
    const h = e.flight.travelMinutes / 60;
    score += h <= 3 ? 10 : h <= 6 ? 3 : -8;
    reasons.push(`About ${h.toFixed(1)} h total flying time on the quoted itinerary.`);
  }
  if (e.weather) {
    const label = e.weather.kind === 'forecast' ? 'Forecast' : 'Historical climate (not a forecast)';
    if (e.weather.tempMaxC !== null) {
      const t = e.weather.tempMaxC;
      const pleasant = t >= 15 && t <= 28;
      score += pleasant ? 10 : t < 5 || t > 33 ? -10 : 0;
      reasons.push(`${label} for ${e.weather.periodLabel}: highs around ${Math.round(t)}°C${e.weather.precipitationProbability !== null ? `, ${Math.round(e.weather.precipitationProbability)}% chance of rain` : ''}.`);
    }
    if (e.weather.precipitationProbability !== null && e.weather.precipitationProbability > 60) score -= 8;
  } else caveats.push('Weather information unavailable.');
  return { evidence: e, score, total, withinBudget: within, reasons, caveats };
}

export function rankDestinations(list: DestinationEvidence[], budget: number | null, interests: string[]): ScoredDestination[] {
  return list.map((e) => scoreDestination(e, budget, interests)).sort((a, b) => b.score - a.score);
}
