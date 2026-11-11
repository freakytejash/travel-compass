// Free venue data from OpenStreetMap via the Overpass API (no key). Opening hours are converted from OSM syntax;
// anything we cannot parse safely is reported as unknown rather than guessed. Data © OpenStreetMap contributors (ODbL).
import { requestJson } from './http.ts';
import type { PlaceResult, PlacesProvider } from './types.ts';
import { haversineKm } from '../domain/time.ts';

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Converts common OSM opening_hours values into weekday descriptions ("Monday: 09:00 – 18:00").
 * Supports "24/7", day ranges/lists, multiple time spans, "off"/"closed" and overnight spans.
 * Returns null for anything with months, week numbers, holidays-only rules, sunrise/sunset or comments.
 */
export function osmHoursToWeekdays(value: string | undefined | null): string[] | null {
  if (!value) return null;
  const v = value.trim();
  if (v === '24/7') return DAY_NAMES.map((d) => `${d}: Open 24 hours`);
  if (/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week|sunrise|sunset|dawn|dusk|easter|"|\[|\|\|)/i.test(v)) return null;
  const spans: (string[] | null)[] = DAYS.map(() => null);
  for (const raw of v.split(';')) {
    let rule = raw.trim();
    if (!rule) continue;
    rule = rule.replace(/\b(PH|SH)\s*(off|closed)?\s*,?/g, '').trim(); // ignore holiday clauses
    if (!rule) continue;
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\s*,?\s*)+)?\s*(.*)$/.exec(rule);
    if (!m) return null;
    const daysPart = (m[1] ?? '').trim(); const timesPart = m[2].trim();
    const days = new Set<number>();
    if (!daysPart) DAYS.forEach((_, i) => days.add(i));
    else for (const tok of daysPart.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [a, b] = tok.split('-').map((x) => DAYS.indexOf(x.trim()));
      if (a < 0 || (b !== undefined && b < 0)) return null;
      if (b === undefined) days.add(a); else for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
    }
    let value: string[];
    if (/^(off|closed)$/i.test(timesPart)) value = [];
    else {
      const ts = timesPart.split(',').map((x) => x.trim()).filter(Boolean);
      if (!ts.length || ts.some((t) => !/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\+?$/.test(t))) return null;
      value = ts.map((t) => t.replace(/\+$/, '').replace(/\s*-\s*/, ' – '));
    }
    for (const d of days) spans[d] = value;
  }
  if (spans.every((s) => s === null)) return null;
  // OSM semantics: days not covered by any rule are closed.
  return DAY_NAMES.map((d, i) => `${d}: ${spans[i] === null || spans[i]!.length === 0 ? 'Closed' : spans[i]!.join(', ')}`);
}

type Category = 'sights' | 'food' | 'hike';

