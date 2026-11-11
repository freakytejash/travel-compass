// Free research via Wikivoyage and Wikipedia (MediaWiki API, no key; CC BY-SA — every use links the source page).
// Non-Wikimedia URLs (e.g. a restaurant's own menu page) use the guarded fetcher.
import { sanitiseExternalText } from '../domain/planQuality.ts';
import { requestJson } from './http.ts';
import { guardedFetchText } from './research.ts';
import type { ResearchProvider, WebResult } from './types.ts';

const NOISE = /\b(official|distance|elevation|gain|to try|try|dishes|traditional|vegetarian|vegan|local|best|top|things|what|eat|near)\b/gi;

export class WikimediaResearch implements ResearchProvider {
  name = 'wikimedia';
  private ua: string; private lang: string;
  constructor(userAgent: string, lang = 'en') { this.ua = userAgent; this.lang = lang; }
  configured() { return true; }

  private api(site: 'wikivoyage' | 'wikipedia', params: Record<string, string>) {
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    return requestJson<any>(`https://${this.lang}.${site}.org/w/api.php?${qs}`, { provider: 'wikimedia', operation: `${site}.${params.action}`, headers: { 'User-Agent': this.ua, 'Api-User-Agent': this.ua }, timeoutMs: 10000 });
  }

  async search(query: string, opts: { count?: number } = {}): Promise<WebResult[]> {
    const q = query.replace(NOISE, ' ').replace(/\s+/g, ' ').trim() || query;
    const isHike = /trail|hike|walk|route|path|mount|peak/i.test(query);
    const sites: ('wikivoyage' | 'wikipedia')[] = isHike ? ['wikipedia', 'wikivoyage'] : ['wikivoyage', 'wikipedia'];
    const out: WebResult[] = [];
    for (const site of sites) {
      const r = await this.api(site, { action: 'query', list: 'search', srsearch: q, srlimit: String(Math.min(opts.count ?? 4, 10)), srnamespace: '0' }).catch(() => null);
      for (const hit of r?.query?.search ?? []) {
        out.push({ url: `https://${this.lang}.${site}.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, title: `${hit.title} — ${site === 'wikivoyage' ? 'Wikivoyage' : 'Wikipedia'}`, snippet: sanitiseExternalText(hit.snippet ?? '', 300) });
      }
      if (out.length >= (opts.count ?? 4)) break;
    }
    return out.slice(0, opts.count ?? 4);
  }

  async fetchText(url: string) {
    const u = new URL(url);
    const m = /^([a-z-]+)\.(wikivoyage|wikipedia)\.org$/.exec(u.hostname);
    if (!m || !u.pathname.startsWith('/wiki/')) return guardedFetchText(url);
    const title = decodeURIComponent(u.pathname.slice(6)).replace(/_/g, ' ');
    const r = await this.api(m[2] as 'wikivoyage' | 'wikipedia', { action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: title });
    const page = r?.query?.pages?.[0];
    let text: string = page?.extract ?? '';
    if (m[2] === 'wikivoyage' && text) {
      // Prefer the sections that matter for planning, in this order.
      const sections = text.split(/\n(?===+ )/);
      const pick = (name: RegExp) => sections.filter((s) => name.test(s.split('\n')[0]));
      const ordered = [...pick(/^==+ (Eat|Drink)/), ...pick(/^==+ (See|Do)/), ...pick(/^==+ (Get around|Stay safe)/)];
      if (ordered.length) text = ordered.join('\n');
    }
    return { url, title: `${page?.title ?? title} — ${m[2] === 'wikivoyage' ? 'Wikivoyage' : 'Wikipedia'}`, text: sanitiseExternalText(text, 12000), retrievedAt: new Date().toISOString() };
  }
}
