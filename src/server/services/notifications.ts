// Reminders over WhatsApp (paid templates) or Telegram (free): verified opt-in, persistent scheduling, duplicate-send protection, delivery tracking, opt-out.
import crypto from 'node:crypto';
import type { AppContext } from '../context.ts';
import { HttpError } from '../http/core.ts';
import { sha256, timingSafeEqualStr } from '../secrets.ts';
import { computeDepartureTimeline, dailySendTimes, notificationDedupeKey, pretripSendAt } from '../domain/reminders.ts';
import { fromLocal, haversineKm, toLocal } from '../domain/time.ts';
import type { FlightOffer } from '../../shared/types.ts';
import { getProfile } from './profile.ts';
import { getOwnedTrip, getStops } from './trips.ts';
import { parseWhatsAppInbound, parseWhatsAppStatuses } from '../integrations/messaging.ts';

const E164 = /^\+[1-9]\d{7,14}$/;

export async function getChannel(ctx: AppContext, userId: string) {
  const r = await ctx.db.query<any>('SELECT * FROM notification_channels WHERE user_id=$1', [userId]);
  const c = r.rows[0];
  const whatsappAvailable = ctx.providers.messenger.configured();
  const telegramAvailable = !!ctx.providers.telegram?.configured();
  const callmebotAvailable = !!ctx.providers.callmebot?.configured() && !!ctx.sealer;
  const available = whatsappAvailable || telegramAvailable || callmebotAvailable;
  const base = { available, whatsappAvailable, telegramAvailable, callmebotAvailable, telegramBot: telegramAvailable ? ctx.providers.telegram!.botUsername() : null };
  if (!c) return { ...base, kind: null, phone: null, verified: false, optedIn: false };
  return { ...base, kind: c.kind, telegramConnected: c.kind === 'telegram' && !!c.telegram_chat_id, phone: c.phone_e164, verified: !!c.verified_at, optedIn: !!c.opted_in_at && !c.opted_out_at, shareBookingRefs: c.share_booking_refs, pretripBriefing: c.pretrip_briefing, dailySchedule: c.daily_schedule, dailyTime: c.daily_time, pretripTime: c.pretrip_time };
}

export async function startPhoneVerification(ctx: AppContext, userId: string, phone: string) {
  if (!E164.test(phone)) throw new HttpError(400, 'invalid_input', 'Enter the number in international format, e.g. +32470123456.');
  if (!ctx.providers.messenger.configured()) throw new HttpError(503, 'service_unavailable', 'WhatsApp reminders are not available yet.');
  const recent = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND kind='phone_verification' AND created_at > $2`, [userId, new Date(ctx.now().getTime() - 3600_000)]);
  if (recent.rows[0].n >= 5) throw new HttpError(429, 'rate_limited', 'Too many verification codes requested. Try again in an hour.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO notification_channels(user_id, kind, phone_e164, verification_code_hash, code_expires_at, verify_attempts, verified_at, opted_in_at)
      VALUES ($1,'whatsapp',$2,$3,$4,0,NULL,NULL)
      ON CONFLICT (user_id) DO UPDATE SET kind='whatsapp', telegram_chat_id=NULL, link_token_hash=NULL, phone_e164=EXCLUDED.phone_e164, verification_code_hash=EXCLUDED.verification_code_hash, code_expires_at=EXCLUDED.code_expires_at, verify_attempts=0,
        verified_at=CASE WHEN notification_channels.phone_e164=EXCLUDED.phone_e164 THEN notification_channels.verified_at ELSE NULL END,
        opted_in_at=CASE WHEN notification_channels.phone_e164=EXCLUDED.phone_e164 THEN notification_channels.opted_in_at ELSE NULL END, updated_at=now()`,
      [userId, phone, sha256(`${userId}:${code}`), new Date(ctx.now().getTime() + 10 * 60000)]);
    const n = await q.query<{ id: string }>(`INSERT INTO notifications(user_id, kind, scheduled_for, dedupe_key, body_preview) VALUES ($1,'phone_verification',$2,$3,$4) RETURNING id`,
      [userId, ctx.now(), `verify:${userId}:${crypto.randomUUID()}`, 'Verification code']);
    // The code itself is only kept in the sealed job payload until sent.
    const payload = ctx.sealer ? { notificationId: n.rows[0].id, userId, sealedCode: ctx.sealer.seal(code) } : { notificationId: n.rows[0].id, userId, code };
    const jobId = await ctx.jobs.enqueue('notify.send', payload, { q, maxAttempts: 3 });
    await q.query('UPDATE notifications SET job_id=$2 WHERE id=$1', [n.rows[0].id, jobId]);
  });
}

