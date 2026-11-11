// Booking.com Demand API ("search, look and redirect"). Requires an affiliate partnership.
// Docs: https://developers.booking.com/demand/docs/accommodations/v3.2/accommodation-quick-guide
// Field mapping must be validated in the Booking.com sandbox before go-live (see docs/ADMIN_CHECKLIST.md).
import type { StayOption } from '../../shared/types.ts';
import { NotConfiguredError, requestJson } from './http.ts';
import type { Handoff, StayProvider, StaySearchRequest } from './types.ts';

export class BookingDemand implements StayProvider {
  name = 'booking_com';
  private token?: string; private affiliateId?: string; private base: string;
  constructor(token: string | undefined, affiliateId: string | undefined, base: string) { this.token = token; this.affiliateId = affiliateId; this.base = base.replace(/\/$/, ''); }
  configured() { return !!this.token && !!this.affiliateId; }
  private h() {
    if (!this.configured()) throw new NotConfiguredError('Booking.com Demand API', ['BOOKING_DEMAND_API_TOKEN', 'BOOKING_AFFILIATE_ID']);
    return { Authorization: `Bearer ${this.token}`, 'X-Affiliate-Id': this.affiliateId! };
  }

  async search(req: StaySearchRequest): Promise<StayOption[]> {
    const h = this.h();
    const search = await requestJson<{ data: any[] }>(`${this.base}/accommodations/search`, {
      provider: 'booking_com', operation: 'accommodations.search', method: 'POST', headers: h, idempotent: true, retries: 1, userId: req.userId,
      body: {
        booker: { country: 'be', platform: 'desktop' }, checkin: req.checkIn, checkout: req.checkOut,
        guests: { number_of_adults: req.adults, number_of_rooms: req.rooms },
        coordinates: { latitude: req.lat, longitude: req.lng, radius: req.radiusKm },
        currency: req.currency, extras: ['products'], rows: 30,
      },
    });
    const ids = search.data.slice(0, 30).map((d) => d.id);
    if (!ids.length) return [];
    const details = await requestJson<{ data: any[] }>(`${this.base}/accommodations/details`, {
      provider: 'booking_com', operation: 'accommodations.details', method: 'POST', headers: h, idempotent: true, retries: 1,
      body: { accommodations: ids, extras: ['description', 'policies'], languages: ['en-gb'] },
    });
    const byId = new Map(details.data.map((d) => [d.id, d]));
    const quotedAt = new Date().toISOString();
    const nights = Math.round((Date.parse(req.checkOut) - Date.parse(req.checkIn)) / 86400000);
    const out: StayOption[] = [];
    for (const r of search.data) {
      const d = byId.get(r.id);
      if (!d) continue;
      const total = r.price?.book ?? r.price?.total;
      if (total === undefined) continue;
      const name = d.name?.['en-gb'] ?? d.name?.en ?? String(d.name ?? 'Property');
      const products: any[] = r.products ?? [];
      const product = products[0];
      const roomName = product?.room_name ?? product?.room?.name ?? 'Room';
      out.push({
        provider: 'booking_com', providerOfferId: String(r.id) + (product?.id ? `:${product.id}` : ''), propertyName: name,
        address: [d.location?.address?.['en-gb'] ?? d.location?.address, d.location?.city_name, d.location?.country].filter((x) => typeof x === 'string').join(', '),
        lat: Number(d.location?.coordinates?.latitude), lng: Number(d.location?.coordinates?.longitude),
        checkIn: req.checkIn, checkOut: req.checkOut, nights, roomType: String(roomName),
        roomKind: /dorm|bed in|shared/i.test(String(roomName)) ? 'dorm' : 'private', occupancy: req.adults,
        total: { amount: Number(total), currency: r.currency?.booker ?? req.currency },
        taxesAndFees: r.price?.charges !== undefined ? { amount: Number(r.price.charges), currency: r.currency?.booker ?? req.currency } : null,
        dueAtProperty: null,
        cancellation: { freeUntil: product?.policies?.cancellation?.free_cancellation_until ?? null, refundable: product?.policies?.cancellation?.type ? product.policies.cancellation.type !== 'non_refundable' : null, summary: product?.policies?.cancellation?.type ?? 'See provider page' },
        payment: product?.policies?.payment?.timings?.join(', ') ?? 'See provider page',
        rating: d.rating?.stars ?? null, reviewScore: d.rating?.review_score ?? null,
        link: r.deep_link_url ?? r.url ?? null, quotedAt, expiresAt: null,
      });
    }
    return out;
  }

  async refresh(option: StayOption, req: StaySearchRequest): Promise<StayOption | null> {
    const all = await this.search({ ...req, lat: option.lat, lng: option.lng, radiusKm: 1 });
    return all.find((o) => o.providerOfferId.split(':')[0] === option.providerOfferId.split(':')[0]) ?? null;
  }

  async handoff(option: StayOption): Promise<Handoff> {
    if (!option.link) return { type: 'unsupported', provider: 'booking_com', reason: 'The provider did not return a booking link for this property.' };
    return { type: 'redirect', url: option.link, provider: 'Booking.com', note: 'You will complete the reservation and payment on Booking.com. Travel Compass does not see or store your card details.' };
  }
}
