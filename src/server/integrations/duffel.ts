// Duffel Flights, Stays, Places and Links. Docs: https://duffel.com/docs/api (Duffel-Version: v2).
import type { FlightOffer, FlightSegment, Place, StayOption } from '../../shared/types.ts';
import { minutesBetween, fromLocal } from '../domain/time.ts';
import { NotConfiguredError, ProviderError, requestJson } from './http.ts';
import type { CheckoutProvider, FlightProvider, FlightSearchRequest, Handoff, StayProvider, StaySearchRequest } from './types.ts';

const BASE = 'https://api.duffel.com';

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'Duffel-Version': 'v2', 'Accept-Encoding': 'gzip' };
}

/** ISO 8601 duration (PT2H5M / P1DT3H) -> minutes. */
export function isoDurationMinutes(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0);
}

interface DuffelSegment {
  departing_at: string; arriving_at: string;
  origin: { iata_code: string; time_zone: string };
  destination: { iata_code: string; time_zone: string };
  marketing_carrier: { iata_code: string; name: string };
  marketing_carrier_flight_number: string;
  passengers?: { baggages?: { type: string; quantity: number }[] }[];
}
interface DuffelOffer {
  id: string; expires_at?: string | null; total_amount: string; total_currency: string; tax_amount?: string | null; tax_currency?: string | null;
  owner?: { name: string };
  conditions?: { refund_before_departure?: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null; change_before_departure?: { allowed: boolean; penalty_amount?: string | null; penalty_currency?: string | null } | null };
  payment_requirements?: { requires_instant_payment?: boolean; price_guarantee_expires_at?: string | null };
  slices: { duration?: string | null; segments: DuffelSegment[] }[];
}

export function normaliseDuffelOffer(o: DuffelOffer, quotedAt = new Date().toISOString()): FlightOffer {
  let checked = Infinity; let carry = Infinity; let bagKnown = false;
  const slices = o.slices.map((sl) => {
    const segments: FlightSegment[] = sl.segments.map((s) => {
      for (const p of s.passengers ?? []) {
        if (!p.baggages) continue;
        bagKnown = true;
        checked = Math.min(checked, p.baggages.filter((b) => b.type === 'checked').reduce((a, b) => a + b.quantity, 0));
        carry = Math.min(carry, p.baggages.filter((b) => b.type === 'carry_on').reduce((a, b) => a + b.quantity, 0));
      }
      // Duffel returns local times without offsets; convert with the airport time zone.
      const departUtc = fromLocal(s.departing_at.slice(0, 19), s.origin.time_zone).toISOString();
      const arriveUtc = fromLocal(s.arriving_at.slice(0, 19), s.destination.time_zone).toISOString();
      return {
        carrierCode: s.marketing_carrier.iata_code, carrierName: s.marketing_carrier.name,
        flightNumber: `${s.marketing_carrier.iata_code}${s.marketing_carrier_flight_number}`,
        from: s.origin.iata_code, to: s.destination.iata_code,
        departLocal: s.departing_at.slice(0, 19), arriveLocal: s.arriving_at.slice(0, 19),
        departTz: s.origin.time_zone, arriveTz: s.destination.time_zone, departUtc, arriveUtc,
      };
    });
    const layovers = segments.slice(1).map((s, i) => {
      const prev = segments[i];
      const minutes = minutesBetween(prev.arriveUtc, s.departUtc);
      const overnight = minutes >= 240 && (prev.arriveLocal.slice(0, 10) !== s.departLocal.slice(0, 10) || Number(s.departLocal.slice(11, 13)) < 6);
      return { airport: prev.to, minutes, overnight };
    });
    const first = segments[0]; const last = segments[segments.length - 1];
    return { from: first.from, to: last.to, durationMinutes: isoDurationMinutes(sl.duration) ?? minutesBetween(first.departUtc, last.arriveUtc), segments, layovers };
  });
  const money = (a?: string | null, c?: string | null) => (a && c ? { amount: Number(a), currency: c } : null);
  return {
    provider: 'duffel', providerOfferId: o.id, owner: o.owner?.name ?? '', slices,
    total: { amount: Number(o.total_amount), currency: o.total_currency },
    tax: money(o.tax_amount, o.tax_currency ?? o.total_currency) ?? undefined,
    baggage: bagKnown ? { checkedBags: checked === Infinity ? 0 : checked, carryOn: carry === Infinity ? 0 : carry, source: 'provider' } : { checkedBags: 0, carryOn: 0, source: 'unknown' },
    conditions: {
      refundable: o.conditions?.refund_before_departure ? o.conditions.refund_before_departure.allowed : null,
      refundPenalty: money(o.conditions?.refund_before_departure?.penalty_amount, o.conditions?.refund_before_departure?.penalty_currency),
      changeable: o.conditions?.change_before_departure ? o.conditions.change_before_departure.allowed : null,
      changePenalty: money(o.conditions?.change_before_departure?.penalty_amount, o.conditions?.change_before_departure?.penalty_currency),
    },
    quotedAt, expiresAt: o.expires_at ?? null,
    priceGuaranteeExpiresAt: o.payment_requirements?.price_guarantee_expires_at ?? null,
    requiresInstantPayment: o.payment_requirements?.requires_instant_payment ?? null,
  };
}

