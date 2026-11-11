// Admin self-test: calls every configured live service once, from the deployed server, and reports what works.
// Free, read-only calls by default. Optional: one real Google Flights search (1 SerpApi search) and a test email
// to the admin's own verified address. Nothing is booked and no customer is contacted.
import type { AppContext } from '../context.ts';
import { explainFailure, requestJson } from '../integrations/http.ts';
import { addDays } from '../domain/time.ts';

export interface CheckResult { key: string; name: string; status: 'ok' | 'failed' | 'skipped'; detail: string; ms: number; fix?: string }

export async function selfTest(ctx: AppContext, o: { adminEmail: string; serpapiSearch?: boolean; sendEmail?: boolean }) {
  const p = ctx.providers; const cfg = ctx.cfg;
  const out: CheckResult[] = [];
  const check = async (key: string, name: string, enabled: boolean, skipWhy: string, fn: () => Promise<string>, fix?: string) => {
    if (!enabled) { out.push({ key, name, status: 'skipped', detail: skipWhy, ms: 0, fix }); return; }
    const t = Date.now();
    try { out.push({ key, name, status: 'ok', detail: await fn(), ms: Date.now() - t }); }
    catch (e) { out.push({ key, name, status: 'failed', detail: explainFailure(e, (e as Error).message.replace(/api_key=[^&\s]+/gi, 'api_key=***').slice(0, 200)), ms: Date.now() - t, fix }); }
  };
  const today = ctx.now().toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));

  await check('database', 'Database (Neon)', true, '', async () => { const r = await ctx.db.query<{ v: string }>('SELECT version() AS v'); return r.rows[0].v.split(' ').slice(0, 2).join(' '); }, 'Check DATABASE_URL (Neon "Direct connection" string with ?sslmode=require).');
  await check('places', 'City & airport search', p.flights.configured(), 'No place search configured.', async () => {
    const r = await p.flights.searchPlaces('Brussels');
    if (!r.length) throw new Error('no places returned');
    return `${r.length} places; first: ${r[0].name} (airports ${r[0].airports?.map((a) => a.iata).join(', ') || r[0].iata || '—'})`;
  });
  await check('nearby', 'Airports near a city (150 km)', !!p.flights.nearbyAirports, 'Only with the free SerpApi flight setup.', async () =>
    (await p.flights.nearbyAirports!(50.8466, 4.3528, cfg.limits.nearbyAirportKm, cfg.limits.maxOriginAirports)).map((a) => a.iata).join(', ') || 'none found');
  await check('holidays', 'Public holidays (Nager.Date)', !!p.holidays, 'Not configured.', async () => {
    const lw = await p.holidays!.longWeekends(year, 'BE');
    return `${lw.length} Belgian long weekends in ${year}`;
  });
  await check('weather', 'Weather (Open-Meteo)', p.weather.configured(), 'Set OPEN_METEO_ALLOW_FREE_TIER=true (free, non-commercial) or OPEN_METEO_API_KEY.', async () => {
    const w = await p.weather.forDates(50.85, 4.35, [today], 'Europe/Brussels');
    return `today in Brussels: ${w[today]?.tempMaxC ?? '?'}°C (${w[today]?.kind ?? '?'})`;
  }, 'OPEN_METEO_ALLOW_FREE_TIER=true');
  await check('venues', 'Restaurants & sights', p.places.configured(), 'Not configured.', async () => {
    const r = await p.places.textSearch('vegetarian restaurant', { near: { lat: 50.8466, lng: 4.3528, radiusM: 2500 }, max: 5 });
    return `${r.length} venues near Brussels centre${r[0] ? `, e.g. ${r[0].name}` : ''}`;
  });
  await check('research', 'Travel guides (Wikivoyage)', p.research.configured(), 'Not configured.', async () => {
    const s = await p.research.search('Brussels', { count: 1 });
    if (!s.length) throw new Error('no results');
    const t = await p.research.fetchText(s[0].url);
    return `${s[0].title}: ${t.text.length} characters`;
  });
  await check('ai', 'AI (Groq or other)', p.ai.configured(), 'Set AI_BASE_URL, AI_MODEL and AI_API_KEY.', async () => {
    const r = await p.ai.json<{ ok?: boolean }>({ operation: 'selftest', system: 'Reply with exactly this JSON object: {"ok":true}', user: 'ping', maxTokens: 20 });
    if (r?.ok !== true) throw new Error('unexpected answer');
    return `${p.ai.name} answered`;
  }, 'AI_API_KEY (Groq: console.groq.com → API Keys)');
  await check('serpapi', 'SerpApi account (no search used)', !!cfg.serpapi.apiKey, 'Set SERPAPI_API_KEY (free 250 searches/month).', async () => {
    const r = await requestJson<any>(`https://serpapi.com/account.json?api_key=${encodeURIComponent(cfg.serpapi.apiKey!)}`, { provider: 'serpapi', operation: 'account', retries: 0 });
    return `plan ${r.plan_name ?? '?'}; searches left this month: ${r.total_searches_left ?? r.plan_searches_left ?? '?'}`;
  }, 'SERPAPI_API_KEY');
  await check('flights', 'Live Google Flights search (uses 1 search)', !!o.serpapiSearch && p.flights.configured(), o.serpapiSearch ? 'Flights not configured.' : 'Tick "include a live flight search" to run it.', async () => {
    const out1 = addDays(today, 30); const back = addDays(today, 33);
    const r = await p.flights.searchOffers({ slices: [{ origin: 'BRU', destination: 'BCN', departureDate: out1 }, { origin: 'BCN', destination: 'BRU', departureDate: back }], adults: 1, currency: 'EUR', depth: 'quick' } as any);
    if (!r.offers.length) throw new Error('no offers returned');
    return `${r.offers.length} offers BRU→BCN ${out1}; from €${Math.min(...r.offers.map((x) => x.total.amount))}`;
  });
  const mailer = p.mailer;
  await check('email', 'Email delivery', mailer.configured(), 'Set BREVO_API_KEY + EMAIL_FROM and EMAIL_LOG_ONLY=false.', async () => {
    const mode = cfg.email.brevoApiKey ? 'Brevo' : cfg.email.resendApiKey ? 'Resend' : 'log-only (no real emails!)';
    if (!o.sendEmail) return `${mode}; tick "send me a test email" to try a real send`;
    if (!cfg.email.brevoApiKey && !cfg.email.resendApiKey) throw new Error('Email is log-only: links are written to Render → Logs, nothing reaches an inbox. Set BREVO_API_KEY and EMAIL_LOG_ONLY=false.');
    await mailer.send({ to: o.adminEmail, subject: 'Travel Compass test email', text: `This is a test from your Travel Compass self-test at ${new Date().toISOString()}.\n${cfg.appUrl}` });
    return `${mode}: test email sent to your own address — check inbox and spam`;
  }, 'BREVO_API_KEY, EMAIL_FROM, EMAIL_LOG_ONLY=false');
  await check('reminders', 'Reminders', !!(p.callmebot?.configured() || p.telegram?.configured() || p.messenger.configured()), 'No reminder channel configured.', async () =>
    [p.callmebot?.configured() ? 'WhatsApp via CallMeBot (link your number on the Reminders page)' : '', p.telegram?.configured() ? 'Telegram' : '', p.messenger.configured() ? 'WhatsApp Cloud API' : ''].filter(Boolean).join(', '));

  const failed = out.filter((x) => x.status === 'failed');
  return { checkedAt: new Date().toISOString(), appUrl: cfg.appUrl, summary: failed.length ? `${failed.length} problem${failed.length > 1 ? 's' : ''} found` : 'Everything that is configured works', results: out };
}