export async function confirmPhone(ctx: AppContext, userId: string, code: string) {
  const r = await ctx.db.query<any>('SELECT * FROM notification_channels WHERE user_id=$1 FOR UPDATE', [userId]);
  const c = r.rows[0];
  if (!c || !c.verification_code_hash) throw new HttpError(400, 'invalid_code', 'Request a verification code first.');
  if (c.verify_attempts >= 5) throw new HttpError(429, 'rate_limited', 'Too many attempts. Request a new code.');
  if (new Date(c.code_expires_at) < ctx.now()) throw new HttpError(400, 'invalid_code', 'The code has expired. Request a new one.');
  if (!timingSafeEqualStr(sha256(`${userId}:${code}`), c.verification_code_hash)) {
    await ctx.db.query('UPDATE notification_channels SET verify_attempts=verify_attempts+1 WHERE user_id=$1', [userId]);
    throw new HttpError(400, 'invalid_code', 'That code is not correct.');
  }
  await ctx.db.query('UPDATE notification_channels SET verified_at=now(), verification_code_hash=NULL, code_expires_at=NULL, updated_at=now() WHERE user_id=$1', [userId]);
}

export async function updateConsent(ctx: AppContext, userId: string, i: { optIn: boolean; shareBookingRefs?: boolean; pretripBriefing?: boolean; dailySchedule?: boolean; dailyTime?: string; pretripTime?: string }) {
  const r = await ctx.db.query<any>('SELECT * FROM notification_channels WHERE user_id=$1', [userId]);
  const c = r.rows[0];
  if (i.optIn && (!c || !c.verified_at)) throw new HttpError(400, 'phone_not_verified', 'Verify your WhatsApp number first.');
  if (!c) return;
  await ctx.db.query(`UPDATE notification_channels SET opted_in_at=CASE WHEN $2 THEN COALESCE(CASE WHEN opted_out_at IS NULL THEN opted_in_at END, now()) ELSE opted_in_at END,
      opted_out_at=CASE WHEN $2 THEN NULL ELSE now() END, share_booking_refs=COALESCE($3, share_booking_refs), pretrip_briefing=COALESCE($4, pretrip_briefing),
      daily_schedule=COALESCE($5, daily_schedule), daily_time=COALESCE($6, daily_time), pretrip_time=COALESCE($7, pretrip_time), updated_at=now() WHERE user_id=$1`,
    [userId, i.optIn, i.shareBookingRefs ?? null, i.pretripBriefing ?? null, i.dailySchedule ?? null, i.dailyTime ?? null, i.pretripTime ?? null]);
  if (!i.optIn) await cancelAll(ctx, userId);
  else {
    const trips = await ctx.db.query<{ id: string }>(`SELECT id FROM trips WHERE user_id=$1 AND status NOT IN ('completed','cancelled') AND (end_date IS NULL OR end_date >= $2::date)`, [userId, ctx.now().toISOString().slice(0, 10)]);
    for (const t of trips.rows) await scheduleTripNotifications(ctx, userId, t.id);
  }
}

async function cancelAll(ctx: AppContext, userId: string, kinds: string[] = ['pretrip_briefing', 'daily_schedule'], tripId?: string) {
  const r = await ctx.db.query<{ id: string; job_id: number | null }>(`UPDATE notifications SET status='cancelled', updated_at=now() WHERE user_id=$1 AND status='scheduled' AND kind = ANY($2::text[]) ${tripId ? 'AND trip_id=$3' : ''} RETURNING id, job_id`, tripId ? [userId, kinds, tripId] : [userId, kinds]);
  for (const n of r.rows) if (n.job_id) await ctx.jobs.cancel(n.job_id);
}

