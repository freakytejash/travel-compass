// Google Flights and Google Hotels results via SerpApi (free plan: 250 searches/month, no card).
// Each HTTP call is one SerpApi search; a monthly guard stops before the allowance is exceeded.
// These are real, current Google results, but SerpApi is not a booking provider: offers carry no fare rules or
// expiry, and booking happens on the airline/OTA/hotel site the customer chooses.
import type { FlightOffer, FlightSegment, FlightSlice, StayOption } from '../../shared/types.ts';
import { fromLocal, minutesBetween } from '../domain/time.ts';
import { haversineKm } from '../domain/time.ts';
import type { FreeGeo } from './freegeo.ts';
import { NotConfiguredError, ProviderError, requestJson } from './http.ts';
import type { FlightProvider, FlightSearchRequest, Handoff, StayProvider, StaySearchRequest } from './types.ts';

export type QuotaGuard = (provider: string) => Promise<void>;

const BASE = 'https://serpapi.com/search.json';

interface SerpFlight { departure_airport: { id: string; name?: string; time: string }; arrival_airport: { id: string; name?: string; time: string }; duration: number; airline: string; flight_number: string; travel_class?: string; extensions?: string[]; overnight?: boolean }
interface SerpItinerary { flights: SerpFlight[]; layovers?: { duration: number; id: string; name?: string; overnight?: boolean }[]; total_duration: number; price?: number; type?: string; departure_token?: string; booking_token?: string; extensions?: string[] }

interface OfferRef { d: string; a: string; o: string; r: string; ad: number; c: string; mc?: { departure_id: string; arrival_id: string; date: string }[]; k: string }

