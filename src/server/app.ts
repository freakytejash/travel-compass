import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from './context.ts';
import { errorResponse, HttpError, parseCookies, readBody, Router, securityHeaders, sendJson, serveStatic, type Ctx, type RouteOpts } from './http/core.ts';
import { placeSchema, v } from './http/validate.ts';
import { rateLimit } from './http/guards.ts';
import { timingSafeEqualStr } from './secrets.ts';
import { log } from './log.ts';
import * as auth from './services/auth.ts';
import * as profile from './services/profile.ts';
import * as trips from './services/trips.ts';
import * as searches from './services/searches.ts';
import * as planning from './services/planning.ts';
import * as booking from './services/booking.ts';
import * as reservations from './services/reservations.ts';
import * as notifications from './services/notifications.ts';
import * as admin from './services/admin.ts';
import * as ideas from './services/ideas.ts';
import { bookingPlan } from './services/bookAll.ts';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const ITEM_KINDS = ['wake', 'breakfast', 'transfer', 'activity', 'hike', 'lunch', 'break', 'dinner', 'checkin', 'checkout', 'flight', 'travel'] as const;

const stopSchema = v.object({ place: placeSchema, arriveDate: v.date(), departDate: v.date() });
const tripSchema = v.object({
  title: v.optional(v.string({ min: 1, max: 120 })),
  origin: v.optional(v.nullable(placeSchema)),
  adults: v.optional(v.number({ int: true, min: 1, max: 9 })),
  startDate: v.optional(v.nullable(v.date())),
  endDate: v.optional(v.nullable(v.date())),
  flexDays: v.optional(v.number({ int: true, min: 0, max: 3 })),
  budgetTotal: v.optional(v.nullable(v.number({ min: 0, max: 1_000_000 }))),
  currency: v.optional(v.string({ pattern: /^[A-Z]{3}$/ })),
  status: v.optional(v.enum(['draft', 'planned', 'booked', 'completed', 'cancelled'] as const)),
  stops: v.optional(v.array(stopSchema, { max: 12 })),
});
const profileSchema = v.object({
  displayName: v.optional(v.string({ max: 80 })),
  homePlace: v.optional(v.nullable(placeSchema)),
  departureAirports: v.optional(v.array(v.object({ iata: v.string({ pattern: /^[A-Z]{3}$/ }), name: v.string({ max: 200 }), cityName: v.optional(v.string({ max: 200 })) }), { max: 5 })),
  timeZone: v.optional(v.string({ max: 64 })),
  currency: v.optional(v.string({ pattern: /^[A-Z]{3}$/ })),
  contactEmailOptIn: v.optional(v.bool()),
  diet: v.optional(v.enum(['none', 'vegetarian', 'vegan', 'pescatarian'] as const)),
  allergies: v.optional(v.array(v.string({ max: 60 }), { max: 20 })),
  dietaryNotes: v.optional(v.string({ max: 500 })),
  budgetTotal: v.optional(v.nullable(v.number({ min: 0, max: 1_000_000 }))),
  pace: v.optional(v.enum(['relaxed', 'moderate', 'packed'] as const)),
  interests: v.optional(v.array(v.string({ max: 40 }), { max: 15 })),
  hikingExperience: v.optional(v.enum(['none', 'beginner', 'intermediate', 'experienced'] as const)),
  hikingDifficulty: v.optional(v.enum(['easy', 'moderate', 'hard'] as const)),
  accommodationPref: v.optional(v.enum(['any', 'private', 'dorm'] as const)),
  checkedBag: v.optional(v.bool()),
  wakeTime: v.optional(v.time()),
  prepMinutes: v.optional(v.number({ int: true, min: 0, max: 240 })),
  onboardingComplete: v.optional(v.bool()),
});