export class DuffelFlights implements FlightProvider {
  name = 'duffel';
  private token?: string;
  constructor(token?: string) { this.token = token; }
  configured() { return !!this.token; }
  private t() { if (!this.token) throw new NotConfiguredError('Duffel', ['DUFFEL_ACCESS_TOKEN']); return this.token; }

  async searchPlaces(query: string, near?: { lat: number; lng: number; radiusM: number }): Promise<Place[]> {
    const qs = new URLSearchParams();
    if (query) qs.set('query', query);
    if (near) { qs.set('lat', String(near.lat)); qs.set('lng', String(near.lng)); qs.set('rad', String(near.radiusM)); }
    const r = await requestJson<{ data: any[] }>(`${BASE}/places/suggestions?${qs}`, { provider: 'duffel', operation: 'places.suggestions', headers: headers(this.t()), timeoutMs: 8000 });
    return r.data.map((p) => ({
      name: p.type === 'airport' ? `${p.name} (${p.iata_code})` : p.name, kind: p.type === 'airport' ? 'airport' : 'city',
      lat: p.latitude, lng: p.longitude, countryCode: p.iata_country_code, timeZone: p.time_zone ?? undefined, iata: p.iata_code,
      cityName: p.city_name ?? p.city?.name ?? undefined,
      airports: (p.airports ?? []).map((a: any) => ({ iata: a.iata_code, name: a.name, lat: a.latitude, lng: a.longitude, timeZone: a.time_zone })),
      source: 'duffel',
    }));
  }

  async searchOffers(req: FlightSearchRequest) {
    const body = { data: {
      slices: req.slices.map((s) => ({ origin: s.origin, destination: s.destination, departure_date: s.departureDate })),
      passengers: Array.from({ length: req.adults }, () => ({ type: 'adult' })),
      cabin_class: req.cabinClass ?? 'economy',
      max_connections: req.maxConnections ?? 1,
    } };
    const r = await requestJson<{ data: { id: string; offers: DuffelOffer[] } }>(`${BASE}/air/offer_requests?return_offers=true&supplier_timeout=20000`, {
      provider: 'duffel', operation: 'air.offer_requests.create', method: 'POST', headers: headers(this.t()), body, timeoutMs: 35000, idempotent: true, retries: 1, userId: req.userId,
    });
    const quotedAt = new Date().toISOString();
    return { providerRequestId: r.data.id, offers: r.data.offers.map((o) => normaliseDuffelOffer(o, quotedAt)) };
  }

  async getOffer(offerId: string): Promise<FlightOffer | null> {
    try {
      const r = await requestJson<{ data: DuffelOffer }>(`${BASE}/air/offers/${encodeURIComponent(offerId)}?return_available_services=false`, { provider: 'duffel', operation: 'air.offers.get', headers: headers(this.t()), timeoutMs: 20000 });
      return normaliseDuffelOffer(r.data);
    } catch (e) {
      if (e instanceof ProviderError && (e.status === 404 || e.status === 410 || e.status === 422)) return null;
      throw e;
    }
  }
}

export class DuffelStays implements StayProvider {
  name = 'duffel_stays';
  private token?: string; private enabled: boolean;
  constructor(token: string | undefined, enabled: boolean) { this.token = token; this.enabled = enabled; }
  configured() { return !!this.token && this.enabled; }

  async search(req: StaySearchRequest): Promise<StayOption[]> {
    if (!this.configured()) throw new NotConfiguredError('Duffel Stays', ['DUFFEL_ACCESS_TOKEN', 'DUFFEL_STAYS_ENABLED']);
    const body = { data: {
      check_in_date: req.checkIn, check_out_date: req.checkOut, rooms: req.rooms,
      guests: Array.from({ length: req.adults }, () => ({ type: 'adult' })),
      location: { radius: req.radiusKm, geographic_coordinates: { latitude: req.lat, longitude: req.lng } },
    } };
    const r = await requestJson<{ data: { results: any[] } }>(`${BASE}/stays/search`, { provider: 'duffel', operation: 'stays.search', method: 'POST', headers: headers(this.token!), body, timeoutMs: 30000, idempotent: true, retries: 1, userId: req.userId });
    const quotedAt = new Date().toISOString();
    const out: StayOption[] = [];
    for (const res of r.data.results) out.push(...normaliseDuffelStay(res, req, quotedAt));
    return out;
  }

