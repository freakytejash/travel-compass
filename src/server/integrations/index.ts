import type { Config } from '../config.ts';
import { AnthropicAi, type BudgetCheck } from './ai.ts';
import { BookingDemand } from './booking.ts';
import { DuffelFlights, DuffelLinks, DuffelStays } from './duffel.ts';
import { configureOpenMeteoTz, FreeGeo } from './freegeo.ts';
import { GooglePlaces, GoogleRoutes } from './google.ts';
import { chooseMailer, WhatsAppCloud } from './messaging.ts';
import { OpenAiCompatAi } from './openaiCompat.ts';
import { OsmPlaces } from './osm.ts';
import { BraveResearch } from './research.ts';
import { SerpApiExplore, SerpApiFlights, SerpApiHotels, type QuotaGuard } from './serpapi.ts';
import { TelegramBot } from './telegram.ts';
import { CallMeBot } from './callmebot.ts';
import { NagerHolidays } from './holidays.ts';
import type { Providers } from './types.ts';
import { OpenMeteo } from './weather.ts';
import { WikimediaResearch } from './wikimedia.ts';

/**
 * Chooses providers from configuration. Paid providers win when configured; otherwise the free stack is used:
 * SerpApi (Google Flights/Hotels), Photon + OurAirports, OpenStreetMap, Wikivoyage/Wikipedia, Groq/Ollama, Telegram.
 */
export function buildProviders(c: Config, budget: BudgetCheck, quota: QuotaGuard = async () => {}): Providers {
  configureOpenMeteoTz(c.openMeteo.apiKey);
  const geo = new FreeGeo({ airportsUrl: c.geo.airportsUrl, dataDir: c.geo.dataDir, photonUrl: c.geo.photonUrl });
  const aiPrice = { in: c.anthropic.inputUsdPerMTok, out: c.anthropic.outputUsdPerMTok };
  return {
    flights: c.duffel.token ? new DuffelFlights(c.duffel.token) : new SerpApiFlights(c.serpapi.apiKey, geo, quota, c.serpapi.gl),
    stays: [new DuffelStays(c.duffel.token, c.duffel.staysEnabled), new BookingDemand(c.booking.token, c.booking.affiliateId, c.booking.baseUrl), new SerpApiHotels(c.serpapi.apiKey, quota, c.serpapi.gl)],
    checkout: new DuffelLinks(c.duffel.token, c.duffel.linksEnabled),
    places: c.googleMaps.apiKey ? new GooglePlaces(c.googleMaps.apiKey) : new OsmPlaces(c.geo.overpassUrl, c.userAgent),
    routes: new GoogleRoutes(c.googleMaps.apiKey),
    weather: new OpenMeteo(c.openMeteo.apiKey, c.openMeteo.allowFreeTier),
    ai: c.anthropic.apiKey
      ? new AnthropicAi(c.anthropic.apiKey, c.anthropic.model, budget, aiPrice)
      : new OpenAiCompatAi({ baseUrl: c.openai.baseUrl, apiKey: c.openai.apiKey, model: c.openai.model, budget, price: aiPrice }),
    research: c.research.braveApiKey ? new BraveResearch(c.research.braveApiKey) : new WikimediaResearch(c.userAgent),
    messenger: new WhatsAppCloud(c.whatsapp.token, c.whatsapp.phoneNumberId, c.whatsapp.appSecret, c.whatsapp.graphVersion),
    mailer: chooseMailer({ brevoKey: c.email.brevoApiKey, resendKey: c.email.resendApiKey, from: c.email.from, devLog: !c.isProd || c.email.logOnly }),
    telegram: new TelegramBot(c.telegram.token, c.telegram.username, c.telegram.webhookSecret),
    callmebot: new CallMeBot(c.callmebotEnabled),
    holidays: new NagerHolidays(c.holidaysUrl),
    explore: new SerpApiExplore(c.serpapi.apiKey, quota, c.serpapi.gl),
  };
}
