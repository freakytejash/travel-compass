import { createHash } from 'node:crypto';
// Central configuration. Secrets come only from the environment (or the platform's secret manager that
// populates it); they are never sent to the browser or written to the database in clear text.

function str(name: string, def?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

export function loadConfig() {
  const env = str('NODE_ENV', 'development')!;
  // On Render, RENDER_EXTERNAL_URL is set automatically to the service's https address.
  const appUrl = str('APP_URL', str('RENDER_EXTERNAL_URL', 'http://localhost:3000'))!.replace(/\/$/, '');
  const freeFlights = !str('DUFFEL_ACCESS_TOKEN') && !!str('SERPAPI_API_KEY');
  const cfg = {
    env,
    isProd: env === 'production',
    port: num('PORT', 3000),
    appUrl,
    databaseUrl: str('DATABASE_URL'),
    dbPoolSize: num('DB_POOL_SIZE', 10),
    sessionDays: num('SESSION_DAYS', 30),
    tokenEncryptionKey: str('TOKEN_ENCRYPTION_KEY'), // base64, 32 bytes
    trustProxy: bool('TRUST_PROXY', false),
    runWorkerInProcess: bool('RUN_WORKER_IN_PROCESS', true),
    workerIdleMaxSeconds: num('WORKER_IDLE_MAX_SECONDS', 1),
    adminEmails: (str('ADMIN_EMAILS', '') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

    google: { clientId: str('GOOGLE_CLIENT_ID'), clientSecret: str('GOOGLE_CLIENT_SECRET') },
    email: { resendApiKey: str('RESEND_API_KEY'), brevoApiKey: str('BREVO_API_KEY'), from: str('EMAIL_FROM', 'Travel Compass <no-reply@example.com>')!,
      // Personal self-hosting only: print verification/reset links to the server log instead of emailing them.
      logOnly: bool('EMAIL_LOG_ONLY', false) },
    duffel: { token: str('DUFFEL_ACCESS_TOKEN'), staysEnabled: bool('DUFFEL_STAYS_ENABLED', false), linksEnabled: bool('DUFFEL_LINKS_ENABLED', false), webhookSecret: str('DUFFEL_WEBHOOK_SECRET') },
    booking: { token: str('BOOKING_DEMAND_API_TOKEN'), affiliateId: str('BOOKING_AFFILIATE_ID'), baseUrl: str('BOOKING_DEMAND_BASE_URL', 'https://demandapi.booking.com/3.1')! },
    googleMaps: { apiKey: str('GOOGLE_MAPS_API_KEY') },
    openMeteo: { apiKey: str('OPEN_METEO_API_KEY'), allowFreeTier: bool('OPEN_METEO_ALLOW_FREE_TIER', !(env === 'production')) },
    anthropic: { apiKey: str('ANTHROPIC_API_KEY'), model: str('ANTHROPIC_MODEL', 'claude-sonnet-5-5')!, dailyBudgetUsd: num('AI_DAILY_BUDGET_USD', 25), perUserDailyBudgetUsd: num('AI_PER_USER_DAILY_BUDGET_USD', 1.5), inputUsdPerMTok: num('AI_INPUT_USD_PER_MTOK', 3), outputUsdPerMTok: num('AI_OUTPUT_USD_PER_MTOK', 15) },
    research: { braveApiKey: str('BRAVE_SEARCH_API_KEY') },
    // ---- Free providers ----
    serpapi: { apiKey: str('SERPAPI_API_KEY'), monthlyLimit: num('SERPAPI_MONTHLY_LIMIT', 240), gl: str('SERPAPI_COUNTRY', 'be')! },
    openai: { baseUrl: str('AI_BASE_URL'), apiKey: str('AI_API_KEY'), model: str('AI_MODEL', 'llama-3.3-70b-versatile')! },
    geo: { photonUrl: str('PHOTON_URL', 'https://photon.komoot.io')!, overpassUrl: str('OVERPASS_URL', 'https://overpass-api.de/api/interpreter')!,
      airportsUrl: str('AIRPORTS_CSV_URL', 'https://davidmegginson.github.io/ourairports-data/airports.csv')!, dataDir: str('DATA_DIR', './data')! },
    telegram: { token: str('TELEGRAM_BOT_TOKEN'), username: str('TELEGRAM_BOT_USERNAME'), webhookSecret: str('TELEGRAM_WEBHOOK_SECRET', str('TELEGRAM_BOT_TOKEN') && str('TOKEN_ENCRYPTION_KEY') ? createHash('sha256').update(`${str('TELEGRAM_BOT_TOKEN')}|${str('TOKEN_ENCRYPTION_KEY')}`).digest('hex').slice(0, 48) : undefined), mode: (str('TELEGRAM_MODE', 'polling') as 'polling' | 'webhook') },
    userAgent: `TravelCompass/1.0 (+${appUrl})`,
    // Free personal WhatsApp via CallMeBot (each user brings their own CallMeBot key for their own number).
    callmebotEnabled: bool('CALLMEBOT_ENABLED', true),
    holidaysUrl: str('HOLIDAYS_API_URL', 'https://date.nager.at/api/v3')!,
    whatsapp: { token: str('WHATSAPP_ACCESS_TOKEN'), phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'), appSecret: str('WHATSAPP_APP_SECRET'), verifyToken: str('WHATSAPP_WEBHOOK_VERIFY_TOKEN'), graphVersion: str('WHATSAPP_GRAPH_VERSION', 'v23.0')!,
      templates: { verification: str('WHATSAPP_TEMPLATE_VERIFICATION', 'tc_verification_code')!, pretrip: str('WHATSAPP_TEMPLATE_PRETRIP', 'tc_pretrip_briefing')!, daily: str('WHATSAPP_TEMPLATE_DAILY', 'tc_daily_schedule')! }, templateLanguage: str('WHATSAPP_TEMPLATE_LANGUAGE', 'en')! },
    limits: {
      // Smaller defaults on the free flight plan (each combination costs one search of the monthly allowance).
      flexMaxCombos: num('FLEX_MAX_COMBOS', freeFlights ? 9 : 49),
      flexStayQuoteCombos: num('FLEX_STAY_QUOTE_COMBOS', freeFlights ? 2 : 6),
      destinationCandidates: num('DESTINATION_CANDIDATES', freeFlights ? 4 : 8),
      // Trip ideas: each priced date window is one Google Travel Explore search.
      ideaWindows: num('IDEA_WINDOWS', 3),
      nearbyAirportKm: num('NEARBY_AIRPORT_KM', 150),
      maxOriginAirports: num('MAX_ORIGIN_AIRPORTS', 6),
      providerConcurrency: num('PROVIDER_CONCURRENCY', 4),
      apiRatePerMinute: num('API_RATE_PER_MINUTE', 120),
      authRatePerMinute: num('AUTH_RATE_PER_MINUTE', 10),
      expensiveRatePerHour: num('EXPENSIVE_RATE_PER_HOUR', 30),
    },
    retentionDays: { providerUsage: num('RETENTION_PROVIDER_USAGE_DAYS', 90), errorEvents: num('RETENTION_ERROR_EVENTS_DAYS', 30), jobs: num('RETENTION_JOBS_DAYS', 30), cache: 1 },
  };
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;

export interface IntegrationInfo {
  key: string;
  name: string;
  capability: string;
  required: boolean; // required for a complete customer journey
  status: 'configured' | 'awaiting_credentials' | 'disabled';
  missing: string[];
  approvals: string[]; // business/provider approvals the owner must obtain
}

export function integrationReadiness(c: Config): IntegrationInfo[] {
  const need = (pairs: [string, unknown][]) => pairs.filter(([, v]) => !v).map(([k]) => k);
  const mk = (key: string, name: string, capability: string, required: boolean, vars: [string, unknown][], approvals: string[] = [], disabled = false): IntegrationInfo => {
    const missing = need(vars);
    return { key, name, capability, required, status: disabled ? 'disabled' : missing.length ? 'awaiting_credentials' : 'configured', missing, approvals };
  };
  const duffel = !!c.duffel.token; const serp = !!c.serpapi.apiKey;
  const anthropic = !!c.anthropic.apiKey; const compat = !!c.openai.baseUrl;
  const google = !!c.googleMaps.apiKey; const brave = !!c.research.braveApiKey;
  const wa = !!(c.whatsapp.token && c.whatsapp.phoneNumberId); const tg = !!(c.telegram.token && c.telegram.username);
  return [
    mk('database', 'PostgreSQL', 'Persistent storage for all customer data', true, [['DATABASE_URL', c.databaseUrl]]),
    mk('encryption', 'Token encryption key', 'Encrypts OAuth tokens and traveller details at rest', true, [['TOKEN_ENCRYPTION_KEY', c.tokenEncryptionKey]]),
    mk('email', c.email.brevoApiKey ? 'Brevo (free 300 emails/day)' : c.email.resendApiKey ? 'Resend (transactional email)' : c.email.logOnly ? 'Email (log-only: links go to the server log, not your inbox)' : 'Email', 'Email verification and password recovery', true, [['BREVO_API_KEY or RESEND_API_KEY', c.email.brevoApiKey || c.email.resendApiKey || (c.email.logOnly ? 'log' : '')]], c.email.brevoApiKey ? ['Verified sender address in Brevo (Senders & IP)'] : c.email.resendApiKey ? ['Verified sending domain in Resend (onboarding@resend.dev only reaches your own address)'] : []),
    mk('google_login', 'Google sign-in', 'Sign in with Google', false, [['GOOGLE_CLIENT_ID', c.google.clientId], ['GOOGLE_CLIENT_SECRET', c.google.clientSecret]], ['Google OAuth consent screen (testing mode is fine for personal use)']),
    // Flights: Duffel (booking provider) or SerpApi Google Flights (free 250 searches/month)
    mk('duffel_flights', 'Duffel Flights', 'Live bookable flight offers', !serp, [['DUFFEL_ACCESS_TOKEN', c.duffel.token]], ['Duffel live-mode account (KYC) for real bookings']),
    mk('serpapi', 'SerpApi — Google Flights & Hotels (free 250/month)', 'Current flight and hotel prices from Google, seller handoff', !duffel, [['SERPAPI_API_KEY', c.serpapi.apiKey]], ['Free plan: personal use; SerpApi branding/terms apply']),
    mk('geo_free', 'Photon + OurAirports + Open-Meteo time zones', 'Free city/airport search (used when Duffel is not configured)', !duffel, []),
    mk('duffel_stays', 'Duffel Stays', 'Live hotel/hostel rates', false, [['DUFFEL_ACCESS_TOKEN', c.duffel.token], ['DUFFEL_STAYS_ENABLED', c.duffel.staysEnabled]], ['Duffel Stays access approval']),
    mk('booking_com', 'Booking.com Demand API', 'Live accommodation availability with redirect handoff', false, [['BOOKING_DEMAND_API_TOKEN', c.booking.token], ['BOOKING_AFFILIATE_ID', c.booking.affiliateId]], ['Booking.com affiliate partnership']),
    mk('duffel_links', 'Duffel Links', 'Provider-hosted checkout handoff', false, [['DUFFEL_ACCESS_TOKEN', c.duffel.token], ['DUFFEL_LINKS_ENABLED', c.duffel.linksEnabled]], ['Duffel Links enabled with Duffel Payments in a supported country']),
    // Venues: Google Places (paid above free caps) or OpenStreetMap (free)
    mk('google_places', 'Google Places API (New)', 'Named venues with ratings and price levels', false, [['GOOGLE_MAPS_API_KEY', c.googleMaps.apiKey]], ['Google Maps Platform billing account']),
    mk('osm', 'OpenStreetMap (Overpass)', 'Free named venues, vegetarian tags, opening hours, hiking routes', !google, []),
    mk('google_routes', 'Google Routes API', 'Live traffic estimates for airport transfers', false, [['GOOGLE_MAPS_API_KEY', c.googleMaps.apiKey]]),
    mk('weather', 'Open-Meteo', 'Forecasts, historical climate, time zones', true, [['OPEN_METEO_API_KEY (or OPEN_METEO_ALLOW_FREE_TIER=true for non-commercial use)', c.openMeteo.apiKey || c.openMeteo.allowFreeTier]], c.openMeteo.apiKey ? [] : ['Free tier is for non-commercial use only']),
    // AI: Anthropic or any OpenAI-compatible endpoint (Groq free tier, local Ollama)
    mk('ai', 'Anthropic Claude API', 'Destination ideas, research synthesis, explanations', !compat, [['ANTHROPIC_API_KEY', c.anthropic.apiKey]]),
    mk('ai_compat', `OpenAI-compatible AI (${c.openai.baseUrl ? new URL(c.openai.baseUrl).hostname : 'Groq / Ollama'})`, 'Free AI planning via Groq free tier or a local Ollama model', !anthropic, [['AI_BASE_URL', c.openai.baseUrl], ['AI_MODEL', c.openai.model]]),
    // Research: Brave (paid credits) or Wikivoyage/Wikipedia (free)
    mk('research', 'Brave Search API', 'Open-web sources for hikes, dishes, closures', false, [['BRAVE_SEARCH_API_KEY', c.research.braveApiKey]], ['Brave Search plan (card required)']),
    mk('holidays', 'Nager.Date public holidays (free)', 'Long weekends and holiday weeks for trip ideas', false, []),
    mk('travel_explore', 'SerpApi — Google Travel Explore (uses the same 250/month)', 'Cheapest destinations from your nearby airports for each holiday window', false, [['SERPAPI_API_KEY', c.serpapi.apiKey]]),
    mk('wikimedia', 'Wikivoyage + Wikipedia', 'Free sources for local dishes, sights and trails (CC BY-SA)', !brave, []),
    mk('gmail', 'Gmail API (customer OAuth)', 'Reservation import from customer inboxes', false, [['GOOGLE_CLIENT_ID', c.google.clientId], ['GOOGLE_CLIENT_SECRET', c.google.clientSecret]], ['For your own inbox: keep the OAuth app in testing and add yourself as a test user. Public use needs Google restricted-scope verification + CASA']),
    mk('callmebot', 'WhatsApp via CallMeBot (free, personal)', 'Reminders to your own WhatsApp number; each user activates their own key; no delivery receipts', false, [['CALLMEBOT_ENABLED', c.callmebotEnabled]], ['Personal use only (CallMeBot terms); unofficial gateway, not Meta']),
    mk('telegram', 'Telegram Bot API (free)', 'Pre-trip briefings and daily schedules', !wa, [['TELEGRAM_BOT_TOKEN', c.telegram.token], ['TELEGRAM_BOT_USERNAME', c.telegram.username]]),
    mk('whatsapp', 'WhatsApp Cloud API', 'Pre-trip briefings and daily schedules (paid per template message)', !tg, [['WHATSAPP_ACCESS_TOKEN', c.whatsapp.token], ['WHATSAPP_PHONE_NUMBER_ID', c.whatsapp.phoneNumberId], ['WHATSAPP_APP_SECRET', c.whatsapp.appSecret], ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', c.whatsapp.verifyToken]], ['Meta Business verification', 'Approved message templates (verification, pre-trip, daily)']),
  ];
}
