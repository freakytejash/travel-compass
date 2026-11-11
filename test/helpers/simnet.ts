// Simulated network for the free provider stack (Nager.Date, Photon, SerpApi flights/hotels/explore, Brevo).
// Documented response shapes only; used by integration tests and the local browser check (test/e2e/serve-sim.ts).
import type { Airport } from '../../src/server/integrations/freegeo.ts';
import type { Place } from '../../src/shared/types.ts';

export const sim = { serpStatus: 200 };
export const AIRPORTS: Airport[] = [
  { iata: 'BRU', name: 'Brussels Airport', city: 'Brussels', country: 'BE', lat: 50.901, lng: 4.484, size: 'large' },
  { iata: 'CRL', name: 'Brussels South Charleroi Airport', city: 'Charleroi', country: 'BE', lat: 50.459, lng: 4.453, size: 'medium' },
  { iata: 'LIS', name: 'Humberto Delgado Airport', city: 'Lisbon', country: 'PT', lat: 38.774, lng: -9.134, size: 'large' },
  { iata: 'BCN', name: 'Barcelona El Prat', city: 'Barcelona', country: 'ES', lat: 41.297, lng: 2.083, size: 'large' },
];
export const tzLookup = async (lat: number) => (lat < 40 ? 'Europe/Lisbon' : lat < 45 ? 'Europe/Madrid' : 'Europe/Brussels');
export const BRUSSELS: Place = { name: 'Brussels', kind: 'city', lat: 50.8466, lng: 4.3528, countryCode: 'BE', timeZone: 'Europe/Brussels', iata: 'BRU', cityName: 'Brussels', airports: [{ iata: 'BRU', name: 'Brussels Airport', lat: 50.901, lng: 4.484 }], source: 'photon' };

export const calls: { engine: string; q: URLSearchParams }[] = [];
export let nagerCalls = 0;
export const brevoSent: any[] = [];
const seg = (from: string, to: string, d: string, a: string, fn: string, airline: string, dur: number) => ({ departure_airport: { id: from, time: d }, arrival_airport: { id: to, time: a }, duration: dur, airline, flight_number: fn, extensions: [] });

export function net(): typeof fetch {
  return (async function (input: any) {
    const url = new URL(String(input));
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'api.brevo.com') { brevoSent.push(JSON.parse(String((arguments as any)[1]?.body))); return j({ messageId: '<m@brevo>' }, 201); }
    if (url.hostname === 'serpapi.com' && url.pathname === '/account.json') return j({ plan_name: 'Free Plan', total_searches_left: 231 });
    if (url.hostname === 'serpapi.com' && sim.serpStatus !== 200) return j({ error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' }, sim.serpStatus);
    if (url.hostname === 'date.nager.at') {
      nagerCalls++;
      if (url.pathname.endsWith('/PublicHolidays/2027/BE')) return j([
        { date: '2027-03-29', name: 'Easter Monday', localName: 'Paasmaandag', countryCode: 'BE', global: true },
        { date: '2027-05-06', name: 'Ascension Day', localName: 'O.L.H. Hemelvaart', countryCode: 'BE', global: true },
      ]);
      if (url.pathname.endsWith('/LongWeekend/2027/BE')) return j([
        { startDate: '2027-03-27', endDate: '2027-03-29', dayCount: 3, needBridgeDay: false },
        { startDate: '2027-05-06', endDate: '2027-05-09', dayCount: 4, needBridgeDay: true },
      ]);
      return new Response('', { status: 404 });
    }
    if (url.hostname === 'photon.example') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const f = (name: string, lng: number, lat: number, cc: string, country: string) => ({ geometry: { coordinates: [lng, lat] }, properties: { name, osm_key: 'place', osm_value: 'city', countrycode: cc, country } });
      return j({ features: q.startsWith('lis') ? [f('Lisbon', -9.1393, 38.7223, 'PT', 'Portugal')] : q.startsWith('bar') ? [f('Barcelona', 2.1686, 41.3874, 'ES', 'Spain')] : q.startsWith('bru') ? [f('Brussels', 4.3528, 50.8466, 'BE', 'Belgium')] : [] });
    }
    if (url.hostname === 'serpapi.com') {
      const q = url.searchParams; const engine = q.get('engine')!;
      calls.push({ engine, q });
      if (engine === 'google_travel_explore') return j({ search_metadata: { google_travel_explore_url: 'https://www.google.com/travel/explore?tfs=x' }, destinations: [
        { name: 'Lisbon', country: 'Portugal', destination_airport: { code: 'LIS' }, gps_coordinates: { latitude: 38.7223, longitude: -9.1393 }, flight_price: 89, hotel_price: 58, start_date: q.get('outbound_date'), end_date: q.get('return_date'), flight_duration: 165, number_of_stops: 0, airline: 'Ryanair', thumbnail: 'https://img.example/lis.jpg', link: 'https://www.google.com/travel/explore?d=LIS' },
        { name: 'Barcelona', country: 'Spain', destination_airport: { code: 'BCN' }, gps_coordinates: { latitude: 41.3874, longitude: 2.1686 }, flight_price: 140, hotel_price: 95, flight_duration: 125, number_of_stops: 0, airline: 'Vueling' },
        { name: 'Brussels', country: 'Belgium', destination_airport: { code: 'BRU' }, flight_price: 1 },
        { name: 'Unpriced', country: 'X', destination_airport: { code: 'UNP' } },
      ] });
      if (engine === 'google_hotels') return j({ search_metadata: { google_hotels_url: 'https://www.google.com/travel/hotels/Lisbon' }, properties: [
        { name: 'Lisbon Central Hostel', type: 'hotel', link: 'https://hostel.example', gps_coordinates: { latitude: 38.715, longitude: -9.14 }, total_rate: { extracted_lowest: 96 }, overall_rating: 4.5, property_token: 'h1' },
        { name: 'Hotel Baixa', type: 'hotel', link: 'https://baixa.example', gps_coordinates: { latitude: 38.711, longitude: -9.137 }, total_rate: { extracted_lowest: 210 }, overall_rating: 4.7, extracted_hotel_class: 4, property_token: 'h2', amenities: ['Free cancellation'] },
      ] });
      if (engine === 'google_flights') {
        const tok = q.get('departure_token');
        if (tok) return j({ best_flights: [{ flights: [tok === 'crl' ? seg('LIS', 'CRL', '2027-03-29 18:00', '2027-03-29 21:45', 'FR 7311', 'Ryanair', 165) : seg('LIS', 'BRU', '2027-03-29 17:00', '2027-03-29 20:45', 'TP 1209', 'TAP', 165)], total_duration: 165, price: tok === 'crl' ? 89 : 260, booking_token: `b_${tok}` }] });
        return j({ search_metadata: { id: 'f1', google_flights_url: 'https://www.google.com/travel/flights?tfs=lis' },
          best_flights: [{ flights: [seg('BRU', 'LIS', '2027-03-27 10:00', '2027-03-27 11:45', 'TP 1204', 'TAP', 165)], total_duration: 165, price: 260, departure_token: 'bru' }],
          other_flights: [{ flights: [seg('CRL', 'LIS', '2027-03-27 07:00', '2027-03-27 08:45', 'FR 7310', 'Ryanair', 165)], total_duration: 165, price: 89, departure_token: 'crl' }] });
      }
    }
    return new Response('unexpected ' + url, { status: 599 });
  }) as typeof fetch;
}

