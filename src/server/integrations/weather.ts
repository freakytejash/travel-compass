// Open-Meteo forecast (up to 16 days) and historical climate (ERA5 archive averages for the same calendar dates).
// Free tier is for non-commercial use only; commercial deployments must set OPEN_METEO_API_KEY.
import type { DayWeather } from '../domain/itinerary.ts';
import { addDays, daysBetween } from '../domain/time.ts';
import { NotConfiguredError, requestJson } from './http.ts';
import type { WeatherProvider } from './types.ts';

const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset';
const CLIMATE_DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset';

export class OpenMeteo implements WeatherProvider {
  name = 'open_meteo';
  private apiKey?: string; private allowFree: boolean;
  constructor(apiKey: string | undefined, allowFree: boolean) { this.apiKey = apiKey; this.allowFree = allowFree; }
  configured() { return !!this.apiKey || this.allowFree; }
  private base(kind: 'forecast' | 'archive') {
    if (!this.configured()) throw new NotConfiguredError('Open-Meteo', ['OPEN_METEO_API_KEY']);
    if (this.apiKey) return kind === 'forecast' ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://customer-archive-api.open-meteo.com/v1/archive';
    return kind === 'forecast' ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
  }
  private key() { return this.apiKey ? `&apikey=${encodeURIComponent(this.apiKey)}` : ''; }

  async forDates(lat: number, lng: number, dates: string[], tz: string, today = new Date().toISOString().slice(0, 10)): Promise<Record<string, DayWeather>> {
    const out: Record<string, DayWeather> = {};
    if (!dates.length) return out;
    const sorted = [...dates].sort();
    const forecastEnd = addDays(today, 15);
    const fc = sorted.filter((d) => d >= today && d <= forecastEnd);
    const cl = sorted.filter((d) => d > forecastEnd || d < today);
    if (fc.length) {
      const r = await requestJson<any>(`${this.base('forecast')}?latitude=${lat}&longitude=${lng}&daily=${DAILY}&timezone=${encodeURIComponent(tz)}&start_date=${fc[0]}&end_date=${fc[fc.length - 1]}${this.key()}`, { provider: 'open_meteo', operation: 'forecast' });
      const d = r.daily;
      d.time.forEach((date: string, i: number) => {
        if (!fc.includes(date)) return;
        out[date] = { kind: 'forecast', tempMaxC: d.temperature_2m_max[i], tempMinC: d.temperature_2m_min[i], precipitationProbability: d.precipitation_probability_max?.[i] ?? null, windMaxKmh: d.wind_speed_10m_max[i], sunrise: d.sunrise[i]?.slice(11, 16) ?? null, sunset: d.sunset[i]?.slice(11, 16) ?? null };
      });
    }
    if (cl.length) {
      // Average the same calendar dates over the previous 5 complete years.
      const year = Number(today.slice(0, 4));
      const years = [1, 2, 3, 4, 5].map((k) => year - k);
      const acc: Record<string, { tmax: number[]; tmin: number[]; wet: number; n: number; wind: number[]; sunrise?: string; sunset?: string }> = {};
      for (const y of years) {
        const shift = (d: string) => `${y}${d.slice(4)}`.replace(/-02-29$/, '-02-28');
        const s = shift(cl[0]); const e = shift(cl[cl.length - 1]);
        if (daysBetween(s, e) < 0) continue;
        const r = await requestJson<any>(`${this.base('archive')}?latitude=${lat}&longitude=${lng}&daily=${CLIMATE_DAILY}&timezone=${encodeURIComponent(tz)}&start_date=${s}&end_date=${e}${this.key()}`, { provider: 'open_meteo', operation: 'archive' });
        r.daily.time.forEach((t: string, i: number) => {
          const md = t.slice(5);
          const a = acc[md] ??= { tmax: [], tmin: [], wet: 0, n: 0, wind: [] };
          if (r.daily.temperature_2m_max[i] !== null) a.tmax.push(r.daily.temperature_2m_max[i]);
          if (r.daily.temperature_2m_min[i] !== null) a.tmin.push(r.daily.temperature_2m_min[i]);
          if (r.daily.wind_speed_10m_max[i] !== null) a.wind.push(r.daily.wind_speed_10m_max[i]);
          a.n++; if ((r.daily.precipitation_sum[i] ?? 0) >= 1) a.wet++;
          a.sunrise = r.daily.sunrise[i]?.slice(11, 16); a.sunset = r.daily.sunset[i]?.slice(11, 16);
        });
      }
      const avg = (x: number[]) => (x.length ? Math.round((x.reduce((s, v) => s + v, 0) / x.length) * 10) / 10 : null);
      for (const d of cl) {
        const a = acc[d.slice(5)];
        if (!a) continue;
        out[d] = { kind: 'climate', tempMaxC: avg(a.tmax), tempMinC: avg(a.tmin), precipitationProbability: a.n ? Math.round((a.wet / a.n) * 100) : null, windMaxKmh: avg(a.wind), sunrise: a.sunrise ?? null, sunset: a.sunset ?? null };
      }
    }
    return out;
  }
}