function encodeRef(r: OfferRef) { return 'serp:' + Buffer.from(JSON.stringify(r)).toString('base64url'); }
function decodeRef(id: string): OfferRef | null {
  if (!id.startsWith('serp:')) return null;
  try { return JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8')); } catch { return null; }
}
const itinKey = (legs: SerpItinerary[]) => legs.map((l) => l.flights.map((f) => `${f.flight_number.replace(/\s+/g, '')}@${f.departure_airport.time}`).join('+')).join('/');

/** Converts a SerpApi itinerary into a slice; local times are converted with each airport's time zone. */
export async function serpSlice(it: SerpItinerary, tzOf: (iata: string) => Promise<string>): Promise<FlightSlice> {
  const segments: FlightSegment[] = [];
  for (const f of it.flights) {
    const depTz = await tzOf(f.departure_airport.id); const arrTz = await tzOf(f.arrival_airport.id);
    const dl = f.departure_airport.time.replace(' ', 'T') + ':00'; const al = f.arrival_airport.time.replace(' ', 'T') + ':00';
    const fn = f.flight_number.replace(/\s+/g, '');
    segments.push({ carrierCode: fn.slice(0, 2), carrierName: f.airline, flightNumber: fn, from: f.departure_airport.id, to: f.arrival_airport.id, departLocal: dl, arriveLocal: al, departTz: depTz, arriveTz: arrTz,
      departUtc: fromLocal(dl, depTz).toISOString(), arriveUtc: fromLocal(al, arrTz).toISOString() });
  }
  const layovers = segments.slice(1).map((s, i) => {
    const l = it.layovers?.[i];
    const minutes = l?.duration ?? minutesBetween(segments[i].arriveUtc, s.departUtc);
    return { airport: l?.id ?? segments[i].to, minutes, overnight: l?.overnight ?? (minutes >= 240 && segments[i].arriveLocal.slice(0, 10) !== s.departLocal.slice(0, 10)) };
  });
  return { from: segments[0].from, to: segments[segments.length - 1].to, durationMinutes: it.total_duration ?? minutesBetween(segments[0].departUtc, segments[segments.length - 1].arriveUtc), segments, layovers };
}

function baggageFrom(legs: SerpItinerary[]): FlightOffer['baggage'] {
  const ext = legs.flatMap((l) => [...(l.extensions ?? []), ...l.flights.flatMap((f) => f.extensions ?? [])]).join(' | ').toLowerCase();
  if (/1 free checked bag|checked bag included|1 checked bag/.test(ext)) return { checkedBags: 1, carryOn: 1, source: 'provider' };
  return { checkedBags: 0, carryOn: /carry-on bag (is )?not included|no carry-on/.test(ext) ? 0 : 1, source: 'unknown' };
}

export class SerpApiFlights implements FlightProvider {
  name = 'serpapi_google_flights';
  private key?: string; private geo: FreeGeo; private quota: QuotaGuard; private gl: string;
  constructor(key: string | undefined, geo: FreeGeo, quota: QuotaGuard, gl = 'be') { this.key = key; this.geo = geo; this.quota = quota; this.gl = gl; }
  configured() { return !!this.key; }
  /** Google Flights accepts several departure/arrival airports in one search (comma-separated), so one search covers all nearby airports. */
  multiAirport = true;
  searchPlaces(query: string, near?: { lat: number; lng: number; radiusM: number }) { return this.geo.searchPlaces(query, near); }
  async nearbyAirports(lat: number, lng: number, radiusKm: number, max: number) { return (await this.geo.nearbyAirports(lat, lng, radiusKm, max)).map((a) => ({ iata: a.iata, name: a.name, lat: a.lat, lng: a.lng })); }
  async airportInfo(iata: string) { const a = await this.geo.airport(iata); return a ? { iata: a.iata, name: a.name, lat: a.lat, lng: a.lng, city: a.city, country: a.country } : null; }

  private async call(params: Record<string, string>, op: string, userId?: string | null): Promise<any> {
    if (!this.key) throw new NotConfiguredError('SerpApi', ['SERPAPI_API_KEY']);
    await this.quota('serpapi');
    const qs = new URLSearchParams({ engine: 'google_flights', hl: 'en', gl: this.gl, ...params, api_key: this.key });
    const r = await requestJson<any>(`${BASE}?${qs}`, { provider: 'serpapi', operation: op, timeoutMs: 60000, retries: 1, userId });
    if (r.error && !/hasn't returned any results/i.test(r.error)) throw new ProviderError('serpapi', String(r.error).slice(0, 200), 200, false);
    return r;
  }

  private tzOf = async (iata: string) => {
    const a = await this.geo.airport(iata);
    if (!a) throw new ProviderError('serpapi', `unknown airport ${iata} (airport dataset missing?)`, null, false);
    return this.geo.timeZone(a.lat, a.lng);
  };

  private baseParams(ref: OfferRef): Record<string, string> {
    const p: Record<string, string> = { currency: ref.c, adults: String(ref.ad), travel_class: '1' };
    if (ref.mc) { p.type = '3'; p.multi_city_json = JSON.stringify(ref.mc); }
    else { p.type = '1'; p.departure_id = ref.d; p.arrival_id = ref.a; p.outbound_date = ref.o; p.return_date = ref.r; }
    return p;
  }

  private async build(ref: OfferRef, out: SerpItinerary, back: SerpItinerary, searchUrl: string | undefined, price: number | undefined, quotedAt: string, incomplete?: string): Promise<FlightOffer> {
    const slices = [await serpSlice(out, this.tzOf)];
    if (back) slices.push(await serpSlice(back, this.tzOf));
    const key = itinKey(back ? [out, back] : [out]);
    return {
      provider: 'serpapi', providerOfferId: encodeRef({ ...ref, k: key }), owner: [...new Set(slices.flatMap((s) => s.segments.map((g) => g.carrierName)))].join(' / '), slices,
      total: { amount: Number(price ?? out.price), currency: ref.c }, baggage: baggageFrom(back ? [out, back] : [out]),
      conditions: { refundable: null, changeable: null }, quotedAt, expiresAt: null,
      providerData: { bookingToken: back?.booking_token ?? out.booking_token, searchUrl, priceNote: `Google Flights price for ${ref.ad} adult${ref.ad > 1 ? 's' : ''}, as shown at search time; the seller confirms the final price.` },
      incomplete,
    };
  }

  async searchOffers(req: FlightSearchRequest) {
    const [o, i] = req.slices;
    if (!o || !i) throw new ProviderError('serpapi', 'only round-trip and open-jaw searches are supported', null, false);
    const ref: OfferRef = o.destination === i.origin
      ? { d: o.origin, a: o.destination, o: o.departureDate, r: i.departureDate, ad: req.adults, c: req.currency, k: '' }
      : { d: o.origin, a: o.destination, o: o.departureDate, r: i.departureDate, ad: req.adults, c: req.currency, k: '', mc: [{ departure_id: o.origin, arrival_id: o.destination, date: o.departureDate }, { departure_id: i.origin, arrival_id: i.destination, date: i.departureDate }] };
    const params = this.baseParams(ref);
    if (req.maxConnections !== undefined) params.stops = req.maxConnections <= 0 ? '1' : req.maxConnections === 1 ? '2' : '0';
    const first = await this.call(params, 'flights.outbound', req.userId);
    const searchUrl: string | undefined = first.search_metadata?.google_flights_url;
    const outs: SerpItinerary[] = [...(first.best_flights ?? []), ...(first.other_flights ?? [])].filter((x) => x.flights?.length && typeof x.price === 'number');
    const quotedAt = new Date().toISOString();
    if (req.depth === 'quick') {
      // Round-trip price per outbound option; the return leg is only expanded when the customer selects it.
      const offers = await Promise.all(outs.slice(0, 6).map((x) => this.build(ref, x, undefined as any, searchUrl, x.price, quotedAt, 'Return flight not yet chosen; price is the lowest round-trip price shown for this outbound flight.')));
      return { providerRequestId: first.search_metadata?.id ?? 'serpapi', offers };
    }
    // Expand return options for the cheapest and the "best" outbound choices (2 extra searches).
    const pick = [...new Set([outs[0], [...outs].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9))[0]].filter(Boolean))].slice(0, 2);
    const offers: FlightOffer[] = [];
    for (const out of pick) {
      if (!out.departure_token) continue;
      const ret = await this.call({ ...params, departure_token: out.departure_token }, 'flights.return', req.userId);
      const backs: SerpItinerary[] = [...(ret.best_flights ?? []), ...(ret.other_flights ?? [])].filter((x) => x.flights?.length);
      for (const back of backs.slice(0, 5)) offers.push(await this.build(ref, out, back, searchUrl, back.price ?? out.price, quotedAt));
    }
    // Remaining outbound options are kept as price-level offers so the shortlist shows the full spread.
    for (const out of outs.filter((x) => !pick.includes(x)).slice(0, 6)) offers.push(await this.build(ref, out, undefined as any, searchUrl, out.price, quotedAt, 'Return flight not expanded; select to see returns.'));
    return { providerRequestId: first.search_metadata?.id ?? 'serpapi', offers };
  }

  /** Re-runs the search and returns the same itinerary at its current price, or null if it is gone. */
  async getOffer(offerId: string): Promise<FlightOffer | null> {
    const ref = decodeRef(offerId);
    if (!ref) return null;
    const params = this.baseParams(ref);
    const first = await this.call(params, 'flights.reprice');
    const [outKey, backKey] = ref.k.split('/');
    const outs: SerpItinerary[] = [...(first.best_flights ?? []), ...(first.other_flights ?? [])];
    const out = outs.find((x) => itinKey([x]) === outKey);
    if (!out) return null;
    const quotedAt = new Date().toISOString();
    if (!backKey) {
      // Price-level offer: expand the cheapest return for this outbound so the customer can review a complete trip.
      if (!out.departure_token) return null;
      const ret = await this.call({ ...params, departure_token: out.departure_token }, 'flights.reprice_return');
      const backs: SerpItinerary[] = [...(ret.best_flights ?? []), ...(ret.other_flights ?? [])].filter((x) => x.flights?.length).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
      return backs[0] ? this.build(ref, out, backs[0], first.search_metadata?.google_flights_url, backs[0].price, quotedAt) : null;
    }
    if (!out.departure_token) return null;
    const ret = await this.call({ ...params, departure_token: out.departure_token }, 'flights.reprice_return');
    const back = [...(ret.best_flights ?? []), ...(ret.other_flights ?? [])].find((x: SerpItinerary) => itinKey([x]) === backKey);
    return back ? this.build(ref, out, back, first.search_metadata?.google_flights_url, back.price, quotedAt) : null;
  }

  /** Booking options (airline and agency sellers) for the exact itinerary, via Google's own redirect. */
  async handoff(offer: FlightOffer): Promise<Handoff> {
    const ref = decodeRef(offer.providerOfferId);
    const token = offer.providerData?.bookingToken;
    if (ref && token) {
      try {
        const r = await this.call({ ...this.baseParams(ref), booking_token: token }, 'flights.booking_options');
        const choices = (r.booking_options ?? []).map((b: any) => b.together ?? b.departing ?? b).filter((t: any) => t?.booking_request?.url).slice(0, 8).map((t: any) => {
          const fields = t.booking_request.post_data ? Object.fromEntries(new URLSearchParams(t.booking_request.post_data)) : undefined;
          return { label: String(t.book_with ?? 'Seller'), price: typeof t.price === 'number' ? t.price : null, currency: ref.c, method: fields ? 'POST' as const : 'GET' as const, url: String(t.booking_request.url), fields };
        }).filter((c: { url: string }) => /^https:\/\/(www\.)?google\.[a-z.]+\//.test(c.url));
        if (choices.length) return { type: 'choices', provider: 'Google Flights', note: `Choose a seller. You will review the final price and pay on the seller's site (airline or agency) — Travel Compass never sees your card. Flights: ${offer.slices.map((s) => s.segments.map((g) => g.flightNumber).join('+')).join(' / ')}.`, choices };
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
      }
    }
    const url = offer.providerData?.searchUrl;
    if (url && /^https:\/\/(www\.)?google\.[a-z.]+\//.test(url)) {
      return { type: 'redirect', url, provider: 'Google Flights', note: `This opens the Google Flights results for your dates, not a checkout. Pick flights ${offer.slices.map((s) => s.segments.map((g) => g.flightNumber).join('+')).join(' / ')} and book with the airline or agency shown there.` };
    }
    return { type: 'unsupported', provider: 'Google Flights', reason: 'No booking link is available. Book this exact flight with the airline using the flight numbers shown.' };
  }
}

export class SerpApiHotels implements StayProvider {
  name = 'serpapi_google_hotels';
  private key?: string; private quota: QuotaGuard; private gl: string;
  constructor(key: string | undefined, quota: QuotaGuard, gl = 'be') { this.key = key; this.quota = quota; this.gl = gl; }
  configured() { return !!this.key; }

  async search(req: StaySearchRequest): Promise<StayOption[]> {
    if (!this.key) throw new NotConfiguredError('SerpApi', ['SERPAPI_API_KEY']);
    await this.quota('serpapi');
    const qs = new URLSearchParams({ engine: 'google_hotels', q: `${req.placeName ?? `${req.lat},${req.lng}`} hotels`, check_in_date: req.checkIn, check_out_date: req.checkOut, adults: String(req.adults), currency: req.currency, hl: 'en', gl: this.gl, api_key: this.key });
    const r = await requestJson<any>(`${BASE}?${qs}`, { provider: 'serpapi', operation: 'hotels.search', timeoutMs: 60000, retries: 1, userId: req.userId });
    if (r.error && !/hasn't returned any results/i.test(r.error)) throw new ProviderError('serpapi', String(r.error).slice(0, 200), 200, false);
    return normaliseSerpHotels(r, req, new Date().toISOString());
  }

  async refresh(option: StayOption, req: StaySearchRequest): Promise<StayOption | null> {
    const all = await this.search(req);
    return all.find((o) => o.providerOfferId === option.providerOfferId) ?? all.find((o) => o.propertyName === option.propertyName) ?? null;
  }

  async handoff(option: StayOption): Promise<Handoff> {
    if (!option.link) return { type: 'unsupported', provider: 'Google Hotels', reason: 'No booking link was returned for this property.' };
    return { type: 'redirect', url: option.link, provider: option.propertyName, note: 'This opens the property or Google Hotels page. Check the final price, taxes and cancellation terms there before paying; Travel Compass never sees your card.' };
  }
}

export function normaliseSerpHotels(r: any, req: Pick<StaySearchRequest, 'lat' | 'lng' | 'radiusKm' | 'checkIn' | 'checkOut' | 'adults' | 'currency'>, quotedAt: string): StayOption[] {
  const nights = Math.round((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86400000);
  const fallbackLink: string | undefined = r.search_metadata?.google_hotels_url;
  const out: StayOption[] = [];
  for (const p of r.properties ?? []) {
    const lat = p.gps_coordinates?.latitude; const lng = p.gps_coordinates?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (haversineKm({ lat, lng }, req) > Math.max(req.radiusKm, 8)) continue;
    let total: number | null = typeof p.total_rate?.extracted_lowest === 'number' ? p.total_rate.extracted_lowest : null;
    let estimated = false;
    if (total === null && typeof p.rate_per_night?.extracted_lowest === 'number') { total = p.rate_per_night.extracted_lowest * nights; estimated = true; }
    if (total === null) continue; // never present an unpriced property as an option
    const beforeTax = p.total_rate?.extracted_before_taxes_fees;
    const amenities: string[] = p.amenities ?? [];
    const freeCancel = amenities.some((a) => /free cancellation/i.test(a)) || /free cancellation/i.test(p.deal_description ?? '');
    const name = String(p.name ?? 'Property');
    const link = typeof p.link === 'string' && p.link.startsWith('https://') ? p.link : fallbackLink && fallbackLink.startsWith('https://') ? fallbackLink : null;
    out.push({
      provider: 'serpapi_google_hotels', providerOfferId: String(p.property_token ?? `${name}|${lat.toFixed(4)}`), propertyName: name,
      address: p.address ?? p.description ?? `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng, checkIn: req.checkIn, checkOut: req.checkOut, nights,
      roomType: p.type === 'vacation rental' ? 'Vacation rental' : 'Room (type chosen on provider site)',
      roomKind: /hostel|dorm/i.test(name) ? 'unknown' : p.type === 'vacation rental' ? 'private' : 'unknown',
      occupancy: req.adults, total: { amount: total, currency: req.currency },
      taxesAndFees: typeof beforeTax === 'number' && beforeTax <= total ? { amount: Math.round((total - beforeTax) * 100) / 100, currency: req.currency } : null,
      dueAtProperty: null,
      cancellation: { freeUntil: null, refundable: freeCancel ? true : null, summary: freeCancel ? 'Free cancellation offered by at least one seller — confirm the deadline on the booking site' : 'Cancellation terms not reported — check on the booking site' },
      payment: estimated ? 'Estimated from the nightly rate × nights; confirm the total on the booking site' : 'Lowest total shown on Google Hotels; seller confirms the final price',
      rating: p.extracted_hotel_class ?? null, reviewScore: typeof p.overall_rating === 'number' ? Math.round(p.overall_rating * 20) / 10 : null,
      link, quotedAt, expiresAt: null,
    });
  }
  return out;
}

export interface ExploreDestination {
  name: string; country: string; iata: string | null; lat: number | null; lng: number | null;
  flightPrice: number | null; hotelPerNight: number | null; startDate: string | null; endDate: string | null;
  flightMinutes: number | null; stops: number | null; airline: string | null; thumbnail: string | null; link: string | null;
}

/** Google Travel Explore via SerpApi: cheapest destinations from one or more departure airports for given dates (one search). */
export class SerpApiExplore {
  name = 'serpapi_google_travel_explore';
  private key?: string; private quota: QuotaGuard; private gl: string;
  constructor(key: string | undefined, quota: QuotaGuard, gl = 'be') { this.key = key; this.quota = quota; this.gl = gl; }
  configured() { return !!this.key; }
  async explore(req: { departureIds: string[]; outboundDate: string; returnDate: string; currency: string; adults: number; userId?: string | null; maxPrice?: number | null }): Promise<{ destinations: ExploreDestination[]; searchUrl: string | null }> {
    if (!this.key) throw new NotConfiguredError('SerpApi', ['SERPAPI_API_KEY']);
    await this.quota('serpapi');
    const qs = new URLSearchParams({ engine: 'google_travel_explore', departure_id: req.departureIds.join(','), outbound_date: req.outboundDate, return_date: req.returnDate, type: '1', currency: req.currency, adults: String(req.adults), hl: 'en', gl: this.gl, api_key: this.key });
    if (req.maxPrice) qs.set('max_price', String(Math.round(req.maxPrice)));
    const r = await requestJson<any>(`${BASE}?${qs}`, { provider: 'serpapi', operation: 'travel_explore', timeoutMs: 60000, retries: 1, userId: req.userId });
    if (r.error && !/hasn't returned any results/i.test(r.error)) throw new ProviderError('serpapi', String(r.error).slice(0, 200), 200, false);
    return { destinations: normaliseExplore(r), searchUrl: typeof r.search_metadata?.google_travel_explore_url === 'string' ? r.search_metadata.google_travel_explore_url : null };
  }
}

export function normaliseExplore(r: any): ExploreDestination[] {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const https = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') ? v : null);
  return (r.destinations ?? []).filter((d: any) => d?.name).map((d: any) => ({
    name: String(d.name), country: String(d.country ?? ''), iata: /^[A-Z]{3}$/.test(d.destination_airport?.code ?? '') ? d.destination_airport.code : null,
    lat: num(d.gps_coordinates?.latitude), lng: num(d.gps_coordinates?.longitude),
    flightPrice: num(d.flight_price), hotelPerNight: num(d.hotel_price), startDate: d.start_date ?? null, endDate: d.end_date ?? null,
    flightMinutes: num(d.flight_duration), stops: num(d.number_of_stops), airline: d.airline ? String(d.airline) : null,
    thumbnail: https(d.thumbnail), link: https(d.link),
  }));
}
