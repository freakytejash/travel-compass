// Test fixtures. These are synthetic provider-shaped objects for MOCKED tests only.
import type { FlightOffer, FlightSlice, StayOption } from '../../src/shared/types.ts';
import { fromLocal } from '../../src/server/domain/time.ts';

export function seg(from: string, to: string, dep: string, arr: string, fromTz: string, toTz: string, flight = 'SN1234') {
  return {
    carrierCode: flight.slice(0, 2), carrierName: 'Test Air', flightNumber: flight, from, to,
    departLocal: dep + ':00', arriveLocal: arr + ':00', departTz: fromTz, arriveTz: toTz,
    departUtc: fromLocal(dep, fromTz).toISOString(), arriveUtc: fromLocal(arr, toTz).toISOString(),
  };
}

export function slice(segments: ReturnType<typeof seg>[]): FlightSlice {
  const first = segments[0]; const last = segments[segments.length - 1];
  const layovers = segments.slice(1).map((s, i) => {
    const prev = segments[i];
    const minutes = Math.round((Date.parse(s.departUtc) - Date.parse(prev.arriveUtc)) / 60000);
    const overnight = prev.arriveLocal.slice(0, 10) !== s.departLocal.slice(0, 10) && minutes > 240;
    return { airport: prev.to, minutes, overnight };
  });
  return { from: first.from, to: last.to, durationMinutes: Math.round((Date.parse(last.arriveUtc) - Date.parse(first.departUtc)) / 60000), segments, layovers };
}

export function offer(id: string, amount: number, slices: FlightSlice[], extra: Partial<FlightOffer> = {}): FlightOffer {
  return {
    provider: 'mock', providerOfferId: id, owner: 'Test Air', slices,
    total: { amount, currency: 'EUR' }, baggage: { checkedBags: 0, carryOn: 1, source: 'provider' },
    conditions: { refundable: false, changeable: true }, quotedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00Z', ...extra,
  };
}

export function stay(id: string, amount: number, extra: Partial<StayOption> = {}): StayOption {
  return {
    provider: 'mock', providerOfferId: id, propertyName: `Hotel ${id}`, address: '1 Test Street', lat: 41.39, lng: 2.17,
    checkIn: '2027-03-10', checkOut: '2027-03-13', nights: 3, roomType: 'Double room', roomKind: 'private', occupancy: 2,
    total: { amount, currency: 'EUR' }, taxesAndFees: null, dueAtProperty: null,
    cancellation: { freeUntil: null, refundable: true, summary: '' }, payment: 'pay_now', rating: 3, reviewScore: 8,
    link: null, quotedAt: new Date().toISOString(), expiresAt: null, ...extra,
  };
}
