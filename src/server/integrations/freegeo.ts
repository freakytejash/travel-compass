// Free, key-less geography: Photon (OpenStreetMap geocoder) for city search, the public-domain OurAirports
// dataset for airports/IATA codes, and Open-Meteo's timezone=auto for IANA time zones.
import fs from 'node:fs';
import path from 'node:path';
import type { Place } from '../../shared/types.ts';
import { haversineKm } from '../domain/time.ts';
import { ProviderError, requestJson } from './http.ts';

export interface Airport { iata: string; name: string; city: string; country: string; lat: number; lng: number; size: 'large' | 'medium' | 'small' }

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** OurAirports airports.csv -> airports with IATA codes and scheduled service. */
export function parseOurAirports(csv: string): Airport[] {
  const [head, ...rows] = parseCsv(csv);
  const idx = (n: string) => head.indexOf(n);
  const [iT, iN, iLat, iLng, iC, iM, iS, iI] = ['type', 'name', 'latitude_deg', 'longitude_deg', 'iso_country', 'municipality', 'scheduled_service', 'iata_code'].map(idx);
  if ([iT, iN, iLat, iLng, iI].some((x) => x < 0)) throw new Error('Unrecognised airports.csv header');
  const out: Airport[] = [];
  for (const r of rows) {
    const iata = (r[iI] ?? '').trim();
    const type = r[iT];
    if (!/^[A-Z]{3}$/.test(iata) || !['large_airport', 'medium_airport', 'small_airport'].includes(type)) continue;
    if (iS >= 0 && r[iS] !== 'yes') continue;
    out.push({ iata, name: r[iN], city: iM >= 0 ? r[iM] : '', country: iC >= 0 ? r[iC] : '', lat: Number(r[iLat]), lng: Number(r[iLng]), size: type === 'large_airport' ? 'large' : type === 'medium_airport' ? 'medium' : 'small' });
  }
  return out;
}

const SIZE_RANK = { large: 0, medium: 1, small: 2 };

export interface FreeGeoOptions {
  airportsUrl: string;
  dataDir: string;
  photonUrl: string;
  /** Returns the IANA time zone for coordinates (Open-Meteo by default). */
  tzLookup?: (lat: number, lng: number) => Promise<string>;
  airports?: Airport[]; // injected in tests
}

export class FreeGeo {
  private o: FreeGeoOptions;
  private airports: Airport[] | null;
  private byIata = new Map<string, Airport>();
  private loading: Promise<Airport[]> | null = null;
  private tzCache = new Map<string, Promise<string>>();
  constructor(o: FreeGeoOptions) {
    this.o = o; this.airports = o.airports ?? null;
    if (this.airports) for (const a of this.airports) this.byIata.set(a.iata, a);
  }

  /** Loads airports from data/airports.csv, downloading it once from OurAirports if missing. */
  async loadAirports(): Promise<Airport[]> {
    if (this.airports) return this.airports;
    this.loading ??= (async () => {
      const file = path.join(this.o.dataDir, 'airports.csv');
      let csv: string;
      if (fs.existsSync(file)) csv = fs.readFileSync(file, 'utf8');
      else {
        const res = await fetch(this.o.airportsUrl).catch((e) => { throw new ProviderError('ourairports', `download failed: ${e.message}`, null, true); });
        if (!res.ok) throw new ProviderError('ourairports', `download failed HTTP ${res.status}`, res.status, true);
        csv = await res.text();
        fs.mkdirSync(this.o.dataDir, { recursive: true });
        fs.writeFileSync(file, csv);
      }
      const list = parseOurAirports(csv);
      this.airports = list;
      for (const a of list) this.byIata.set(a.iata, a);
      return list;
    })();
    try { return await this.loading; } catch (e) { this.loading = null; throw e; }
  }

  async airport(iata: string): Promise<Airport | null> { await this.loadAirports(); return this.byIata.get(iata) ?? null; }

  async nearbyAirports(lat: number, lng: number, radiusKm = 90, max = 4): Promise<Airport[]> {
    const list = await this.loadAirports();
    return list.filter((a) => a.size !== 'small').map((a) => ({ a, d: haversineKm({ lat, lng }, a) })).filter((x) => x.d <= radiusKm)
      .sort((x, y) => SIZE_RANK[x.a.size] - SIZE_RANK[y.a.size] || x.d - y.d).slice(0, max).map((x) => x.a);
  }

  async timeZone(lat: number, lng: number): Promise<string> {
    const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
    let p = this.tzCache.get(key);
    if (!p) {
      p = (this.o.tzLookup ?? openMeteoTz)(lat, lng);
      this.tzCache.set(key, p);
      p.catch(() => this.tzCache.delete(key));
    }
    return p;
  }

