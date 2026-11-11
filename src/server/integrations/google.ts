// Google Places API (New), Routes API, OAuth 2.0 (sign-in + Gmail) and Gmail API.
import { NotConfiguredError, ProviderError, requestJson } from './http.ts';
import type { PlaceResult, PlacesProvider, RoutesProvider } from './types.ts';
import type { EmailMessage } from '../domain/emailExtract.ts';

const PLACE_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location', 'places.googleMapsUri', 'places.websiteUri',
  'places.regularOpeningHours', 'places.priceLevel', 'places.priceRange', 'places.rating', 'places.servesVegetarianFood',
  'places.servesBreakfast', 'places.servesLunch', 'places.servesDinner', 'places.reservable', 'places.editorialSummary',
  'places.types', 'places.businessStatus', 'places.attributions',
].join(',');

export class GooglePlaces implements PlacesProvider {
  name = 'google_places';
  private key?: string;
  constructor(key?: string) { this.key = key; }
  configured() { return !!this.key; }
  async textSearch(query: string, opts: { near?: { lat: number; lng: number; radiusM: number }; includedType?: string; max?: number; language?: string; userId?: string | null }): Promise<PlaceResult[]> {
    if (!this.key) throw new NotConfiguredError('Google Places', ['GOOGLE_MAPS_API_KEY']);
    const body: Record<string, unknown> = { textQuery: query, pageSize: Math.min(opts.max ?? 10, 20), languageCode: opts.language ?? 'en' };
    if (opts.near) body.locationBias = { circle: { center: { latitude: opts.near.lat, longitude: opts.near.lng }, radius: Math.min(opts.near.radiusM, 50000) } };
    if (opts.includedType) body.includedType = opts.includedType;
    const r = await requestJson<{ places?: any[] }>('https://places.googleapis.com/v1/places:searchText', {
      provider: 'google_places', operation: 'places.searchText', method: 'POST', idempotent: true, retries: 2, userId: opts.userId,
      headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': PLACE_FIELDS }, body,
    });
    return (r.places ?? []).map(normalisePlace);
  }
}

