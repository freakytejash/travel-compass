// Outbound HTTP for provider integrations: timeouts, bounded retries with backoff, usage accounting.
import { log } from '../log.ts';

export class NotConfiguredError extends Error {
  provider: string;
  constructor(provider: string, missing: string[]) {
    super(`${provider} is not configured (missing ${missing.join(', ')})`);
    this.name = 'NotConfiguredError';
    this.provider = provider; this.missing = missing;
  }
  missing: string[];
}

export class ProviderError extends Error {
  provider: string;
  status: number | null;
  retryable: boolean;
  body?: string;
  constructor(provider: string, message: string, status: number | null, retryable: boolean, body?: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
    this.provider = provider; this.status = status; this.retryable = retryable; this.body = body;
  }
}

export interface UsageEvent {
  provider: string; operation: string; status: 'ok' | 'error'; httpStatus: number | null; latencyMs: number;
  tokensIn?: number; tokensOut?: number; costUsd?: number; userId?: string | null;
}
export type UsageSink = (e: UsageEvent) => void;
let usageSink: UsageSink = () => {};
export function setUsageSink(s: UsageSink) { usageSink = s; }
export function recordUsage(e: UsageEvent) { try { usageSink(e); } catch { /* never fail a request on accounting */ } }

/** Test hook: replaces global fetch for provider calls. */
let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function setFetch(f: typeof fetch) { fetchImpl = f; }

export interface RequestOpts {
  provider: string;
  operation: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  userId?: string | null;
  /** Only idempotent operations are retried by default. */
  idempotent?: boolean;
  /** Return the raw response body instead of parsing JSON (for non-JSON APIs). */
  text?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function requestJson<T>(url: string, o: RequestOpts): Promise<T> {
  const method = o.method ?? 'GET';
  const idempotent = o.idempotent ?? (method === 'GET');
  const retries = o.retries ?? (idempotent ? 2 : 0);
  let attempt = 0;
  for (;;) {
    attempt++;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20000);
    let status: number | null = null;
    try {
      const res = await fetchImpl(url, {
        method, signal: ctrl.signal,
        headers: { Accept: 'application/json', ...(o.body !== undefined && !(o.body instanceof URLSearchParams) ? { 'Content-Type': 'application/json' } : {}), ...o.headers },
        body: o.body === undefined ? undefined : o.body instanceof URLSearchParams ? o.body : JSON.stringify(o.body),
      });
      status = res.status;
      const text = await res.text();
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        recordUsage({ provider: o.provider, operation: o.operation, status: 'error', httpStatus: res.status, latencyMs, userId: o.userId });
        if (retryable && attempt <= retries) {
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 400 * 2 ** (attempt - 1));
          continue;
        }
        throw new ProviderError(o.provider, `HTTP ${res.status} on ${o.operation}`, res.status, retryable, text.slice(0, 500));
      }
      recordUsage({ provider: o.provider, operation: o.operation, status: 'ok', httpStatus: res.status, latencyMs, userId: o.userId });
      if (o.text) return text as unknown as T;
      return (text ? JSON.parse(text) : {}) as T;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const latencyMs = Date.now() - started;
      recordUsage({ provider: o.provider, operation: o.operation, status: 'error', httpStatus: status, latencyMs, userId: o.userId });
      const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
      if (attempt <= retries) { await sleep(400 * 2 ** (attempt - 1)); continue; }
      log.warn('provider request failed', { provider: o.provider, operation: o.operation, error: msg });
      throw new ProviderError(o.provider, msg, status, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Run async tasks with bounded concurrency, collecting per-task success or failure. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<({ ok: true; value: R } | { ok: false; error: Error })[]> {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (e) { out[i] = { ok: false, error: e as Error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** A free/paid provider allowance for the current period is used up. Not retried. */
export class QuotaExceededError extends Error {
  provider: string;
  constructor(provider: string, message: string) { super(message); this.name = 'QuotaExceededError'; this.provider = provider; }
}

const PROVIDER_LABEL: Record<string, [string, string]> = {
  serpapi: ['Google Flights (SerpApi)', 'SERPAPI_API_KEY'], serpapi_google_hotels: ['Google Hotels (SerpApi)', 'SERPAPI_API_KEY'],
  openai_compatible: ['the AI service (Groq)', 'AI_API_KEY'], groq: ['the AI service (Groq)', 'AI_API_KEY'], ai: ['the AI service', 'AI_API_KEY'], anthropic: ['the AI service (Anthropic)', 'ANTHROPIC_API_KEY'],
  photon: ['the place search (Photon)', ''], overpass: ['OpenStreetMap venue search', ''], openstreetmap: ['OpenStreetMap venue search', ''], wikimedia: ['Wikivoyage', ''],
  open_meteo: ['the weather service (Open-Meteo)', ''], nager_date: ['the public-holiday service', ''], brevo: ['Brevo email', 'BREVO_API_KEY'], resend: ['Resend email', 'RESEND_API_KEY'],
  duffel: ['Duffel flights', 'DUFFEL_ACCESS_TOKEN'], google_places: ['Google Places', 'GOOGLE_MAPS_API_KEY'], brave_search: ['Brave Search', 'BRAVE_SEARCH_API_KEY'],
};

/** Customer-safe explanation of a provider failure: which service, and what to do. Never includes keys or response bodies. */
export function explainFailure(e: unknown, fallback = 'A travel data service did not respond. Please retry.'): string {
  if (e instanceof QuotaExceededError) return e.message;
  if (e instanceof NotConfiguredError) return `This needs ${e.provider} to be set up first (missing in Render → Environment: ${e.missing.join(', ')}).`;
  if (!(e instanceof ProviderError)) return fallback;
  const [label, key] = PROVIDER_LABEL[e.provider] ?? [e.provider, ''];
  const s = e.status;
  const detail = /serpapi/.test(e.provider) && e.status === 200 ? ` It said: ${e.message.replace(/^[^:]+:\s*/, '').slice(0, 140)}` : '';
  if (s === 401 || s === 403) return `${label} rejected the request (HTTP ${s}).${key ? ` Check ${key} in Render → Environment — a deleted or mistyped key causes this.` : ''}`;
  if (s === 429) return `${label} is rate-limiting us (HTTP 429). Wait a minute and retry.`;
  if (s && s >= 500) return `${label} had a temporary problem (HTTP ${s}). Please retry in a minute.`;
  if (/timeout/i.test(e.message)) return `${label} took too long to answer. Please retry.`;
  if (/invalid JSON/.test(e.message)) return `${label} sent an answer we couldn't read. Please retry.`;
  return `${label} failed${s ? ` (HTTP ${s})` : ''}.${detail} Please retry.`;
}
