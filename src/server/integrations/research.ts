// Web research: Brave Search API for discovery + guarded page fetching (SSRF-safe, size-limited, sanitised).
import dns from 'node:dns/promises';
import net from 'node:net';
import { sanitiseExternalText } from '../domain/planQuality.ts';
import { NotConfiguredError, ProviderError, requestJson } from './http.ts';
import type { ResearchProvider, WebResult } from './types.ts';

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new ProviderError('research', 'only https sources are fetched', null, false);
  if (u.username || u.password) throw new ProviderError('research', 'credentials in URL not allowed', null, false);
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new ProviderError('research', 'destination resolves to a private address', null, false);
  return u;
}

export class BraveResearch implements ResearchProvider {
  name = 'brave_search';
  private key?: string;
  constructor(key?: string) { this.key = key; }
  configured() { return !!this.key; }
  async search(query: string, opts: { count?: number; country?: string; userId?: string | null } = {}): Promise<WebResult[]> {
    if (!this.key) throw new NotConfiguredError('Brave Search', ['BRAVE_SEARCH_API_KEY']);
    const qs = new URLSearchParams({ q: query, count: String(opts.count ?? 8), safesearch: 'moderate' });
    if (opts.country) qs.set('country', opts.country.toLowerCase());
    const r = await requestJson<{ web?: { results?: { url: string; title: string; description?: string }[] } }>(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
      provider: 'brave_search', operation: 'web.search', headers: { 'X-Subscription-Token': this.key }, userId: opts.userId,
    });
    return (r.web?.results ?? []).filter((x) => x.url.startsWith('https://')).map((x) => ({ url: x.url, title: sanitiseExternalText(x.title, 200), snippet: sanitiseExternalText(x.description ?? '', 500) }));
  }
  fetchText(url: string) { return guardedFetchText(url); }
}

/** Fetches a public https page as sanitised text (SSRF guard, redirect limit, 1.5 MB cap). Content is untrusted. */
export async function guardedFetchText(url: string, redirects = 0): Promise<{ url: string; title: string; text: string; retrievedAt: string }> {
  await assertPublicUrl(url);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'User-Agent': 'TravelCompassBot/1.0 (+research; respects robots)', Accept: 'text/html,text/plain' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || redirects >= 4) throw new ProviderError('research', 'too many or invalid redirects', res.status, false);
      return guardedFetchText(new URL(loc, url).toString(), redirects + 1);
    }
    if (!res.ok) throw new ProviderError('research', `HTTP ${res.status}`, res.status, res.status >= 500);
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)/.test(ct)) throw new ProviderError('research', `unsupported content type ${ct}`, res.status, false);
    const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; chunks.push(value); if (size > 1_500_000) { await reader.cancel(); break; } }
    const html = Buffer.concat(chunks).toString('utf8');
    const title = sanitiseExternalText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? url, 200);
    return { url, title, text: sanitiseExternalText(html, 12000), retrievedAt: new Date().toISOString() };
  } finally { clearTimeout(t); }
}