export function normalisePlace(p: any): PlaceResult {
  return {
    placeId: p.id, name: p.displayName?.text ?? '', address: p.formattedAddress ?? '', lat: p.location?.latitude, lng: p.location?.longitude,
    mapsUrl: p.googleMapsUri ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.displayName?.text ?? '')}&query_place_id=${p.id}`,
    website: p.websiteUri ?? null, weekdayDescriptions: p.regularOpeningHours?.weekdayDescriptions ?? null,
    priceLevel: p.priceLevel ?? null, priceRange: p.priceRange ?? null, rating: p.rating ?? null,
    servesVegetarianFood: p.servesVegetarianFood ?? null, servesBreakfast: p.servesBreakfast ?? null, servesLunch: p.servesLunch ?? null, servesDinner: p.servesDinner ?? null,
    reservable: p.reservable ?? null, summary: p.editorialSummary?.text ?? null, types: p.types ?? [], businessStatus: p.businessStatus ?? null,
    attributions: (p.attributions ?? []).map((a: any) => a.provider).filter(Boolean),
  };
}

export class GoogleRoutes implements RoutesProvider {
  name = 'google_routes';
  private key?: string;
  constructor(key?: string) { this.key = key; }
  configured() { return !!this.key; }
  async travelMinutes(from: { lat: number; lng: number }, to: { lat: number; lng: number }, departAt: Date, mode: 'DRIVE' | 'TRANSIT') {
    if (!this.key) throw new NotConfiguredError('Google Routes', ['GOOGLE_MAPS_API_KEY']);
    const body: Record<string, unknown> = {
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: mode, departureTime: departAt.toISOString(),
    };
    if (mode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE';
    const r = await requestJson<{ routes?: { duration?: string }[] }>('https://routes.googleapis.com/directions/v2:computeRoutes', {
      provider: 'google_routes', operation: 'computeRoutes', method: 'POST', idempotent: true,
      headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration' }, body,
    });
    const d = r.routes?.[0]?.duration;
    if (!d) throw new ProviderError('google_routes', 'No route found', 200, false);
    return { minutes: Math.ceil(Number(d.replace('s', '')) / 60), source: mode === 'DRIVE' ? 'live_traffic' as const : 'schedule' as const };
  }
}

// ---- OAuth 2.0 (authorization code + PKCE) ------------------------------------------------------
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export class GoogleOAuth {
  private clientId?: string; private clientSecret?: string;
  constructor(clientId?: string, clientSecret?: string) { this.clientId = clientId; this.clientSecret = clientSecret; }
  configured() { return !!this.clientId && !!this.clientSecret; }
  authUrl(p: { redirectUri: string; scope: string; state: string; codeChallenge: string; offline: boolean; loginHint?: string }) {
    if (!this.configured()) throw new NotConfiguredError('Google OAuth', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    const q = new URLSearchParams({
      client_id: this.clientId!, redirect_uri: p.redirectUri, response_type: 'code', scope: p.scope, state: p.state,
      code_challenge: p.codeChallenge, code_challenge_method: 'S256', include_granted_scopes: 'false',
    });
    if (p.offline) { q.set('access_type', 'offline'); q.set('prompt', 'consent'); }
    if (p.loginHint) q.set('login_hint', p.loginHint);
    return `${GOOGLE_AUTH_URL}?${q}`;
  }
  async exchange(code: string, redirectUri: string, codeVerifier: string) {
    return requestJson<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope: string }>(GOOGLE_TOKEN_URL, {
      provider: 'google_oauth', operation: 'token.exchange', method: 'POST',
      body: new URLSearchParams({ code, client_id: this.clientId!, client_secret: this.clientSecret!, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
  async refresh(refreshToken: string) {
    return requestJson<{ access_token: string; expires_in: number; scope: string }>(GOOGLE_TOKEN_URL, {
      provider: 'google_oauth', operation: 'token.refresh', method: 'POST', idempotent: true,
      body: new URLSearchParams({ client_id: this.clientId!, client_secret: this.clientSecret!, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
  async revoke(token: string) {
    await requestJson('https://oauth2.googleapis.com/revoke', { provider: 'google_oauth', operation: 'token.revoke', method: 'POST', body: new URLSearchParams({ token }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, idempotent: true });
  }
  /** Validates the ID token via Google's userinfo using the access token (avoids local JWKS handling). */
  async userInfo(accessToken: string) {
    return requestJson<{ sub: string; email: string; email_verified: boolean; name?: string }>('https://openidconnect.googleapis.com/v1/userinfo', {
      provider: 'google_oauth', operation: 'userinfo', headers: { Authorization: `Bearer ${accessToken}` },
    });
  }
}

// ---- Gmail ----------------------------------------------------------------------------------------
export class GmailClient {
  private token: string;
  constructor(accessToken: string) { this.token = accessToken; }
  private h() { return { Authorization: `Bearer ${this.token}` }; }
  async profileEmail(): Promise<string> {
    const r = await requestJson<{ emailAddress: string }>('https://gmail.googleapis.com/gmail/v1/users/me/profile', { provider: 'gmail', operation: 'profile', headers: this.h() });
    return r.emailAddress;
  }
  async listIds(q: string, max = 100): Promise<string[]> {
    const ids: string[] = []; let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
      if (pageToken) qs.set('pageToken', pageToken);
      const r = await requestJson<{ messages?: { id: string }[]; nextPageToken?: string }>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${qs}`, { provider: 'gmail', operation: 'messages.list', headers: this.h() });
      ids.push(...(r.messages ?? []).map((m) => m.id));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids;
  }
  async get(id: string): Promise<EmailMessage> {
    const r = await requestJson<any>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, { provider: 'gmail', operation: 'messages.get', headers: this.h() });
    return parseGmailMessage(r);
  }
}

export function parseGmailMessage(r: any): EmailMessage {
  const headers: { name: string; value: string }[] = r.payload?.headers ?? [];
  const hv = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';
  const texts: string[] = []; const htmls: string[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data) {
      const s = Buffer.from(p.body.data, 'base64url').toString('utf8');
      if (p.mimeType === 'text/plain') texts.push(s); else if (p.mimeType === 'text/html') htmls.push(s);
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(r.payload);
  const text = texts.length ? texts.join('\n') : htmls.join('\n').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
  return { id: r.id, from: hv('from'), subject: hv('subject'), date: r.internalDate ? new Date(Number(r.internalDate)).toISOString() : hv('date'), text: text.slice(0, 50000) };
}
