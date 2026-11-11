// Types shared by the server and the web client. Erasable TypeScript only.

export type Money = { amount: number; currency: string };

export interface Place {
  name: string;
  kind: 'city' | 'airport' | 'region' | 'country' | 'point';
  lat: number;
  lng: number;
  countryCode?: string;
  timeZone?: string;
  iata?: string;
  cityName?: string;
  airports?: { iata: string; name: string; lat: number; lng: number; timeZone?: string }[];
  source: string; // provider that resolved this place
}

export interface FlightSegment {
  carrierCode: string;
  carrierName: string;
  flightNumber: string;
  from: string; // IATA
  to: string;
  departLocal: string; // 'YYYY-MM-DDTHH:mm:ss' local to `from`
  arriveLocal: string;
  departTz: string;
  arriveTz: string;
  departUtc: string; // ISO
  arriveUtc: string;
}

export interface FlightSlice {
  from: string;
  to: string;
  durationMinutes: number;
  segments: FlightSegment[];
  layovers: { airport: string; minutes: number; overnight: boolean }[];
}

export interface FlightOffer {
  provider: string;
  providerOfferId: string;
  owner: string;
  slices: FlightSlice[];
  total: Money;
  tax?: Money;
  baggage: { checkedBags: number; carryOn: number; source: 'provider' | 'unknown' };
  conditions: {
    refundable: boolean | null;
    refundPenalty?: Money | null;
    changeable: boolean | null;
    changePenalty?: Money | null;
  };
  quotedAt: string;
  expiresAt: string | null;
  priceGuaranteeExpiresAt?: string | null;
  requiresInstantPayment?: boolean | null;
  /** Provider-specific references needed for repricing/handoff (never secrets). */
  providerData?: { bookingToken?: string; searchUrl?: string; priceNote?: string };
  /** Set when the offer is price-level only (e.g. return leg not yet expanded). */
  incomplete?: string;
}

export interface StayOption {
  provider: string;
  providerOfferId: string; // rate/search result id
  propertyName: string;
  address: string;
  lat: number;
  lng: number;
  checkIn: string; // date
  checkOut: string;
  nights: number;
  roomType: string;
  roomKind: 'private' | 'dorm' | 'unknown';
  occupancy: number;
  total: Money; // all-in total as charged/payable for the stay
  taxesAndFees: Money | null;
  dueAtProperty: Money | null;
  cancellation: { freeUntil: string | null; refundable: boolean | null; summary: string };
  payment: string;
  rating: number | null; // stars
  reviewScore: number | null; // 0-10
  link: string | null;
  quotedAt: string;
  expiresAt: string | null;
}

export interface SourceRef {
  url: string;
  title: string;
  provider: string;
  retrievedAt: string;
}

export interface Venue {
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUrl: string;
  website?: string | null;
  openingHours?: string[] | null; // human readable weekday descriptions from source
  price?: { text: string; provenance: 'source' | 'estimate'; sourceUrl?: string } | null;
  dishes?: { name: string; dietStatus: DietStatus; note: string }[];
  placeId?: string;
}

export type DietStatus = 'confirmed' | 'likely' | 'uncertain' | 'not_suitable';

export type ItemKind = 'wake' | 'breakfast' | 'transfer' | 'activity' | 'hike' | 'lunch' | 'break' | 'dinner' | 'checkin' | 'checkout' | 'flight' | 'travel';

export interface ItineraryItem {
  id?: string;
  kind: ItemKind;
  startLocal: string;
  endLocal: string;
  title: string;
  venue: Venue | null;
  why: string;
  bookingRequired: 'yes' | 'no' | 'recommended' | 'unknown';
  uncertainty: string;
  sources: SourceRef[];
  retrievedAt: string | null;
  locked?: boolean;
}

export type Pace = 'relaxed' | 'moderate' | 'packed';
export type Diet = 'none' | 'vegetarian' | 'vegan' | 'pescatarian';

export type IntegrationStatus = 'configured' | 'awaiting_credentials' | 'disabled';

export interface ApiError { error: { code: string; message: string; retryable?: boolean; details?: unknown } }
