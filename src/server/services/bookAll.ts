// "Book everything": one checklist per trip covering every thing that needs booking, with the best and cheapest
// live options we have (flights, stays) and prefilled comparison links where no free price feed exists
// (car rental, hostels and holiday rentals, ground transport, tickets). Nothing is booked or paid here.
import type { AppContext } from '../context.ts';
import { addDays, daysBetween, haversineKm } from '../domain/time.ts';
import type { Place } from '../../shared/types.ts';
import { getOwnedTrip, getStops, type Stop } from './trips.ts';
import { getProfile } from './profile.ts';

export interface BookLink { label: string; url: string }
export interface BookOption { role: string; title: string; price: { amount: number; currency: string } | null; detail: string; offerId?: string; link?: string | null; offer?: { id: string; kind: string; provider: string; data: unknown; total: { amount: number; currency: string }; quotedAt: string; role: string | null; selected: boolean } }
export interface BookItem {
  key: string; section: 'flights' | 'stays' | 'transport' | 'car' | 'activities' | 'extras';
  title: string; subtitle: string;
  status: 'booked' | 'chosen' | 'to_book' | 'search_needed' | 'optional';
  options: BookOption[]; links: BookLink[]; note: string;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const cityOf = (p: Place) => (p.cityName ?? p.name).replace(/\s*\([A-Z]{3}\)$/, '');
const offerOf = (o: any) => ({ id: o.id, kind: o.kind, provider: o.provider, data: o.data, total: { amount: Number(o.total_amount), currency: o.currency }, quotedAt: o.quoted_at, role: o.role, selected: o.selected });
const iataOf = (p: Place | null | undefined) => (p ? (p.kind === 'airport' ? p.iata : p.airports?.[0]?.iata ?? p.iata) ?? null : null);

export function flightLinks(from: string, to: string, out: string, back: string, adults: number, fromCity?: string): BookLink[] {
  const yymmdd = (d: string) => d.slice(2).replace(/-/g, '');
  return [
    { label: 'Google Flights', url: `https://www.google.com/travel/flights?${q({ q: `Flights from ${fromCity ?? from} to ${to} on ${out} through ${back}${adults > 1 ? ` for ${adults} adults` : ''}` })}` },
    { label: 'Skyscanner', url: `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yymmdd(out)}/${yymmdd(back)}/?${q({ adultsv2: String(adults) })}` },
    { label: 'Kayak', url: `https://www.kayak.com/flights/${from}-${to}/${out}/${back}${adults > 1 ? `/${adults}adults` : ''}?sort=price_a` },
  ];
}

export function stayLinks(city: string, checkIn: string, checkOut: string, adults: number): BookLink[] {
  const base = { ss: city, checkin: checkIn, checkout: checkOut, group_adults: String(adults), no_rooms: '1', group_children: '0' };
  return [
    { label: 'Hostels (Booking.com)', url: `https://www.booking.com/searchresults.html?${q({ ...base, nflt: 'ht_id=203' })}` },
    { label: 'Cheapest hotels (Booking.com)', url: `https://www.booking.com/searchresults.html?${q({ ...base, order: 'price' })}` },
    { label: 'Airbnb', url: `https://www.airbnb.com/s/${encodeURIComponent(city)}/homes?${q({ checkin: checkIn, checkout: checkOut, adults: String(adults) })}` },
    { label: 'Google Hotels: hostels', url: `https://www.google.com/travel/search?${q({ q: `hostels in ${city}` })}` },
  ];
}

export function carLinks(iata: string | null, city: string, pickUp: string, dropOff: string): BookLink[] {
  const where = iata ?? city;
  return [
    { label: 'Kayak car rental', url: `https://www.kayak.com/cars/${encodeURIComponent(where)}/${pickUp}/${dropOff}?sort=price_a` },
    { label: 'Google: car rental', url: `https://www.google.com/search?${q({ q: `cheap car rental ${iata ? `${iata} airport` : city} ${pickUp} to ${dropOff}` })}` },
  ];
}

export function transportLink(from: string, to: string): BookLink {
  return { label: 'Rome2Rio (trains, buses, ferries)', url: `https://www.rome2rio.com/map/${encodeURIComponent(from)}/${encodeURIComponent(to)}` };
}

export async function bookingPlan(ctx: AppContext, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  const offers = (await ctx.db.query<any>(`SELECT id, kind, stop_id, provider, data, total_amount, currency, role, explanation, selected, quoted_at FROM offers WHERE trip_id=$1 AND (role IS NOT NULL OR selected) ORDER BY quoted_at DESC`, [tripId])).rows;
  const reservations = (await ctx.db.query<any>(`SELECT kind, provider_name, confirmation_code, start_at, details FROM reservations WHERE trip_id=$1 AND user_id=$2`, [tripId, userId])).rows;
  const items: BookItem[] = [];
  const booked = (kind: string) => reservations.filter((r) => r.kind === kind);
  const fromIata = iataOf(trip.origin);
  const firstStop = stops[0]; const lastStop = stops[stops.length - 1];

  // ---- flights
  if (trip.startDate && trip.endDate && firstStop) {
    const to = iataOf(firstStop.place); const back = iataOf(lastStop.place);
    const fl = offers.filter((o) => o.kind === 'flight');
    const chosen = fl.find((o) => o.selected);
    const opts: BookOption[] = ['recommended', 'cheapest', 'convenient'].map((role) => fl.find((o) => o.role === role)).filter(Boolean).map((o: any) => {
      const off = o.data.offer;
      const desc = off.slices.map((s: any) => `${s.from}→${s.to} ${s.segments[0].departLocal.slice(5, 16).replace('T', ' ')} · ${s.segments.length - 1 ? `${s.segments.length - 1} stop` : 'direct'}`).join(' / ');
      return { role: o.role, title: off.owner, price: { amount: Number(o.total_amount), currency: o.currency }, detail: `${desc}. ${o.explanation}`.trim(), offerId: o.id, offer: offerOf(o) };
    });
    const b = booked('flight');
    items.push({ key: 'flights', section: 'flights', title: `Flights ${trip.origin?.cityName ?? trip.origin?.name ?? ''} ⇄ ${cityOf(firstStop.place)}`, subtitle: `${trip.startDate} → ${trip.endDate} · ${trip.adults} traveller${trip.adults > 1 ? 's' : ''}`,
      status: b.length ? 'booked' : chosen ? 'chosen' : opts.length ? 'to_book' : 'search_needed', options: opts,
      links: fromIata && to ? flightLinks(fromIata, to, trip.startDate, trip.endDate, trip.adults, trip.origin?.kind === 'city' ? trip.origin.name : undefined) : [],
      note: b.length ? `Booked: ${b.map((r) => `${r.provider_name} ${r.confirmation_code ?? ''}`.trim()).join(', ')}` : opts.length ? 'Recommended balances price, time and transfers to your airport; cheapest is the lowest fare we found from all airports near you. Book with "Book" on the Flights tab or compare on the sites below.' : 'Run the flight search (Flights tab) to load live prices from every airport near you.' });
    if (back && back !== to && stops.length > 1) items[items.length - 1].note += ' Open-jaw: you return from a different city.';
  }

  // ---- stays, ground transport and car per stop
  const items2 = await Promise.all(stops.map(async (s, i) => {
    const out: BookItem[] = [];
    const city = cityOf(s.place); const nights = daysBetween(s.arriveDate, s.departDate);
    if (nights > 0) {
      const st = offers.filter((o) => o.kind === 'stay' && o.stop_id === s.id);
      const chosen = st.find((o) => o.selected);
      const opts: BookOption[] = ['recommended', 'cheapest', 'comfortable'].map((role) => st.find((o) => o.role === role)).filter(Boolean).map((o: any) => {
        const x = o.data.stay;
        return { role: o.role, title: x.propertyName, price: { amount: Number(o.total_amount), currency: o.currency }, detail: `${x.roomType}${x.reviewScore ? ` · ${x.reviewScore}/10` : ''} · ${x.cancellation?.summary ?? ''}. ${o.explanation}`.trim(), offerId: o.id, link: x.link ?? null, offer: offerOf(o) };
      });
      const b = booked('stay').filter((r) => !r.start_at || String(new Date(r.start_at).toISOString()).slice(0, 10) <= s.departDate);
      out.push({ key: `stay:${s.id}`, section: 'stays', title: `Stay in ${city}`, subtitle: `${s.arriveDate} → ${s.departDate} · ${nights} night${nights > 1 ? 's' : ''}`,
        status: b.length ? 'booked' : chosen ? 'chosen' : opts.length ? 'to_book' : 'search_needed', options: opts, links: stayLinks(city, s.arriveDate, s.departDate, trip.adults),
        note: opts.length ? `Live prices from Google Hotels${profile.accommodationPref === 'dorm' ? '; you prefer dorms, so also check the hostel links' : ''}. Hostel and Airbnb links open those sites with your dates — prices are not loaded here (no free feed).` : 'Run the stay search (Stays tab) for live hotel prices, or compare hostels and rentals with the links below.' });
    }
    // Getting from the arrival airport into the city (first stop) and between stops.
    const ap = s.place.airports?.[0];
    if (i === 0 && ap) out.push({ key: `transfer:${s.id}`, section: 'transport', title: `Airport ${ap.iata} → ${city}`, subtitle: `${s.arriveDate} · ${Math.round(haversineKm(s.place, ap))} km`, status: booked('transport').length ? 'booked' : 'optional', options: [], links: [transportLink(ap.name, city)], note: 'Usually no need to pre-book; check if a train or bus needs a ticket in advance.' });
    const next = stops[i + 1];
    if (next) out.push({ key: `move:${s.id}`, section: 'transport', title: `${city} → ${cityOf(next.place)}`, subtitle: s.departDate, status: booked('transport').length ? 'booked' : 'to_book', options: [], links: [transportLink(city, cityOf(next.place)), ...(iataOf(s.place) && iataOf(next.place) ? flightLinks(iataOf(s.place)!, iataOf(next.place)!, s.departDate, s.departDate, trip.adults).slice(0, 1) : [])], note: 'Travel between destinations is not included in the flight search.' });
    // Car rental: recommended when planned hikes or sights are far from the city centre.
    const far = (await ctx.db.query<any>(`SELECT i.title, i.venue FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE d.trip_id=$1 AND d.stop_id=$2 AND i.kind IN ('hike','activity') AND i.venue IS NOT NULL`, [tripId, s.id])).rows
      .filter((r) => typeof r.venue?.lat === 'number' && haversineKm(s.place, r.venue) > 15);
    const pick = s.arriveDate; const drop = s.departDate > s.arriveDate ? s.departDate : addDays(s.arriveDate, 1);
    out.push({ key: `car:${s.id}`, section: 'car', title: `Car rental in ${city}`, subtitle: `${pick} → ${drop}`, status: far.length ? 'to_book' : 'optional', options: [],
      links: carLinks(ap?.iata ?? null, city, pick, drop),
      note: far.length ? `Recommended: ${far.slice(0, 3).map((r) => r.title).join(', ')} ${far.length > 1 ? 'are' : 'is'} more than 15 km from ${city}. Links open sorted by price; live car prices are not loaded here (no free price source).` : 'Optional: your plan stays near the city, where public transport is usually cheaper. Links open car-rental comparisons sorted by price; live car prices are not loaded here (no free price source).' });
    return out;
  }));
  items.push(...items2.flat());

  // ---- activities that need tickets or reservations
  const acts = (await ctx.db.query<any>(`SELECT i.id, i.title, i.start_local, i.booking_required, i.venue, i.meta FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE d.trip_id=$1 AND i.booking_required IN ('yes','recommended') ORDER BY i.start_local`, [tripId])).rows;
  for (const a of acts.slice(0, 15)) {
    const done = booked('activity').some((r) => r.provider_name && a.title.toLowerCase().includes(String(r.provider_name).toLowerCase()));
    items.push({ key: `act:${a.id}`, section: 'activities', title: a.title, subtitle: `${a.start_local.slice(0, 10)} ${a.start_local.slice(11, 16)}`, status: done ? 'booked' : a.booking_required === 'yes' ? 'to_book' : 'optional', options: [],
      links: [a.venue?.website ? { label: 'Official website', url: a.venue.website } : null, a.venue?.mapsUrl ? { label: 'Map', url: a.venue.mapsUrl } : null].filter(Boolean) as BookLink[],
      note: a.booking_required === 'yes' ? 'Reservation or timed ticket required — book on the official site.' : 'Booking recommended (busy or limited capacity).' });
  }
  if (!acts.length) items.push({ key: 'act:none', section: 'activities', title: 'Tickets & reservations', subtitle: trip.planStatus === 'complete' ? 'Nothing in your plan needs a reservation' : 'Shown once your itinerary is generated', status: 'optional', options: [], links: [], note: 'Items in your itinerary marked "booking required" appear here.' });

  // ---- extras (no links: these depend on the traveller's own documents and cover)
  items.push({ key: 'extra:insurance', section: 'extras', title: 'Travel insurance', subtitle: 'Check what your bank card or existing policy already covers', status: 'optional', options: [], links: [], note: 'Cancellation cover is worth considering for non-refundable fares.' });
  items.push({ key: 'extra:documents', section: 'extras', title: 'Passport, visa & entry rules', subtitle: stops.map((s) => s.place.countryCode).filter(Boolean).join(', '), status: 'optional', options: [], links: [], note: "Check entry requirements on your government's official travel advice site before booking." });
  items.push({ key: 'extra:data', section: 'extras', title: 'Mobile data abroad', subtitle: 'Roaming or a local/eSIM plan', status: 'optional', options: [], links: [], note: 'Check your current plan\'s roaming rules for these countries.' });

  const priced = items.flatMap((i) => i.status === 'booked' ? [] : [i.options.find((o) => o.role === 'recommended') ?? i.options[0]].filter(Boolean)) as BookOption[];
  const cheapest = items.flatMap((i) => i.status === 'booked' ? [] : [i.options.find((o) => o.role === 'cheapest') ?? i.options[0]].filter(Boolean)) as BookOption[];
  const sum = (xs: BookOption[]) => xs.filter((o) => o.price && o.price.currency === trip.currency).reduce((s, o) => s + o.price!.amount, 0);
  return {
    trip: { id: trip.id, title: trip.title, currency: trip.currency, budgetTotal: trip.budgetTotal },
    items,
    totals: { recommended: Math.round(sum(priced)), cheapest: Math.round(sum(cheapest)), currency: trip.currency, note: 'Flights + stays with live prices only; car rental, transport and tickets are extra.' },
    counts: { toBook: items.filter((i) => i.status === 'to_book' || i.status === 'search_needed').length, booked: items.filter((i) => i.status === 'booked').length },
  };
}