async function upsertScheduled(ctx: AppContext, userId: string, tripId: string, kind: 'pretrip_briefing' | 'daily_schedule', dedupe: string, at: Date, preview: string) {
  const r = await ctx.db.query<{ id: string; status: string; job_id: number | null }>(
    `INSERT INTO notifications(user_id, trip_id, kind, scheduled_for, dedupe_key, body_preview) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO UPDATE SET scheduled_for=CASE WHEN notifications.status IN ('scheduled','cancelled') THEN EXCLUDED.scheduled_for ELSE notifications.scheduled_for END,
       status=CASE WHEN notifications.status='cancelled' THEN 'scheduled' ELSE notifications.status END, body_preview=EXCLUDED.body_preview, updated_at=now()
     RETURNING id, status, job_id`, [userId, tripId, kind, at, dedupe, preview]);
  const n = r.rows[0];
  if (n.status !== 'scheduled') return; // already sent/delivered: never send twice
  const jobId = await ctx.jobs.enqueue('notify.send', { notificationId: n.id, userId, tripId }, { runAt: at, dedupeKey: `notify:${n.id}:${at.toISOString()}`, maxAttempts: 4 });
  if (n.job_id && n.job_id !== jobId) await ctx.jobs.cancel(n.job_id);
  await ctx.db.query('UPDATE notifications SET job_id=$2 WHERE id=$1', [n.id, jobId]);
}

/** (Re)creates persistent notification jobs for a trip according to consent and current trip data. */
export async function scheduleTripNotifications(ctx: AppContext, userId: string, tripId: string) {
  const ch = await ctx.db.query<any>('SELECT * FROM notification_channels WHERE user_id=$1', [userId]);
  const c = ch.rows[0];
  if (!c || !c.verified_at || !c.opted_in_at || c.opted_out_at) { await cancelAll(ctx, userId, undefined, tripId); return { scheduled: 0 }; }
  const trip = await getOwnedTrip(ctx, userId, tripId);
  if (!trip.startDate || trip.status === 'cancelled') return { scheduled: 0 };
  const profile = await getProfile(ctx, userId);
  const homeTz = profile.timeZone;
  const flight = await selectedFlight(ctx, tripId);
  const departUtc = flight?.slices[0]?.segments[0]?.departUtc ?? fromLocal(`${trip.startDate}T09:00`, homeTz).toISOString();
  let scheduled = 0;
  if (c.pretrip_briefing) {
    const p = pretripSendAt(departUtc, homeTz, c.pretrip_time, ctx.now());
    if (!Number.isNaN(p.at.getTime())) { await upsertScheduled(ctx, userId, tripId, 'pretrip_briefing', notificationDedupeKey('pretrip', tripId, 'v1'), p.at, `Pre-trip briefing for ${trip.title}`); scheduled++; }
  } else await cancelAll(ctx, userId, ['pretrip_briefing'], tripId);
  if (c.daily_schedule) {
    const days = (await ctx.db.query<{ day_date: string; time_zone: string }>('SELECT day_date, time_zone FROM itinerary_days WHERE trip_id=$1 ORDER BY day_date', [tripId])).rows;
    const sends = dailySendTimes(days.map((d) => ({ date: d.day_date, timeZone: d.time_zone })), c.daily_time, ctx.now());
    const keep = new Set<string>();
    for (const s of sends) { const k = notificationDedupeKey('daily', tripId, s.date); keep.add(k); await upsertScheduled(ctx, userId, tripId, 'daily_schedule', k, s.at, `Daily schedule ${s.date}`); scheduled++; }
    const stale = await ctx.db.query<{ id: string; job_id: number | null; dedupe_key: string }>(`SELECT id, job_id, dedupe_key FROM notifications WHERE trip_id=$1 AND kind='daily_schedule' AND status='scheduled'`, [tripId]);
    for (const s of stale.rows) if (!keep.has(s.dedupe_key)) { await ctx.db.query(`UPDATE notifications SET status='cancelled' WHERE id=$1`, [s.id]); if (s.job_id) await ctx.jobs.cancel(s.job_id); }
  } else await cancelAll(ctx, userId, ['daily_schedule'], tripId);
  return { scheduled };
}

async function selectedFlight(ctx: AppContext, tripId: string): Promise<FlightOffer | null> {
  const r = await ctx.db.query<any>(`SELECT data FROM offers WHERE trip_id=$1 AND kind='flight' AND selected ORDER BY quoted_at DESC LIMIT 1`, [tripId]);
  return r.rows[0]?.data?.offer ?? null;
}