interface OsmElement { type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

function classify(query: string): { cat: Category; filter: (t: Record<string, string>) => boolean; vegetarian: boolean } {
  const q = query.toLowerCase();
  const vegetarian = /vegetarian|vegan/.test(q);
  if (/hik|trail|walk/.test(q)) return { cat: 'hike', filter: () => true, vegetarian };
  if (/breakfast|cafe|café|coffee|bakery|brunch/.test(q)) return { cat: 'food', filter: (t) => ['cafe', 'bakery'].includes(t.amenity ?? t.shop ?? '') || /breakfast|brunch/.test(t.cuisine ?? ''), vegetarian };
  if (/restaurant|lunch|dinner|food in|eat/.test(q) && !/market/.test(q)) return { cat: 'food', filter: (t) => ['restaurant', 'fast_food', 'cafe'].includes(t.amenity ?? ''), vegetarian };
  if (/museum|gallery|indoor/.test(q)) return { cat: 'sights', filter: (t) => ['museum', 'gallery'].includes(t.tourism ?? '') || t.amenity === 'arts_centre', vegetarian };
  if (/art/.test(q)) return { cat: 'sights', filter: (t) => ['museum', 'gallery', 'artwork'].includes(t.tourism ?? '') || t.amenity === 'arts_centre', vegetarian };
  if (/architecture|history|histor|castle|church/.test(q)) return { cat: 'sights', filter: (t) => !!t.historic || t.building === 'cathedral' || t.tourism === 'attraction', vegetarian };
  if (/nature|park|garden|beach/.test(q)) return { cat: 'sights', filter: (t) => ['park', 'garden', 'nature_reserve', 'beach_resort'].includes(t.leisure ?? '') || t.natural === 'beach' || t.tourism === 'viewpoint', vegetarian };
  if (/market/.test(q)) return { cat: 'sights', filter: (t) => t.amenity === 'marketplace', vegetarian };
  if (/music|nightlife|theatre/.test(q)) return { cat: 'sights', filter: (t) => ['theatre', 'arts_centre', 'concert_hall'].includes(t.amenity ?? ''), vegetarian };
  return { cat: 'sights', filter: (t) => t.leisure !== 'park' || !!t.wikidata, vegetarian };
}

function query(cat: Category, lat: number, lng: number): string {
  const a = (r: number) => `(around:${r},${lat.toFixed(5)},${lng.toFixed(5)})`;
  if (cat === 'food') return `[out:json][timeout:25];(nwr["amenity"~"^(restaurant|cafe|fast_food)$"]["name"]${a(2500)};nwr["shop"="bakery"]["name"]${a(1500)};);out center tags 500;`;
  if (cat === 'hike') return `[out:json][timeout:30];(relation["route"="hiking"]["name"]${a(40000)};nwr["leisure"="nature_reserve"]["name"]${a(25000)};);out center tags 80;`;
  return `[out:json][timeout:25];(nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium)$"]["name"]${a(7000)};nwr["historic"~"^(castle|monument|memorial|ruins|archaeological_site|fort|city_gate|manor|palace)$"]["name"]${a(7000)};nwr["building"="cathedral"]["name"]${a(7000)};nwr["leisure"~"^(park|garden)$"]["name"]["wikidata"]${a(7000)};nwr["amenity"~"^(marketplace|theatre|arts_centre)$"]["name"]${a(7000)};);out center tags 400;`;
}

export function osmElementToPlace(e: OsmElement): PlaceResult | null {
  const t = e.tags ?? {};
  const lat = e.lat ?? e.center?.lat; const lng = e.lon ?? e.center?.lon;
  if (!t.name || lat === undefined || lng === undefined) return null;
  const addr = [[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const vegTag = t['diet:vegetarian']; const veganTag = t['diet:vegan'];
  const veg = vegTag === 'only' || veganTag === 'only' || vegTag === 'yes' || veganTag === 'yes' || /vegetarian|vegan/.test(t.cuisine ?? '') ? true : vegTag === 'no' ? false : null;
  const types = [t.tourism, t.historic, t.leisure, t.amenity, t.shop, t.route ? `route_${t.route}` : undefined, t.natural, t.building === 'cathedral' ? 'cathedral' : undefined].filter(Boolean) as string[];
  const facts: string[] = [];
  if (vegTag) facts.push(`diet:vegetarian=${vegTag}`);
  if (veganTag) facts.push(`diet:vegan=${veganTag}`);
  if (t.cuisine) facts.push(`cuisine=${t.cuisine}`);
  if (t.distance) facts.push(`route distance=${t.distance}${/km|mi/.test(t.distance) ? '' : ' km'}`);
  if (t.ascent) facts.push(`ascent=${t.ascent}`);
  if (t.sac_scale) facts.push(`sac_scale=${t.sac_scale}`);
  if (t.network) facts.push(`network=${t.network}`);
  if (t.fee) facts.push(`fee=${t.fee}`);
  if (t.charge) facts.push(`charge=${t.charge}`);
  if (t.reservation) facts.push(`reservation=${t.reservation}`);
  if (t.wheelchair) facts.push(`wheelchair=${t.wheelchair}`);
  if (t.opening_hours) facts.push(`opening_hours=${t.opening_hours}`);
  const website = [t.website, t['contact:website'], t.url].find((x) => x && /^https:\/\//.test(x)) ?? null;
  const summary = [t.description, vegTag === 'only' ? 'Fully vegetarian venue (OpenStreetMap diet:vegetarian=only).' : veganTag === 'only' ? 'Fully vegan venue (OpenStreetMap diet:vegan=only).' : null, t.wikipedia ? `Wikipedia: ${t.wikipedia}` : null].filter(Boolean).join(' ') || null;
  return {
    placeId: `osm:${e.type}/${e.id}`, name: t['name:en'] ?? t.name, address: addr || `${lat.toFixed(5)}, ${lng.toFixed(5)} (no street address in OpenStreetMap)`,
    lat, lng, mapsUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`, website, weekdayDescriptions: osmHoursToWeekdays(t.opening_hours),
    priceLevel: null, priceRange: null, rating: null, servesVegetarianFood: veg,
    servesBreakfast: /breakfast|brunch/.test(t.cuisine ?? '') || t.amenity === 'cafe' || t.shop === 'bakery' ? true : null, servesLunch: null, servesDinner: null,
    reservable: t.reservation === 'required' || t.reservation === 'recommended' ? true : t.reservation === 'no' ? false : null,
    summary, types, businessStatus: t['disused:amenity'] || t['was:amenity'] ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL', attributions: ['© OpenStreetMap contributors'],
    facts: facts.join('; ') || undefined,
  };
}

function notability(p: PlaceResult, t: Record<string, string>, veg: boolean) {
  return (t.wikidata ? 3 : 0) + (t.wikipedia ? 2 : 0) + (p.website ? 1 : 0) + (p.weekdayDescriptions ? 1 : 0) + (veg ? (t['diet:vegetarian'] === 'only' || t['diet:vegan'] === 'only' ? 4 : p.servesVegetarianFood ? 3 : 0) : 0) + (t.tourism === 'attraction' || t.tourism === 'museum' ? 1 : 0);
}

export class OsmPlaces implements PlacesProvider {
  name = 'openstreetmap';
  private url: string; private ua: string;
  private cache = new Map<string, { at: number; data: Promise<OsmElement[]> }>();
  constructor(overpassUrl: string, userAgent: string) { this.url = overpassUrl; this.ua = userAgent; }
  configured() { return true; }

  private fetchCategory(cat: Category, lat: number, lng: number, userId?: string | null): Promise<OsmElement[]> {
    const key = `${cat}:${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;
    const data = requestJson<{ elements: OsmElement[] }>(this.url, {
      provider: 'overpass', operation: `venues.${cat}`, method: 'POST', idempotent: true, retries: 2, timeoutMs: 40000, userId,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': this.ua }, body: new URLSearchParams({ data: query(cat, lat, lng) }),
    }).then((r) => r.elements ?? []);
    this.cache.set(key, { at: Date.now(), data });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    data.catch(() => this.cache.delete(key));
    return data;
  }

  async textSearch(q: string, opts: { near?: { lat: number; lng: number; radiusM: number }; max?: number; userId?: string | null }): Promise<PlaceResult[]> {
    const near = opts.near ?? null;
    if (!near) return [];
    const c = classify(q);
    const elements = await this.fetchCategory(c.cat, near.lat, near.lng, opts.userId);
    const scored = elements.filter((e) => c.filter(e.tags ?? {})).map((e) => ({ e, p: osmElementToPlace(e) })).filter((x) => x.p && x.p.businessStatus === 'OPERATIONAL') as { e: OsmElement; p: PlaceResult }[];
    return scored.map((x) => ({ ...x, s: notability(x.p, x.e.tags ?? {}, c.vegetarian) - haversineKm(near, x.p) / 3 }))
      .sort((a, b) => b.s - a.s).slice(0, opts.max ?? 12).map((x) => x.p);
  }
}