export function createApp(ctx: AppContext) {
  const r = new Router();
  const cfg = ctx.cfg;

  // ---------- health ----------
  r.get('/api/health', () => ({ ok: true }), { auth: 'none', rate: 'none' });
  r.get('/api/ready', async (c) => { const h = await admin.health(ctx); if (!h.database) c.res.statusCode = 503; return { ok: h.database }; }, { auth: 'none', rate: 'none' });

  // ---------- session & auth ----------
  r.get('/api/session', (c) => ({ user: c.user, csrfToken: c.session?.csrfToken ?? null, googleLogin: auth.googleOAuth(ctx).configured() }), { auth: 'none', rate: 'none' });
  r.post('/api/auth/register', async (c) => {
    const b = v.object({ email: v.email(), password: v.string({ trim: false, max: 200 }), displayName: v.string({ min: 1, max: 80 }) }).parse(c.body);
    await auth.register(ctx, b);
    return { ok: true, message: cfg.email.logOnly && !cfg.email.resendApiKey && !cfg.email.brevoApiKey ? 'Account created. Email is in log-only mode, so no email is sent: the verification link is in the server log (Render → Logs, search verify-email). Add BREVO_API_KEY to send real emails.' : 'Check your inbox for a verification link.' };
  }, { auth: 'none', rate: 'auth' });
  r.post('/api/auth/resend-verification', async (c) => { await auth.resendVerification(ctx, v.object({ email: v.email() }).parse(c.body).email); return { ok: true }; }, { auth: 'none', rate: 'auth' });
  r.post('/api/auth/verify-email', async (c) => {
    const userId = await auth.verifyEmail(ctx, v.object({ token: v.string({ max: 200 }) }).parse(c.body).token);
    await startSession(c, userId);
    return { ok: true };
  }, { auth: 'none', rate: 'auth' });
  r.post('/api/auth/login', async (c) => {
    const b = v.object({ email: v.email(), password: v.string({ trim: false, max: 200 }) }).parse(c.body);
    const userId = await auth.login(ctx, b.email, b.password);
    await startSession(c, userId);
    return { ok: true };
  }, { auth: 'none', rate: 'auth' });
  r.post('/api/auth/logout', async (c) => { if (c.session) await auth.destroySession(ctx, c.session.id); c.setCookie(auth.SESSION_COOKIE, '', { maxAgeSec: 0 }); return { ok: true }; }, { auth: 'user' });
  r.post('/api/auth/forgot-password', async (c) => { await auth.requestPasswordReset(ctx, v.object({ email: v.email() }).parse(c.body).email); return { ok: true, message: 'If an account exists, a reset link has been sent.' }; }, { auth: 'none', rate: 'auth' });
  r.post('/api/auth/reset-password', async (c) => { const b = v.object({ token: v.string({ max: 200 }), password: v.string({ trim: false, max: 200 }) }).parse(c.body); await auth.resetPassword(ctx, b.token, b.password); return { ok: true }; }, { auth: 'none', rate: 'auth' });
  r.get('/api/auth/google/start', async (c) => redirect(c, await auth.startOAuth(ctx, 'google_login', null, 'openid email profile')), { auth: 'none', rate: 'auth' });
  r.get('/api/oauth/google/callback', async (c) => {
    const code = c.url.searchParams.get('code'); const state = c.url.searchParams.get('state');
    if (!code || !state) return redirect(c, '/login?error=oauth_cancelled');
    const st = await auth.consumeOAuthState(ctx, state);
    if (st.purpose === 'google_login') {
      const userId = await auth.googleLogin(ctx, code, st.code_verifier);
      await startSession(c, userId);
      return redirect(c, '/');
    }
    if (!c.user || c.user.id !== st.user_id) return redirect(c, '/account?gmail=session_mismatch');
    await reservations.gmailCallback(ctx, c.user.id, code, st.code_verifier);
    return redirect(c, '/bookings?gmail=connected');
  }, { auth: 'none', rate: 'auth' });

  async function startSession(c: Ctx, userId: string) {
    if (c.session) await auth.destroySession(ctx, c.session.id); // rotate on privilege change
    const s = await auth.createSession(ctx, userId, c.req.headers['user-agent']);
    c.setCookie(auth.SESSION_COOKIE, s.token, { maxAgeSec: s.maxAgeSec });
  }

  // ---------- profile & account ----------
  r.get('/api/profile', async (c) => ({ ...(await profile.getProfile(ctx, c.user!.id)), displayName: c.user!.displayName, email: c.user!.email }), { auth: 'user' });
  r.put('/api/profile', async (c) => profile.updateProfile(ctx, c.user!.id, profileSchema.parse(c.body)), { auth: 'user' });
  r.post('/api/account/password', async (c) => { const b = v.object({ current: v.string({ trim: false, max: 200 }), next: v.string({ trim: false, max: 200 }) }).parse(c.body); await auth.changePassword(ctx, c.user!.id, b.current, b.next, c.session!.id); return { ok: true }; }, { auth: 'user', rate: 'auth' });
  r.get('/api/account/export', async (c) => { c.res.setHeader('Content-Disposition', 'attachment; filename="travel-compass-export.json"'); return auth.exportAccount(ctx, c.user!.id); }, { auth: 'user', rate: 'expensive' });
  r.post('/api/account/delete', async (c) => {
    const b = v.object({ confirm: v.string({ max: 20 }) }).parse(c.body);
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'confirmation_required', 'Type DELETE to confirm.');
    await auth.deleteAccount(ctx, c.user!.id);
    c.setCookie(auth.SESSION_COOKIE, '', { maxAgeSec: 0 });
    return { ok: true };
  }, { auth: 'user', rate: 'auth' });
  r.get('/api/places', async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').slice(0, 80);
    const lat = Number(c.url.searchParams.get('lat')); const lng = Number(c.url.searchParams.get('lng'));
    return profile.searchPlaces(ctx, q, Number.isFinite(lat) && Number.isFinite(lng) && c.url.searchParams.has('lat') ? { lat, lng } : undefined);
  }, { auth: 'none' }); // public: free place search, rate-limited per IP

  // ---------- public dashboard data (no paid searches) ----------
  r.get('/api/public/windows', async (c) => {
    const country = v.string({ pattern: /^[A-Za-z]{2}$/ }).parse(c.url.searchParams.get('country') ?? '');
    const months = Math.min(12, Math.max(1, Number(c.url.searchParams.get('months') ?? 6) || 6));
    return ideas.windowsFor(ctx, country, months);
  }, { auth: 'none' });

  // ---------- trip ideas ----------
  r.post('/api/ideas', async (c) => {
    const b = v.object({ origin: placeSchema, country: v.optional(v.string({ pattern: /^[A-Za-z]{2}$/ })), months: v.optional(v.number({ int: true, min: 1, max: 12 })), adults: v.optional(v.number({ int: true, min: 1, max: 9 })),
      budget: v.optional(v.nullable(v.number({ min: 0, max: 1_000_000 }))), currency: v.optional(v.string({ pattern: /^[A-Z]{3}$/ })), windowIds: v.optional(v.array(v.string({ pattern: /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/ }), { max: 3 })) }).parse(c.body);
    const prof = await profile.getProfile(ctx, c.user!.id);
    return { ideaId: await ideas.startIdeas(ctx, c.user!.id, { origin: b.origin, country: b.country, months: b.months ?? 6, adults: b.adults ?? 1, budget: b.budget ?? prof.budgetTotal ?? null, currency: b.currency ?? prof.currency ?? 'EUR', windowIds: b.windowIds }) };
  }, { auth: 'user', rate: 'expensive' });
  r.get('/api/ideas/latest', async (c) => ideas.latestIdeas(ctx, c.user!.id), { auth: 'user' });
  r.get('/api/ideas/:id', async (c) => ideas.getIdeas(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user' });
  r.post('/api/ideas/:id/choose', async (c) => ideas.chooseIdea(ctx, c.user!.id, v.uuid().parse(c.params.id), v.object({ index: v.number({ int: true, min: 0, max: 50 }) }).parse(c.body).index), { auth: 'user', rate: 'expensive' });

  // ---------- trips ----------
  r.get('/api/trips', async (c) => trips.listTrips(ctx, c.user!.id), { auth: 'user' });
  r.post('/api/trips', async (c) => trips.createTrip(ctx, c.user!.id, tripSchema.parse(c.body)), { auth: 'user' });
  r.get('/api/trips/:id', async (c) => trips.getTripDetail(ctx, c.user!.id, c.params.id), { auth: 'user' });
  r.patch('/api/trips/:id', async (c) => {
    const b = v.object({ version: v.number({ int: true, min: 1 }), changes: tripSchema }).parse(c.body);
    return trips.updateTrip(ctx, c.user!.id, c.params.id, b.version, b.changes);
  }, { auth: 'user' });
  r.delete('/api/trips/:id', async (c) => { await trips.deleteTrip(ctx, c.user!.id, c.params.id); return { ok: true }; }, { auth: 'user' });
  r.post('/api/trips/:id/searches', async (c) => {
    const b = v.object({ kind: v.enum(['flight', 'stay', 'flex', 'destinations'] as const) }).parse(c.body);
    return { searchId: await searches.startSearch(ctx, c.user!.id, c.params.id, b.kind) };
  }, { auth: 'user', rate: 'expensive' });
  r.get('/api/trips/:id/searches', async (c) => {
    await trips.getOwnedTrip(ctx, c.user!.id, c.params.id);
    const rows = await ctx.db.query<any>(`SELECT DISTINCT ON (kind) id, kind, status, created_at FROM searches WHERE trip_id=$1 ORDER BY kind, created_at DESC`, [c.params.id]);
    return rows.rows;
  }, { auth: 'user' });
  r.get('/api/searches/:id', async (c) => searches.getSearch(ctx, c.user!.id, c.params.id), { auth: 'user' });
  r.post('/api/trips/:id/plan', async (c) => {
    const b = v.object({ date: v.optional(v.date()), excludePlaceIds: v.optional(v.array(v.string({ max: 300 }), { max: 50 })) }).parse(c.body ?? {});
    return planning.requestPlan(ctx, c.user!.id, c.params.id, b);
  }, { auth: 'user', rate: 'expensive' });
  r.post('/api/trips/:id/days/:date/reschedule', async (c) => {
    const b = v.object({ pace: v.optional(v.enum(['relaxed', 'moderate', 'packed'] as const)), removeItemId: v.optional(v.uuid()), expectedVersion: v.optional(v.number({ int: true })) }).parse(c.body);
    await trips.getOwnedTrip(ctx, c.user!.id, c.params.id);
    return planning.rescheduleDay(ctx, c.user!.id, c.params.id, v.date().parse(c.params.date), b);
  }, { auth: 'user' });
  r.post('/api/trips/:id/items/:itemId/move', async (c) => planning.moveItem(ctx, c.user!.id, c.params.id, v.uuid().parse(c.params.itemId), v.object({ toDate: v.date() }).parse(c.body).toDate), { auth: 'user' });
  r.post('/api/trips/:id/items/:itemId/replace', async (c) => {
    await trips.getOwnedTrip(ctx, c.user!.id, c.params.id);
    const it = await ctx.db.query<any>(`SELECT i.venue, d.day_date FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id WHERE i.id=$1 AND d.trip_id=$2`, [v.uuid().parse(c.params.itemId), c.params.id]);
    if (!it.rows.length) throw new HttpError(404, 'not_found', 'Item not found');
    return planning.requestPlan(ctx, c.user!.id, c.params.id, { date: it.rows[0].day_date, excludePlaceIds: it.rows[0].venue?.placeId ? [it.rows[0].venue.placeId] : [] });
  }, { auth: 'user', rate: 'expensive' });
  r.get('/api/trips/:id/book', async (c) => bookingPlan(ctx, c.user!.id, c.params.id), { auth: 'user' });
  r.get('/api/trips/:id/notifications', async (c) => { await trips.getOwnedTrip(ctx, c.user!.id, c.params.id); return notifications.listNotifications(ctx, c.user!.id, c.params.id); }, { auth: 'user' });

  // ---------- booking ----------
  r.post('/api/offers/:id/select', async (c) => booking.selectOffer(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user' });
  r.get('/api/booking-sessions/:id', async (c) => booking.getBookingSession(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user' });
  r.post('/api/booking-sessions/:id/reprice', async (c) => booking.reprice(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user', rate: 'expensive' });
  r.post('/api/booking-sessions/:id/travellers', async (c) => {
    const b = v.object({ travellers: v.array(v.object({ title: v.enum(['mr', 'ms', 'mrs', 'miss', 'dr'] as const), givenName: v.string({ min: 1, max: 60 }), familyName: v.string({ min: 1, max: 60 }), bornOn: v.date(), gender: v.enum(['m', 'f', 'x'] as const), email: v.email(), phone: v.string({ pattern: /^\+[1-9]\d{7,14}$/ }) }), { min: 1, max: 9 }) }).parse(c.body);
    return booking.saveTravellerDetails(ctx, c.user!.id, v.uuid().parse(c.params.id), b.travellers);
  }, { auth: 'user' });
  r.post('/api/booking-sessions/:id/handoff', async (c) => booking.acknowledgeAndHandoff(ctx, c.user!.id, v.uuid().parse(c.params.id), v.object({ acceptedAmount: v.number(), acceptedCurrency: v.string({ pattern: /^[A-Z]{3}$/ }), acceptConditions: v.bool() }).parse(c.body)), { auth: 'user' });
  r.post('/api/booking-sessions/:id/handed-off', async (c) => booking.markHandedOff(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user' });
  r.post('/api/booking-sessions/:id/complete', async (c) => { const b = v.object({ orderId: v.nullable(v.string({ max: 100 })), result: v.enum(['success', 'failure', 'abandoned'] as const) }).parse(c.body); return booking.completeFromProvider(ctx, c.user!.id, v.uuid().parse(c.params.id), b.orderId, b.result); }, { auth: 'user' });
  r.post('/api/booking-sessions/:id/cancel', async (c) => booking.cancelSession(ctx, c.user!.id, v.uuid().parse(c.params.id)), { auth: 'user' });

  // ---------- reservations & gmail ----------
  r.get('/api/reservations', async (c) => reservations.listReservations(ctx, c.user!.id), { auth: 'user' });
  r.post('/api/reservations', async (c) => {
    const b = v.object({ tripId: v.optional(v.nullable(v.uuid())), kind: v.enum(['flight', 'stay', 'activity', 'transport', 'other'] as const), providerName: v.string({ min: 1, max: 100 }), confirmationCode: v.optional(v.nullable(v.string({ max: 40 }))), startDate: v.optional(v.nullable(v.date())), endDate: v.optional(v.nullable(v.date())), notes: v.optional(v.string({ max: 1000 })) }).parse(c.body);
    if (b.tripId) await trips.getOwnedTrip(ctx, c.user!.id, b.tripId);
    const res = await reservations.upsertReservation(ctx, c.user!.id, { kind: b.kind, providerName: b.providerName, confirmationCode: b.confirmationCode ?? null, startDate: b.startDate ?? null, endDate: b.endDate ?? null, details: { notes: b.notes ?? '' }, confidence: 1, sourceRef: 'manual', evidence: [], source: 'manual', tripId: b.tripId ?? null });
    return res;
  }, { auth: 'user' });
  r.patch('/api/reservations/:id', async (c) => {
    const b = v.object({ tripId: v.optional(v.nullable(v.uuid())), confirmationCode: v.optional(v.nullable(v.string({ max: 40 }))), providerName: v.optional(v.string({ max: 100 })), startDate: v.optional(v.nullable(v.date())), endDate: v.optional(v.nullable(v.date())), reviewStatus: v.optional(v.enum(['needs_review', 'confirmed'] as const)), checkinStatus: v.optional(v.enum(['unknown', 'not_open', 'pending', 'customer_confirmed', 'not_applicable'] as const)) }).parse(c.body);
    return reservations.updateReservation(ctx, c.user!.id, v.uuid().parse(c.params.id), b);
  }, { auth: 'user' });
  r.delete('/api/reservations/:id', async (c) => { await reservations.deleteReservation(ctx, c.user!.id, v.uuid().parse(c.params.id)); return { ok: true }; }, { auth: 'user' });
  r.get('/api/gmail', async (c) => reservations.gmailStatus(ctx, c.user!.id), { auth: 'user' });
  r.post('/api/gmail/connect', async (c) => ({ url: await reservations.gmailConnectUrl(ctx, c.user!.id) }), { auth: 'user', rate: 'auth' });
  r.post('/api/gmail/sync', async (c) => { await ctx.jobs.enqueue('gmail.sync', { userId: c.user!.id }, { dedupeKey: `gmail-sync:${c.user!.id}:${ctx.now().toISOString().slice(0, 16)}` }); return { ok: true }; }, { auth: 'user', rate: 'expensive' });
  r.post('/api/gmail/disconnect', async (c) => reservations.gmailDisconnect(ctx, c.user!.id, v.object({ deleteImported: v.bool() }).parse(c.body).deleteImported), { auth: 'user' });

  // ---------- notifications ----------
  r.get('/api/notifications/channel', async (c) => notifications.getChannel(ctx, c.user!.id), { auth: 'user' });
  r.post('/api/notifications/phone', async (c) => { await notifications.startPhoneVerification(ctx, c.user!.id, v.object({ phone: v.string({ max: 20 }) }).parse(c.body).phone); return { ok: true }; }, { auth: 'user', rate: 'auth' });
  r.post('/api/notifications/phone/verify', async (c) => { await notifications.confirmPhone(ctx, c.user!.id, v.object({ code: v.string({ pattern: /^\d{6}$/ }) }).parse(c.body).code); return { ok: true }; }, { auth: 'user', rate: 'auth' });
  r.put('/api/notifications/consent', async (c) => {
    const b = v.object({ optIn: v.bool(), shareBookingRefs: v.optional(v.bool()), pretripBriefing: v.optional(v.bool()), dailySchedule: v.optional(v.bool()), dailyTime: v.optional(v.time()), pretripTime: v.optional(v.time()) }).parse(c.body);
    await notifications.updateConsent(ctx, c.user!.id, b);
    return notifications.getChannel(ctx, c.user!.id);
  }, { auth: 'user' });
  r.get('/api/notifications', async (c) => notifications.listNotifications(ctx, c.user!.id), { auth: 'user' });
  r.post('/api/notifications/telegram', async (c) => notifications.startTelegramLink(ctx, c.user!.id), { auth: 'user', rate: 'auth' });
  r.post('/api/notifications/callmebot', async (c) => { const b = v.object({ phone: v.string({ max: 20 }), apiKey: v.string({ max: 40 }) }).parse(c.body); await notifications.startCallMeBot(ctx, c.user!.id, b.phone, b.apiKey); return { ok: true }; }, { auth: 'user', rate: 'auth' });

  // ---------- webhooks (signature-verified, no session/CSRF) ----------
  r.get('/api/webhooks/whatsapp', (c) => {
    const q = c.url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && cfg.whatsapp.verifyToken && timingSafeEqualStr(q.get('hub.verify_token') ?? '', cfg.whatsapp.verifyToken)) {
      c.res.writeHead(200, { 'Content-Type': 'text/plain' }); c.res.end(q.get('hub.challenge') ?? ''); return undefined;
    }
    throw new HttpError(403, 'forbidden', 'Verification failed');
  }, { auth: 'none', raw: true, rate: 'none' });
  r.post('/api/webhooks/whatsapp', async (c) => {
    if (!ctx.providers.messenger.verifySignature(c.rawBody, c.req.headers['x-hub-signature-256'] as string | undefined)) throw new HttpError(401, 'invalid_signature', 'Invalid signature');
    return notifications.handleWhatsAppWebhook(ctx, JSON.parse(c.rawBody.toString('utf8')));
  }, { auth: 'none', raw: true, rate: 'none' });

  r.post('/api/webhooks/telegram', async (c) => {
    if (!ctx.providers.telegram?.verifyWebhook(c.req.headers['x-telegram-bot-api-secret-token'] as string | undefined)) throw new HttpError(401, 'invalid_signature', 'Invalid secret');
    const u = JSON.parse(c.rawBody.toString('utf8'));
    const ev = await ctx.db.query('INSERT INTO webhook_events(provider, external_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', ['telegram', String(u.update_id)]);
    if (ev.rows.length && u.message?.chat?.id !== undefined) await notifications.handleTelegramMessage(ctx, { chatId: String(u.message.chat.id), text: String(u.message.text ?? '') });
    return { ok: true };
  }, { auth: 'none', raw: true, rate: 'none' });

  // ---------- admin ----------
  r.get('/api/admin/readiness', () => admin.readiness(ctx), { auth: 'admin' });
  r.get('/api/admin/usage', () => admin.usage(ctx), { auth: 'admin' });
  r.get('/api/admin/notifications', () => admin.notificationFailures(ctx), { auth: 'admin' });
  r.get('/api/admin/errors', () => admin.errors(ctx), { auth: 'admin' });
  r.get('/api/admin/health', () => admin.health(ctx), { auth: 'admin' });
  r.get('/api/admin/stats', () => admin.stats(ctx), { auth: 'admin' });

  function redirect(c: Ctx, to: string) { c.res.writeHead(302, { Location: to }); c.res.end(); return undefined; }

  const expectedOrigin = new URL(cfg.appUrl).origin;

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const started = Date.now();
    securityHeaders(res, cfg.isProd);
    const url = new URL(req.url ?? '/', 'http://local');
    const ip = (cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
    const cookies: string[] = [];
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' || req.method === 'HEAD') { if (serveStatic(PUBLIC_DIR, url.pathname, res)) return; }
        throw new HttpError(404, 'not_found', 'Not found');
      }
      const m = r.match(req.method ?? 'GET', url.pathname);
      if (m === null) throw new HttpError(404, 'not_found', 'Not found');
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      const opts: RouteOpts = { auth: 'user', rate: 'default', ...m.route.opts };
      const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await readBody(req) : Buffer.alloc(0);
      let body: unknown = undefined;
      if (rawBody.length && !opts.raw) {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Use application/json');
        try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'Malformed JSON'); }
      }
      const sess = await auth.loadSession(ctx, parseCookies(req.headers.cookie)[auth.SESSION_COOKIE]);
      const c: Ctx = {
        req, res, url, params: m.params, rawBody, body, ip, user: sess?.user ?? null, session: sess ? { id: sess.sessionId, csrfToken: sess.csrf } : null,
        setCookie: (name, value, o = {}) => cookies.push(`${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${o.httpOnly === false ? '' : '; HttpOnly'}${cfg.isProd ? '; Secure' : ''}${o.maxAgeSec !== undefined ? `; Max-Age=${o.maxAgeSec}` : ''}`),
      };
      // CSRF: state-changing requests must come from our origin; authenticated ones must also present the session's CSRF token.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !opts.raw) {
        const origin = req.headers.origin ?? (req.headers.referer ? new URL(String(req.headers.referer)).origin : null);
        if (origin && origin !== expectedOrigin) throw new HttpError(403, 'csrf', 'Cross-site request blocked');
        if (!origin && cfg.isProd) throw new HttpError(403, 'csrf', 'Missing origin');
        if (c.session && !timingSafeEqualStr(String(req.headers['x-csrf-token'] ?? ''), c.session.csrfToken)) throw new HttpError(403, 'csrf', 'Invalid CSRF token. Reload the page.');
      }
      if (opts.auth !== 'none' && !c.user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
      if (opts.auth === 'admin' && c.user?.role !== 'admin') throw new HttpError(404, 'not_found', 'Not found');
      if (opts.rate !== 'none') {
        const who = c.user?.id ?? ip;
        if (opts.rate === 'auth') await rateLimit(ctx.db, `auth:${ip}`, cfg.limits.authRatePerMinute, 60, ctx.now());
        else if (opts.rate === 'expensive') await rateLimit(ctx.db, `exp:${who}`, cfg.limits.expensiveRatePerHour, 3600, ctx.now());
        await rateLimit(ctx.db, `api:${who}`, cfg.limits.apiRatePerMinute, 60, ctx.now());
      }
      const out = await m.route.handler(c);
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      if (!res.headersSent && out !== undefined) sendJson(res, res.statusCode !== 200 ? res.statusCode : 200, out);
      else if (!res.headersSent) { res.writeHead(204); res.end(); }
    } catch (e) {
      const { status, body } = errorResponse(e);
      if (cookies.length && !res.headersSent) res.setHeader('Set-Cookie', cookies);
      if (!res.headersSent) sendJson(res, status, body); else res.end();
    } finally {
      if (url.pathname.startsWith('/api/')) log.info('request', { method: req.method, path: url.pathname.replace(/[0-9a-f-]{36}/g, ':id'), status: res.statusCode, ms: Date.now() - started });
    }
  };
}
