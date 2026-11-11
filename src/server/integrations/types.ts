import type { FlightOffer, Place, StayOption } from '../../shared/types.ts';
import type { DayWeather } from '../domain/itinerary.ts';

export interface FlightSearchRequest {
  slices: { origin: string; destination: string; departureDate: string }[];
  adults: number;
  cabinClass?: 'economy' | 'premium_economy' | 'business' | 'first';
  maxConnections?: number;
  currency: string;
  userId?: string | null;
  /** 'quick' returns price-level offers with fewer provider calls (used for flexible-date scans). */
  depth?: 'full' | 'quick';
}

export interface FlightProvider {
  name: string;
  configured(): boolean;
  searchPlaces(query: string, near?: { lat: number; lng: number; radiusM: number }): Promise<Place[]>;
  searchOffers(req: FlightSearchRequest): Promise<{ offers: FlightOffer[]; providerRequestId: string }>;
  /** Re-fetch a single offer for repricing. Returns null when the offer no longer exists. */
  getOffer(offerId: string, currency: string): Promise<FlightOffer | null>;
  /** Provider-specific booking handoff (used when the provider is not the checkout provider). */
  handoff?(offer: FlightOffer): Promise<Handoff>;
}

export interface StaySearchRequest {
  lat: number; lng: number; radiusKm: number;
  checkIn: string; checkOut: string; adults: number; rooms: number; currency: string; userId?: string | null;
  /** Destination name, for providers that search by text. */
  placeName?: string;
}

export type Handoff =
  | { type: 'redirect'; url: string; provider: string; note: string }
  | { type: 'hosted_checkout'; url: string; provider: string; note: string }
  | { type: 'choices'; provider: string; note: string; choices: { label: string; price: number | null; currency: string; method: 'GET' | 'POST'; url: string; fields?: Record<string, string> }[] }
  | { type: 'unsupported'; provider: string; reason: string };

export interface StayProvider {
  name: string;
  configured(): boolean;
  search(req: StaySearchRequest): Promise<StayOption[]>;
  refresh(option: StayOption, req: StaySearchRequest): Promise<StayOption | null>;
  handoff(option: StayOption): Promise<Handoff>;
}

export interface CheckoutProvider {
  name: string;
  configured(): boolean;
  /** Creates a provider-hosted checkout session; the customer pays on the provider's page. */
  createSession(input: { reference: string; currency: string; successUrl: string; failureUrl: string; abandonmentUrl: string }): Promise<{ url: string }>;
  getOrder(orderId: string): Promise<{ id: string; bookingReference: string | null; total: { amount: number; currency: string }; slices: unknown[] } | null>;
}

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUrl: string;
  website: string | null;
  weekdayDescriptions: string[] | null;
  priceLevel: string | null;
  priceRange: { start?: { units?: string; currencyCode?: string }; end?: { units?: string; currencyCode?: string } } | null;
  rating: number | null;
  servesVegetarianFood: boolean | null;
  servesBreakfast: boolean | null;
  servesLunch: boolean | null;
  servesDinner: boolean | null;
  reservable: boolean | null;
  summary: string | null;
  types: string[];
  businessStatus: string | null;
  attributions: string[];
  /** Raw source facts (e.g. OpenStreetMap tags) usable as citable evidence. */
  facts?: string;
}

export interface PlacesProvider {
  name: string;
  configured(): boolean;
  textSearch(query: string, opts: { near?: { lat: number; lng: number; radiusM: number }; includedType?: string; max?: number; language?: string; userId?: string | null }): Promise<PlaceResult[]>;
}

export interface RoutesProvider {
  name: string;
  configured(): boolean;
  travelMinutes(from: { lat: number; lng: number }, to: { lat: number; lng: number }, departAt: Date, mode: 'DRIVE' | 'TRANSIT'): Promise<{ minutes: number; source: 'live_traffic' | 'schedule' }>;
}

export interface WeatherProvider {
  name: string;
  configured(): boolean;
  /** Forecast for dates within range; climate (historical averages) for later dates, labelled by `kind`. */
  forDates(lat: number, lng: number, dates: string[], tz: string): Promise<Record<string, DayWeather>>;
}

export interface AiProvider {
  name: string;
  configured(): boolean;
  json<T>(input: { system: string; user: string; maxTokens?: number; userId?: string | null; operation: string }): Promise<T>;
}

export interface WebResult { url: string; title: string; snippet: string }
export interface ResearchProvider {
  name: string;
  configured(): boolean;
  search(query: string, opts?: { count?: number; country?: string; userId?: string | null }): Promise<WebResult[]>;
  fetchText(url: string): Promise<{ url: string; title: string; text: string; retrievedAt: string }>;
}

export interface Messenger {
  name: string;
  configured(): boolean;
  sendTemplate(toE164: string, template: string, params: string[], language: string): Promise<{ messageId: string }>;
  verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;
}

export interface ChatMessenger {
  name: string;
  configured(): boolean;
  botUsername(): string | null;
  sendText(chatId: string, text: string): Promise<{ messageId: string }>;
  verifyWebhook(secretHeader: string | undefined): boolean;
  getUpdates(offset: number): Promise<{ updateId: number; chatId: string; text: string }[]>;
}

export interface Mailer {
  name: string;
  configured(): boolean;
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<void>;
}

export interface Providers {
  flights: FlightProvider;
  stays: StayProvider[];
  checkout: CheckoutProvider;
  places: PlacesProvider;
  routes: RoutesProvider;
  weather: WeatherProvider;
  ai: AiProvider;
  research: ResearchProvider;
  messenger: Messenger;
  mailer: Mailer;
  telegram?: ChatMessenger;
}
