// Live smoke check of configured integrations, run from the deployed environment:
//   npm run check:integrations              (free, read-only calls)
//   npm run check:integrations -- --serpapi (also spends 1 SerpApi search from the free monthly allowance)
// A pass here is what "verified live" means. No bookings, no messages to customers.
import { loadConfig, integrationReadiness } from '../src/server/config.ts';
import { DuffelFlights } from '../src/server/integrations/duffel.ts';
import { GooglePlaces } from '../src/server/integrations/google.ts';
import { OpenMeteo } from '../src/server/integrations/weather.ts';
import { BraveResearch } from '../src/server/integrations/research.ts';
import { AnthropicAi } from '../src/server/integrations/ai.ts';
import { FreeGeo } from '../src/server/integrations/freegeo.ts';
import { OsmPlaces } from '../src/server/integrations/osm.ts';
import { WikimediaResearch } from '../src/server/integrations/wikimedia.ts';
import { OpenAiCompatAi } from '../src/server/integrations/openaiCompat.ts';
import { SerpApiFlights } from '../src/server/integrations/serpapi.ts';
import { requestJson } from '../src/server/integrations/http.ts';

process.env.LOG_SILENT = '1';
const cfg = loadConfig();
const results: [string, string][] = [];
async function check(name: string, configured: boolean, fn: () => Promise<string>) {
  if (!configured) { results.push([name, 'SKIPPED — not configured']); return; }
  try { results.push([name, `OK — ${await fn()}`]); } catch (e) { results.push([name, `FAILED — ${(e as Error).message}`]); }
}
const geo = new FreeGeo({ airportsUrl: cfg.geo.airportsUrl, dataDir: cfg.geo.dataDir, photonUrl: cfg.geo.photonUrl });
const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const ret = new Date(Date.now() + 34 * 86400000).toISOString().slice(0, 10);

// Free / key-less
await check('OurAirports data', true, async () => `${(await geo.loadAirports()).length} airports with IATA codes`);
await check('Photon geocoder', true, async () => { const r = await geo.searchPlaces('Brussels'); return `${r.length} places; first: ${r[0]?.name} (${r[0]?.timeZone ?? 'no tz'}, airports ${r[0]?.airports?.map((a) => a.iata).join('/') ?? '-'})`; });
await check('Open-Meteo', !!cfg.openMeteo.apiKey || cfg.openMeteo.allowFreeTier, async () => { const d = new Date().toISOString().slice(0, 10); const w = await new OpenMeteo(cfg.openMeteo.apiKey, cfg.openMeteo.allowFreeTier).forDates(50.85, 4.35, [d], 'Europe/Brussels'); return `forecast ${w[d]?.tempMaxC}°C`; });
await check('OpenStreetMap', !cfg.googleMaps.apiKey, async () => { const r = await new OsmPlaces(cfg.geo.overpassUrl, cfg.userAgent).textSearch('vegetarian restaurant Brussels', { near: { lat: 50.8466, lng: 4.3528, radiusM: 3000 }, max: 5 }); return `${r.length} venues; e.g. ${r[0]?.name}`; });
await check('Wikivoyage', !cfg.research.braveApiKey, async () => { const w = new WikimediaResearch(cfg.userAgent); const s = await w.search('Brussels'); const t = await w.fetchText(s[0].url); return `${s[0]?.title}: ${t.text.length} chars`; });
// Keys
await check('AI (OpenAI-compatible)', !!cfg.openai.baseUrl && !cfg.anthropic.apiKey, async () => JSON.stringify(await new OpenAiCompatAi({ baseUrl: cfg.openai.baseUrl, apiKey: cfg.openai.apiKey, model: cfg.openai.model, budget: async () => ({ allowed: true }), price: { in: 0, out: 0 } }).json({ operation: 'smoke', system: 'Reply with the JSON object {"ok":true}', user: 'ping', maxTokens: 30 })));
await check('Anthropic', !!cfg.anthropic.apiKey, async () => JSON.stringify(await new AnthropicAi(cfg.anthropic.apiKey, cfg.anthropic.model, async () => ({ allowed: true }), { in: 0, out: 0 }).json({ operation: 'smoke', system: 'Reply with {"ok":true}', user: 'ping', maxTokens: 20 })));
await check('Telegram bot', !!cfg.telegram.token, async () => { const r = await requestJson<any>(`https://api.telegram.org/bot${cfg.telegram.token}/getMe`, { provider: 'telegram', operation: 'getMe' }); return `@${r.result?.username}${cfg.telegram.username && r.result?.username !== cfg.telegram.username.replace(/^@/, '') ? ' (does not match TELEGRAM_BOT_USERNAME!)' : ''}`; });
await check('SerpApi account', !!cfg.serpapi.apiKey, async () => { const r = await requestJson<any>(`https://serpapi.com/account.json?api_key=${encodeURIComponent(cfg.serpapi.apiKey!)}`, { provider: 'serpapi_account', operation: 'account' }); return `plan ${r.plan_name ?? '?'}, searches left this month: ${r.total_searches_left ?? r.plan_searches_left ?? '?'}`; });
if (process.argv.includes('--serpapi')) await check('SerpApi Google Flights', !!cfg.serpapi.apiKey, async () => { const r = await new SerpApiFlights(cfg.serpapi.apiKey, geo, async () => {}).searchOffers({ slices: [{ origin: 'BRU', destination: 'BCN', departureDate: day }, { origin: 'BCN', destination: 'BRU', departureDate: ret }], adults: 1, currency: 'EUR', depth: 'quick' }); return `${r.offers.length} offers; cheapest €${Math.min(...r.offers.map((o) => o.total.amount))}`; });
await check('Duffel places', !!cfg.duffel.token, async () => `${(await new DuffelFlights(cfg.duffel.token).searchPlaces('brussels')).length} places`);
await check('Google Places', !!cfg.googleMaps.apiKey, async () => `${(await new GooglePlaces(cfg.googleMaps.apiKey).textSearch('vegetarian restaurant Brussels', { max: 3 })).length} venues`);
await check('Brave Search', !!cfg.research.braveApiKey, async () => `${(await new BraveResearch(cfg.research.braveApiKey).search('Sonian Forest trail', { count: 2 })).length} results`);

for (const [n, r] of results) console.log(`${n.padEnd(24)} ${r}`);
console.log('\nChecked from the app instead: Gmail (connect your inbox), reminders (connect Telegram / verify WhatsApp), email (sign up), hotel search and booking handoff (run a trip search).');
console.log('\nReadiness:'); for (const i of integrationReadiness(cfg)) console.log(`  ${i.status.padEnd(22)} ${i.name}${i.missing.length ? `  (missing: ${i.missing.join(', ')})` : ''}`);
