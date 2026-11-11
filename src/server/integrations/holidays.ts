// Public holidays and long weekends from Nager.Date (free, no key, ~120 countries).
import { requestJson } from './http.ts';

export interface PublicHoliday { date: string; name: string; localName: string; countryCode: string; global: boolean; types?: string[] }
export interface LongWeekend { startDate: string; endDate: string; dayCount: number; needBridgeDay: boolean; bridgeDays?: string[] }

export class NagerHolidays {
  name = 'nager_date';
  private base: string;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(baseUrl = 'https://date.nager.at/api/v3') { this.base = baseUrl.replace(/\/$/, ''); }
  configured() { return true; }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 12 * 3600_000) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  publicHolidays(year: number, country: string): Promise<PublicHoliday[]> {
    const cc = country.toUpperCase();
    // Nager returns 404 (empty body) for unsupported countries; treat that as "no holiday data".
    return this.cached(`ph:${year}:${cc}`, () => (requestJson<PublicHoliday[] | null>(`${this.base}/PublicHolidays/${year}/${cc}`, { provider: 'nager_date', operation: 'holidays', timeoutMs: 10000, retries: 1 }).catch((e) => { if (e?.status === 404 || e?.status === 204) return []; throw e; })).then((x) => (Array.isArray(x) ? x : [])));
  }

  longWeekends(year: number, country: string): Promise<LongWeekend[]> {
    const cc = country.toUpperCase();
    return this.cached(`lw:${year}:${cc}`, () => (requestJson<LongWeekend[] | null>(`${this.base}/LongWeekend/${year}/${cc}`, { provider: 'nager_date', operation: 'long_weekends', timeoutMs: 10000, retries: 1 }).catch((e) => { if (e?.status === 404 || e?.status === 204) return []; throw e; })).then((x) => (Array.isArray(x) ? x : [])));
  }
}
