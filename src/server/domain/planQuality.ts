// Guards against generic placeholder content being presented as a completed plan.
import type { ItineraryItem } from '../../shared/types.ts';

export const PLACEHOLDER_PATTERNS: RegExp[] = [
  /needs current research/i,
  /choose a local (activity|restaurant)/i,
  /find a (vegetarian|vegan|local)? ?(breakfast|lunch|dinner|restaurant|spot|café|cafe)/i,
  /price not checked/i,
  /\b(tbd|tba|to be decided|placeholder|lorem ipsum)\b/i,
  /\b(some|a nice|a local|any) (restaurant|café|cafe|museum|park|attraction)\b/i,
  /^(restaurant|café|cafe|museum|park|activity|hike)$/i,
];

const VENUE_KINDS = new Set(['breakfast', 'lunch', 'dinner', 'activity', 'hike']);

export interface QualityIssue { itemTitle: string; problem: string }

export function validateItems(items: ItineraryItem[]): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const it of items) {
    const text = `${it.title} ${it.venue?.name ?? ''}`;
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(it.title) || (it.venue && p.test(it.venue.name)))) issues.push({ itemTitle: it.title, problem: 'generic placeholder text' });
    if (VENUE_KINDS.has(it.kind)) {
      if (!it.venue) { issues.push({ itemTitle: it.title, problem: 'no named venue' }); continue; }
      if (!it.venue.address) issues.push({ itemTitle: text, problem: 'missing address' });
      if (!it.sources.length) issues.push({ itemTitle: text, problem: 'no source' });
      if (!it.retrievedAt) issues.push({ itemTitle: text, problem: 'no retrieval timestamp' });
      if (it.venue.price && it.venue.price.provenance === 'source' && !it.venue.price.sourceUrl) issues.push({ itemTitle: text, problem: 'price claims a source but has no source link' });
    }
  }
  return issues;
}

/** Sanitises untrusted text before it is shown or passed to the AI as data. */
export function sanitiseExternalText(s: string, max = 4000): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