  private async airportPlace(a: Airport): Promise<Place> {
    const tz = await this.timeZone(a.lat, a.lng).catch(() => undefined);
    return { name: `${a.name} (${a.iata})`, kind: 'airport', lat: a.lat, lng: a.lng, countryCode: a.country, timeZone: tz, iata: a.iata, cityName: a.city,
      airports: [{ iata: a.iata, name: a.name, lat: a.lat, lng: a.lng, timeZone: tz }], source: 'ourairports' };
  }

  async searchPlaces(query: string, near?: { lat: number; lng: number; radiusM: number }): Promise<Place[]> {
    const out: Place[] = [];
    const airports = await this.loadAirports().catch(() => [] as Airport[]);
    if (near) {
      for (const a of await this.nearbyAirports(near.lat, near.lng, near.radiusM / 1000, 6).catch(() => [])) out.push(await this.airportPlace(a));
      if (!query) return out;
    }
    const q = query.trim();
    if (!q) return out;
    // Airports by IATA code or name/city prefix.
    const lq = q.toLowerCase();
    const apHits = airports.filter((a) => a.iata === q.toUpperCase() || (lq.length >= 3 && (a.city.toLowerCase().startsWith(lq) || a.name.toLowerCase().startsWith(lq))))
      .sort((x, y) => (x.iata === q.toUpperCase() ? -1 : 0) - (y.iata === q.toUpperCase() ? -1 : 0) || SIZE_RANK[x.size] - SIZE_RANK[y.size]).slice(0, 3);
    // Cities and regions from Photon.
    const qs = new URLSearchParams({ q, limit: '10', lang: 'en' });
    const r = await requestJson<{ features?: any[] }>(`${this.o.photonUrl.replace(/\/$/, '')}/api/?${qs}`, { provider: 'photon', operation: 'search', timeoutMs: 8000 }).catch(() => ({ features: [] }));
    const cities = (r.features ?? []).filter((f) => f.properties?.osm_key === 'place' && ['city', 'town', 'village', 'municipality', 'island', 'state', 'region', 'country'].includes(f.properties.osm_value)
      || (f.properties?.osm_key === 'boundary' && f.properties?.type === 'city')).slice(0, 6);
    const seen = new Set<string>();
    const placeTasks = cities.map(async (f): Promise<Place | null> => {
      const p = f.properties; const [lng, lat] = f.geometry.coordinates as [number, number];
      const key = `${p.name}|${p.countrycode}`;
      if (seen.has(key)) return null; seen.add(key);
      const kind: Place['kind'] = p.osm_value === 'country' ? 'country' : ['state', 'region'].includes(p.osm_value) ? 'region' : 'city';
      const near = kind === 'city' ? await this.nearbyAirports(lat, lng).catch(() => []) : [];
      const tz = await this.timeZone(lat, lng).catch(() => undefined);
      const label = [p.name, p.state && p.state !== p.name ? p.state : null, p.country].filter(Boolean).join(', ');
      return { name: kind === 'city' ? p.name : label, kind, lat, lng, countryCode: String(p.countrycode ?? '').toUpperCase() || undefined, timeZone: tz, iata: near[0]?.iata, cityName: p.name,
        airports: await Promise.all(near.map(async (a) => ({ iata: a.iata, name: a.name, lat: a.lat, lng: a.lng, timeZone: await this.timeZone(a.lat, a.lng).catch(() => undefined) }))), source: 'photon' };
    });
    const places = (await Promise.all(placeTasks)).filter(Boolean) as Place[];
    for (const a of apHits) out.push(await this.airportPlace(a));
    out.push(...places);
    return out.slice(0, 10);
  }
}

let openMeteoBase = 'https://api.open-meteo.com/v1/forecast';
let openMeteoKey: string | undefined;
export function configureOpenMeteoTz(apiKey?: string) { openMeteoKey = apiKey; if (apiKey) openMeteoBase = 'https://customer-api.open-meteo.com/v1/forecast'; }

export async function openMeteoTz(lat: number, lng: number): Promise<string> {
  const r = await requestJson<{ timezone?: string }>(`${openMeteoBase}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&timezone=auto&forecast_days=1&daily=sunrise${openMeteoKey ? `&apikey=${encodeURIComponent(openMeteoKey)}` : ''}`, { provider: 'open_meteo', operation: 'timezone', timeoutMs: 8000 });
  if (!r.timezone || r.timezone === 'GMT') throw new ProviderError('open_meteo', 'no time zone returned', 200, false);
  return r.timezone;
}