const oneLine = (s: string, max = 700) => s.replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').slice(0, max) || '—';

export async function buildPretripParams(ctx: AppContext, userId: string, tripId: string, shareRefs: boolean): Promise<string[]> {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const profile = await getProfile(ctx, userId);
  const user = (await ctx.db.query<any>('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0];
  const flight = await selectedFlight(ctx, tripId);
  const resv = (await ctx.db.query<any>(`SELECT * FROM reservations WHERE user_id=$1 AND trip_id=$2`, [userId, tripId])).rows;
  const flightRes = resv.find((r) => r.kind === 'flight');
  const stayRes = resv.filter((r) => r.kind === 'stay');
  let flightText = 'No flight selected or imported.'; let checkin = 'Unknown'; let wake = '—'; let leave = '—'; let transfer = '—';
  if (flight) {
    const s = flight.slices[0].segments[0];
    flightText = `${flight.slices[0].segments.map((x) => x.flightNumber).join('+')} ${s.from} ${s.departLocal.slice(11, 16)} → ${flight.slices[0].to} ${flight.slices[0].segments.at(-1)!.arriveLocal.slice(11, 16)}`;
    const checkedIn = flightRes?.checkin_status === 'customer_confirmed' || flightRes?.checkin_status === 'provider_confirmed';
    checkin = checkedIn ? `Checked in (${flightRes.checkin_status === 'provider_confirmed' ? 'confirmed by airline' : 'confirmed by you'})` : 'NOT confirmed — complete online check-in with the airline';
    const home = profile.homePlace ?? trip.origin;
    // Prefer the airport's own coordinates; a city place can share the airport's IATA code but sits in the city centre.
    const ap = trip.origin?.airports?.find((a) => a.iata === s.from) ?? (trip.origin?.kind === 'airport' && trip.origin.iata === s.from ? trip.origin : undefined);
    let minutes = 60; let source: 'live_traffic' | 'planning_assumption' = 'planning_assumption';
    if (home && ap) {
      minutes = Math.round(15 + (haversineKm(home, ap) * 1.3 / 60) * 60);
      if (ctx.providers.routes.configured()) {
        try { const r = await ctx.providers.routes.travelMinutes(home, ap, new Date(new Date(s.departUtc).getTime() - 3 * 3600_000), 'DRIVE'); minutes = r.minutes; source = 'live_traffic'; } catch { /* keep assumption */ }
      }
    }
    const intl = (trip.origin?.countryCode ?? '') !== (stops[0]?.place.countryCode ?? '');
    const tl = computeDepartureTimeline({ departUtc: s.departUtc, airportTz: s.departTz, homeTz: profile.timeZone, international: intl, checkedBag: profile.checkedBag, checkedIn: checkin.startsWith('Checked'), transferMinutes: minutes, transferSource: source, prepMinutes: profile.prepMinutes });
    wake = tl.wakeLocal.slice(11, 16); leave = tl.leaveHomeLocal.slice(11, 16);
    transfer = `${minutes} min to ${s.from} (${source === 'live_traffic' ? 'live traffic estimate' : 'planning assumption'}), at airport by ${tl.arriveAirportLocal.slice(11, 16)}`;
  }
  if (shareRefs && flightRes?.confirmation_code) flightText += ` · Ref ${flightRes.confirmation_code}`;
  const stayText = stayRes.length ? stayRes.map((r) => `${r.details?.propertyName ?? r.provider_name}${shareRefs && r.confirmation_code ? ` (ref ${r.confirmation_code})` : ''}`).join('; ') : 'No accommodation confirmation imported yet';
  const day1 = (await ctx.db.query<any>(`SELECT d.weather, d.status, i.kind, i.start_local, i.title, i.venue FROM itinerary_days d LEFT JOIN itinerary_items i ON i.day_id=d.id WHERE d.trip_id=$1 AND d.day_date=$2 ORDER BY i.position`, [tripId, trip.startDate])).rows;
  const w = day1[0]?.weather;
  const weather = w ? `${w.kind === 'forecast' ? 'Forecast' : 'Typical (historical climate)'} ${w.tempMinC ?? '?'}–${w.tempMaxC ?? '?'}°C, ${w.precipitationProbability ?? '?'}% rain${(w.precipitationProbability ?? 0) >= 50 ? ' — pack a rain layer' : ''}` : 'Weather unavailable';
  const items = day1.filter((x) => x.kind && !['transfer', 'break', 'wake'].includes(x.kind)).map((x) => `${String(x.start_local).slice(11, 16)} ${x.title}`).join(' · ');
  const food = day1.filter((x) => ['breakfast', 'lunch', 'dinner'].includes(x.kind)).map((x) => `${x.kind}: ${x.venue?.name}${x.venue?.dishes?.length ? ` (${x.venue.dishes.filter((d: any) => d.dietStatus !== 'uncertain').map((d: any) => d.name).slice(0, 2).join(', ') || 'ask staff about options'})` : ''}`).join(' · ');
  return [user?.display_name || 'traveller', stops.map((s) => s.place.name).join(' → '), oneLine(flightText), oneLine(checkin), wake, leave, oneLine(transfer), oneLine(stayText), oneLine(weather), oneLine(items || (day1[0]?.status ? 'Plan incomplete — open the app' : 'No plan generated yet')), oneLine(food || '—')];
}

export async function buildDailyParams(ctx: AppContext, userId: string, tripId: string, date: string): Promise<string[] | null> {
  const user = (await ctx.db.query<any>('SELECT display_name FROM users WHERE id=$1', [userId])).rows[0];
  const rows = (await ctx.db.query<any>(`SELECT d.weather, d.status, d.missing, s.place, i.kind, i.start_local, i.title FROM itinerary_days d JOIN trips t ON t.id=d.trip_id LEFT JOIN trip_stops s ON s.id=d.stop_id LEFT JOIN itinerary_items i ON i.day_id=d.id WHERE d.trip_id=$1 AND t.user_id=$2 AND d.day_date=$3 ORDER BY i.position`, [tripId, userId, date])).rows;
  if (!rows.length) return null;
  const w = rows[0].weather;
  const items = rows.filter((x) => x.kind && !['transfer', 'break'].includes(x.kind)).map((x) => `${String(x.start_local).slice(11, 16)} ${x.title}`).join(' · ');
  const weather = w ? `${w.kind === 'forecast' ? 'Forecast' : 'Typical'} ${w.tempMinC ?? '?'}–${w.tempMaxC ?? '?'}°C, ${w.precipitationProbability ?? '?'}% rain` : 'unavailable';
  const note = rows[0].status === 'complete' ? 'All venues verified from current sources.' : `Incomplete: ${(rows[0].missing ?? []).slice(0, 2).join('; ')}`;
  return [user?.display_name || 'traveller', date, rows[0].place?.name ?? '', oneLine(items || '—', 900), oneLine(weather), oneLine(note)];
}

/** Job handler. Guarantees at-most-once delivery attempts per notification row. */
export async function sendNotificationJob(ctx: AppContext, p: { notificationId: string; userId: string; code?: string; sealedCode?: string }) {
  const claim = await ctx.db.query<any>(`UPDATE notifications SET status='sending', attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='scheduled' RETURNING *`, [p.notificationId]);
  const n = claim.rows[0];
  if (!n) {
    const cur = await ctx.db.query<any>('SELECT status FROM notifications WHERE id=$1', [p.notificationId]);
    if (cur.rows[0]?.status === 'sending') {
      // A previous attempt may have reached WhatsApp before crashing; do not risk a duplicate.
      await ctx.db.query(`UPDATE notifications SET status='failed', last_error='Delivery outcome unknown after interrupted send; not retried to avoid duplicates', updated_at=now() WHERE id=$1`, [p.notificationId]);
    }
    return;
  }
  const ch = (await ctx.db.query<any>('SELECT * FROM notification_channels WHERE user_id=$1', [n.user_id])).rows[0];
  const t = ctx.cfg.whatsapp.templates;
  let template: string; let params: string[] | null;
  try {
    if (n.kind === 'phone_verification') {
      if (!ch) throw new Error('no channel');
      template = t.verification;
      params = [p.sealedCode && ctx.sealer ? ctx.sealer.open(p.sealedCode) : String(p.code)];
    } else {
      if (!ch?.verified_at || !ch.opted_in_at || ch.opted_out_at) {
        await ctx.db.query(`UPDATE notifications SET status='cancelled', last_error='Recipient not opted in', updated_at=now() WHERE id=$1`, [n.id]);
        return;
      }
      if (n.kind === 'pretrip_briefing') { template = t.pretrip; params = await buildPretripParams(ctx, n.user_id, n.trip_id, ch.share_booking_refs); }
      else {
        template = t.daily;
        const tz = (await ctx.db.query<any>('SELECT time_zone FROM itinerary_days WHERE trip_id=$1 ORDER BY day_date', [n.trip_id])).rows;
        const date = toLocal(new Date(n.scheduled_for), tz[0]?.time_zone ?? 'UTC').slice(0, 10);
        params = await buildDailyParams(ctx, n.user_id, n.trip_id, n.dedupe_key.split(':').pop() ?? date);
        if (!params) { await ctx.db.query(`UPDATE notifications SET status='cancelled', last_error='No itinerary for this day', updated_at=now() WHERE id=$1`, [n.id]); return; }
      }
    }
    if (ch.kind === 'callmebot') {
      if (!ctx.providers.callmebot?.configured() || !ch.callmebot_key_enc || !ctx.sealer) throw new Error('WhatsApp (CallMeBot) is not connected');
      const text = renderTemplate(n.kind, params, 'callmebot');
      const r = await ctx.providers.callmebot.send(ch.phone_e164, ctx.sealer.open(ch.callmebot_key_enc), text, n.user_id);
      // CallMeBot gives no delivery receipts, so this stays "sent", never "delivered".
      await ctx.db.query(`UPDATE notifications SET status='sent', provider_message_id=$2, status_updated_at=now(), last_error=NULL, body_preview=$3, updated_at=now() WHERE id=$1`, [n.id, r.messageId, text.slice(0, 500)]);
      return;
    }
    if (ch.kind === 'telegram') {
      if (!ctx.providers.telegram?.configured() || !ch.telegram_chat_id) throw new Error('Telegram is not connected');
      const text = renderTemplate(n.kind, params);
      const t = await ctx.providers.telegram.sendText(ch.telegram_chat_id, text);
      // Telegram's API returns the stored message: it is in the recipient's chat (delivery evidence for this channel).
      await ctx.db.query(`UPDATE notifications SET status='delivered', provider_message_id=$2, status_updated_at=now(), last_error=NULL, body_preview=$3, updated_at=now() WHERE id=$1`, [n.id, t.messageId, text.slice(0, 500)]);
      return;
    }
    const r = await ctx.providers.messenger.sendTemplate(ch.phone_e164, template, params, ctx.cfg.whatsapp.templateLanguage);
    await ctx.db.query(`UPDATE notifications SET status='sent', provider_message_id=$2, status_updated_at=now(), last_error=NULL, body_preview=$3, updated_at=now() WHERE id=$1`, [n.id, r.messageId, n.kind === 'phone_verification' ? 'Verification code' : params.join(' | ').slice(0, 500)]);
  } catch (e) {
    const final = n.attempts >= 4 || n.kind === 'phone_verification' && n.attempts >= 3;
    await ctx.db.query(`UPDATE notifications SET status=$2, last_error=$3, updated_at=now() WHERE id=$1`, [n.id, final ? 'failed' : 'scheduled', (e as Error).message.slice(0, 500)]);
    if (!final) throw e; // job queue retries with backoff
  }
}

const RANK: Record<string, number> = { scheduled: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5, cancelled: 5 };

export async function handleWhatsAppWebhook(ctx: AppContext, payload: unknown) {
  let updated = 0;
  for (const s of parseWhatsAppStatuses(payload)) {
    const ev = await ctx.db.query('INSERT INTO webhook_events(provider, external_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', ['whatsapp', `${s.id}:${s.status}`]);
    if (!ev.rows.length) continue; // duplicate callback
    const cur = await ctx.db.query<any>('SELECT id, status FROM notifications WHERE provider_message_id=$1', [s.id]);
    const n = cur.rows[0];
    if (!n) continue;
    if (s.status !== 'failed' && RANK[s.status] <= RANK[n.status]) continue; // out-of-order callback
    await ctx.db.query('UPDATE notifications SET status=$2, status_updated_at=to_timestamp($3), last_error=$4, updated_at=now() WHERE id=$1', [n.id, s.status, Number(s.timestamp) || Date.now() / 1000, s.errors?.map((x) => `${x.code} ${x.title}`).join('; ') ?? null]);
    updated++;
  }
  for (const m of parseWhatsAppInbound(payload)) {
    if (/^\s*(stop|unsubscribe|stopp|arr[eê]t|cancel)\s*$/i.test(m.text)) {
      const r = await ctx.db.query<{ user_id: string }>(`UPDATE notification_channels SET opted_out_at=now(), updated_at=now() WHERE phone_e164=$1 RETURNING user_id`, [m.from]);
      for (const u of r.rows) await cancelAll(ctx, u.user_id);
    }
  }
  return { updated };
}

export async function listNotifications(ctx: AppContext, userId: string, tripId?: string) {
  const r = await ctx.db.query<any>(`SELECT id, trip_id, kind, scheduled_for, status, attempts, last_error, status_updated_at, body_preview, job_id FROM notifications WHERE user_id=$1 ${tripId ? 'AND trip_id=$2' : ''} AND kind<>'phone_verification' ORDER BY scheduled_for`, tripId ? [userId, tripId] : [userId]);
  return r.rows.map((n) => ({ id: n.id, tripId: n.trip_id, kind: n.kind, scheduledFor: n.scheduled_for, status: n.status, attempts: n.attempts, lastError: n.last_error, statusUpdatedAt: n.status_updated_at, preview: n.body_preview, hasJob: !!n.job_id }));
}

// ---------------------------------------------------------------- Telegram (free channel)
/** Text versions of the message templates (Telegram needs no template approval). */
export function renderTemplate(kind: string, p: string[], channel: 'telegram' | 'callmebot' = 'telegram'): string {
  const stop = channel === 'telegram' ? 'Send /stop to stop reminders.' : 'Turn reminders off in Travel Compass → Reminders.';
  if (kind === 'pretrip_briefing') return [
    `Hi ${p[0]}, your trip (${p[1]}) starts tomorrow.`, '', `Flight: ${p[2]}`, `Check-in: ${p[3]}`, `Wake up ${p[4]}, leave home ${p[5]}.`, `Transfer: ${p[6]}`,
    `Stay: ${p[7]}`, `Weather: ${p[8]}`, '', `Day 1: ${p[9]}`, `Food: ${p[10]}`, '', stop].join('\n');
  if (kind === 'daily_schedule') return [`Good morning ${p[0]}! ${p[1]} in ${p[2]}:`, p[3].split(' · ').join('\n'), '', `Weather: ${p[4]}`, p[5], '', stop].join('\n');
  return p.join('\n');
}

/** Creates a one-time deep link (t.me/<bot>?start=<token>) that connects the customer's Telegram chat. */
export async function startTelegramLink(ctx: AppContext, userId: string) {
  const tg = ctx.providers.telegram;
  if (!tg?.configured()) throw new HttpError(503, 'service_unavailable', 'Telegram reminders are not available yet.');
  const token = crypto.randomBytes(18).toString('base64url');
  await ctx.db.query(`INSERT INTO notification_channels(user_id, kind, link_token_hash, link_expires_at) VALUES ($1,'telegram',$2,$3)
    ON CONFLICT (user_id) DO UPDATE SET kind='telegram', phone_e164=NULL, verification_code_hash=NULL, link_token_hash=EXCLUDED.link_token_hash, link_expires_at=EXCLUDED.link_expires_at,
      verified_at=CASE WHEN notification_channels.kind='telegram' THEN notification_channels.verified_at ELSE NULL END,
      opted_in_at=CASE WHEN notification_channels.kind='telegram' THEN notification_channels.opted_in_at ELSE NULL END, updated_at=now()`,
    [userId, sha256(token), new Date(ctx.now().getTime() + 30 * 60000)]);
  return { url: `https://t.me/${tg.botUsername()}?start=${token}` };
}

/** Handles one incoming Telegram message: /start <token> links the chat, /stop opts out. */
export async function handleTelegramMessage(ctx: AppContext, m: { chatId: string; text: string }) {
  const tg = ctx.providers.telegram!;
  const text = m.text.trim();
  const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{10,64})$/.exec(text);
  if (start) {
    const r = await ctx.db.query<{ user_id: string }>(`UPDATE notification_channels SET telegram_chat_id=$2, verified_at=now(), link_token_hash=NULL, link_expires_at=NULL, opted_out_at=NULL, updated_at=now()
      WHERE link_token_hash=$1 AND link_expires_at > $3 AND kind='telegram' RETURNING user_id`, [sha256(start[1]), m.chatId, ctx.now()]);
    await tg.sendText(m.chatId, r.rows.length ? 'Connected to Travel Compass. Turn on reminders in the app (Reminders page) to receive briefings here.' : 'This link has expired. Open Travel Compass → Reminders and connect Telegram again.').catch(() => {});
    return;
  }
  if (/^\/(stop|unsubscribe)\b/i.test(text)) {
    const r = await ctx.db.query<{ user_id: string }>(`UPDATE notification_channels SET opted_out_at=now(), updated_at=now() WHERE telegram_chat_id=$1 AND kind='telegram' RETURNING user_id`, [m.chatId]);
    for (const u of r.rows) await cancelAll(ctx, u.user_id);
    await tg.sendText(m.chatId, 'Reminders stopped. You can turn them on again in the app.').catch(() => {});
    return;
  }
  if (/^\/start\b/.test(text)) await tg.sendText(m.chatId, 'To connect, open Travel Compass → Reminders → Connect Telegram.').catch(() => {});
}

/** Polls getUpdates (no public URL needed). Offset is persisted so updates are processed once. */
export async function pollTelegram(ctx: AppContext) {
  const tg = ctx.providers.telegram;
  if (!tg?.configured()) return 0;
  return ctx.db.tx(async (q) => {
    const lock = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(727275) AS ok');
    if (!lock.rows[0].ok) return 0;
    const st = await q.query<{ value: { offset: number } }>(`SELECT value FROM kv_state WHERE key='telegram_offset'`);
    const offset = st.rows[0]?.value.offset ?? 0;
    const updates = await tg.getUpdates(offset);
    for (const u of updates) await handleTelegramMessage(ctx, u).catch(() => {});
    if (updates.length) {
      const next = Math.max(...updates.map((u) => u.updateId)) + 1;
      await q.query(`INSERT INTO kv_state(key, value) VALUES ('telegram_offset', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [{ offset: next }]);
    }
    return updates.length;
  });
}

// ---------------------------------------------------------------- WhatsApp via CallMeBot (free, personal)
/** Saves the customer's own CallMeBot key (encrypted) and proves it works by sending a 6-digit code to their WhatsApp. */
export async function startCallMeBot(ctx: AppContext, userId: string, phone: string, apiKey: string) {
  if (!E164.test(phone)) throw new HttpError(400, 'invalid_input', 'Enter the number in international format, e.g. +32470123456.');
  if (!/^[A-Za-z0-9]{4,40}$/.test(apiKey)) throw new HttpError(400, 'invalid_input', 'The CallMeBot API key is the number or code the bot sent you.');
  if (!ctx.providers.callmebot?.configured() || !ctx.sealer) throw new HttpError(503, 'service_unavailable', 'WhatsApp via CallMeBot is not available.');
  const recent = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider_usage WHERE provider='callmebot' AND user_id=$1 AND created_at > $2`, [userId, new Date(ctx.now().getTime() - 3600_000)]);
  if (recent.rows[0].n >= 5) throw new HttpError(429, 'rate_limited', 'Too many codes requested. Try again in an hour.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.providers.callmebot.send(phone, apiKey, `Your Travel Compass code is ${code}. It expires in 10 minutes.`, userId);
  await ctx.db.query(`INSERT INTO notification_channels(user_id, kind, phone_e164, callmebot_key_enc, verification_code_hash, code_expires_at, verify_attempts)
    VALUES ($1,'callmebot',$2,$3,$4,$5,0)
    ON CONFLICT (user_id) DO UPDATE SET kind='callmebot', phone_e164=EXCLUDED.phone_e164, callmebot_key_enc=EXCLUDED.callmebot_key_enc, telegram_chat_id=NULL, link_token_hash=NULL,
      verification_code_hash=EXCLUDED.verification_code_hash, code_expires_at=EXCLUDED.code_expires_at, verify_attempts=0, verified_at=NULL, opted_in_at=NULL, updated_at=now()`,
    [userId, phone, ctx.sealer.seal(apiKey), sha256(`${userId}:${code}`), new Date(ctx.now().getTime() + 10 * 60000)]);
}