  async refresh(option: StayOption, req: StaySearchRequest): Promise<StayOption | null> {
    // Re-run the search for this accommodation and look for the same rate id; Duffel quotes are created at booking time.
    const all = await this.search({ ...req, radiusKm: 1, lat: option.lat, lng: option.lng });
    return all.find((o) => o.providerOfferId === option.providerOfferId) ?? all.find((o) => o.propertyName === option.propertyName && o.roomType === option.roomType) ?? null;
  }

  async handoff(): Promise<Handoff> {
    return { type: 'unsupported', provider: 'duffel_stays', reason: 'Duffel Stays requires an in-app payment integration (Duffel Payments card component). Use the Duffel Links hosted checkout or book directly with the property.' };
  }
}

export function normaliseDuffelStay(res: any, req: Pick<StaySearchRequest, 'checkIn' | 'checkOut' | 'adults'>, quotedAt: string): StayOption[] {
  const acc = res.accommodation ?? {};
  const addr = acc.location?.address ?? {};
  const coords = acc.location?.geographic_coordinates ?? {};
  const nights = Math.round((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86400000);
  const out: StayOption[] = [];
  for (const room of acc.rooms ?? []) {
    for (const rate of room.rates ?? []) {
      const timeline: { before: string; refund_amount: string }[] = rate.cancellation_timeline ?? [];
      const full = timeline.filter((t) => Number(t.refund_amount) >= Number(rate.total_amount)).sort((a, b) => b.before.localeCompare(a.before))[0];
      const name = String(room.name ?? rate.name ?? 'Room');
      out.push({
        provider: 'duffel_stays', providerOfferId: rate.id, propertyName: acc.name, address: [addr.line_one, addr.postal_code, addr.city_name, addr.country_code].filter(Boolean).join(', '),
        lat: Number(coords.latitude), lng: Number(coords.longitude), checkIn: req.checkIn, checkOut: req.checkOut, nights,
        roomType: name + (rate.board_type ? ` · ${String(rate.board_type).replace(/_/g, ' ')}` : ''),
        roomKind: /dorm|bed in|shared/i.test(name) ? 'dorm' : 'private', occupancy: req.adults,
        total: { amount: Number(rate.total_amount), currency: rate.total_currency },
        taxesAndFees: rate.tax_amount || rate.fee_amount ? { amount: Number(rate.tax_amount ?? 0) + Number(rate.fee_amount ?? 0), currency: rate.tax_currency ?? rate.total_currency } : null,
        dueAtProperty: rate.due_at_accommodation_amount ? { amount: Number(rate.due_at_accommodation_amount), currency: rate.due_at_accommodation_currency ?? rate.total_currency } : null,
        cancellation: { freeUntil: full?.before ?? null, refundable: timeline.length ? timeline.some((t) => Number(t.refund_amount) > 0) : false, summary: timeline.length ? timeline.map((t) => `refund ${t.refund_amount} before ${t.before}`).join('; ') : 'Non-refundable (no cancellation timeline returned)' },
        payment: rate.payment_type ?? 'unknown', rating: acc.rating ?? null, reviewScore: acc.review_score ?? null,
        link: null, quotedAt, expiresAt: rate.expires_at ?? res.expires_at ?? null,
      });
    }
  }
  return out;
}

export class DuffelLinks implements CheckoutProvider {
  name = 'duffel_links';
  private token?: string; private enabled: boolean;
  constructor(token: string | undefined, enabled: boolean) { this.token = token; this.enabled = enabled; }
  configured() { return !!this.token && this.enabled; }
  async createSession(i: { reference: string; currency: string; successUrl: string; failureUrl: string; abandonmentUrl: string }) {
    if (!this.configured()) throw new NotConfiguredError('Duffel Links', ['DUFFEL_ACCESS_TOKEN', 'DUFFEL_LINKS_ENABLED']);
    const r = await requestJson<{ data: { url: string } }>(`${BASE}/links/sessions`, {
      provider: 'duffel', operation: 'links.sessions.create', method: 'POST', headers: headers(this.token!),
      body: { data: { reference: i.reference, success_url: i.successUrl, failure_url: i.failureUrl, abandonment_url: i.abandonmentUrl, traveller_currency: i.currency, flights: { enabled: 'true' }, stays: { enabled: 'false' } } },
    });
    if (!r.data?.url) throw new ProviderError('duffel', 'Links session response did not include a URL', 200, false);
    return { url: r.data.url };
  }
  async getOrder(orderId: string) {
    try {
      const r = await requestJson<{ data: any }>(`${BASE}/air/orders/${encodeURIComponent(orderId)}`, { provider: 'duffel', operation: 'air.orders.get', headers: headers(this.token!) });
      return { id: r.data.id, bookingReference: r.data.booking_reference ?? null, total: { amount: Number(r.data.total_amount), currency: r.data.total_currency }, slices: r.data.slices ?? [] };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }
}
