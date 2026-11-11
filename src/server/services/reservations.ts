// Reservation organiser and customer-specific Gmail import (OAuth, least privilege, revocable).
import type { AppContext } from '../context.ts';
import { requireSealer } from '../context.ts';
import { HttpError } from '../http/core.ts';
import { associateTrip, dedupeKey, extractReservation, type ExtractedReservation } from '../domain/emailExtract.ts';
import { GMAIL_SCOPE, GmailClient } from '../integrations/google.ts';
import { googleOAuth, startOAuth } from './auth.ts';
import { reservationFromRow } from './trips.ts';

export async function listReservations(ctx: AppContext, userId: string) {
  const r = await ctx.db.query('SELECT * FROM reservations WHERE user_id=$1 ORDER BY start_at NULLS LAST, created_at', [userId]);
  return r.rows.map(reservationFromRow);
}

export async function upsertReservation(ctx: AppContext, userId: string, e: ExtractedReservation & { source: 'gmail' | 'manual' | 'booking_flow'; tripId?: string | null }) {
  const trips = (await ctx.db.query<any>('SELECT id, start_date, end_date FROM trips WHERE user_id=$1', [userId])).rows.map((t) => ({ id: t.id, startDate: t.start_date, endDate: t.end_date }));
  const tripId = e.tripId ?? associateTrip(e, trips);
  const key = dedupeKey(e);
  const r = await ctx.db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO reservations(user_id, trip_id, kind, provider_name, confirmation_code, details, start_at, end_at, source, source_ref, dedupe_key, extraction_confidence, review_status, checkin_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
       details = CASE WHEN reservations.review_status='confirmed' THEN reservations.details ELSE reservations.details || EXCLUDED.details END,
       extraction_confidence = GREATEST(reservations.extraction_confidence, EXCLUDED.extraction_confidence),
       trip_id = COALESCE(reservations.trip_id, EXCLUDED.trip_id), updated_at=now()
     RETURNING id, (xmax = 0) AS inserted`,
    [userId, tripId, e.kind, e.providerName, e.confirmationCode, e.details, e.startDate ? new Date(e.startDate + 'T12:00:00Z') : null, e.endDate ? new Date(e.endDate + 'T12:00:00Z') : null,
      e.source, e.sourceRef, key, e.confidence, e.source === 'manual' ? 'confirmed' : 'needs_review', e.kind === 'flight' ? (e.details.checkInMentioned ? 'pending' : 'unknown') : 'not_applicable']);
  return r.rows[0];
}

export async function updateReservation(ctx: AppContext, userId: string, id: string, i: { tripId?: string | null; confirmationCode?: string | null; providerName?: string; details?: Record<string, unknown>; startDate?: string | null; endDate?: string | null; reviewStatus?: 'needs_review' | 'confirmed'; checkinStatus?: 'unknown' | 'not_open' | 'pending' | 'customer_confirmed' | 'not_applicable' }) {
  if (i.tripId) { const t = await ctx.db.query('SELECT 1 FROM trips WHERE id=$1 AND user_id=$2', [i.tripId, userId]); if (!t.rows.length) throw new HttpError(404, 'not_found', 'Trip not found'); }
  const r = await ctx.db.query(`UPDATE reservations SET trip_id=CASE WHEN $3::boolean THEN $4::uuid ELSE trip_id END, confirmation_code=COALESCE($5, confirmation_code), provider_name=COALESCE($6, provider_name),
      details=COALESCE($7, details), start_at=COALESCE($8, start_at), end_at=COALESCE($9, end_at), review_status=COALESCE($10, review_status), checkin_status=COALESCE($11, checkin_status), updated_at=now()
    WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, userId, i.tripId !== undefined, i.tripId ?? null, i.confirmationCode ?? null, i.providerName ?? null, i.details ?? null, i.startDate ? new Date(i.startDate + 'T12:00:00Z') : null, i.endDate ? new Date(i.endDate + 'T12:00:00Z') : null, i.reviewStatus ?? null, i.checkinStatus ?? null]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Reservation not found');
  return reservationFromRow(r.rows[0]);
}

export async function deleteReservation(ctx: AppContext, userId: string, id: string) {
  const r = await ctx.db.query('DELETE FROM reservations WHERE id=$1 AND user_id=$2 RETURNING id', [id, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Reservation not found');
}

// ---- Gmail -----------------------------------------------------------------------------
export async function gmailStatus(ctx: AppContext, userId: string) {
  const r = await ctx.db.query<any>(`SELECT account_email, scopes, connected_at, last_sync_at FROM oauth_connections WHERE user_id=$1 AND provider='gmail'`, [userId]);
  return { available: googleOAuth(ctx).configured() && !!ctx.sealer, connected: !!r.rows[0], accountEmail: r.rows[0]?.account_email ?? null, connectedAt: r.rows[0]?.connected_at ?? null, lastSyncAt: r.rows[0]?.last_sync_at ?? null };
}

export async function gmailConnectUrl(ctx: AppContext, userId: string) {
  if (!ctx.sealer) throw new HttpError(503, 'service_unavailable', 'Email import is not available yet.');
  return startOAuth(ctx, 'gmail_connect', userId, GMAIL_SCOPE);
}

export async function gmailCallback(ctx: AppContext, userId: string, code: string, verifier: string) {
  const sealer = requireSealer(ctx);
  const tok = await googleOAuth(ctx).exchange(code, `${ctx.cfg.appUrl}/api/oauth/google/callback`, verifier);
  if (!tok.scope.split(' ').includes(GMAIL_SCOPE)) throw new HttpError(400, 'scope_denied', 'Gmail read access was not granted, so reservations cannot be imported.');
  const email = await new GmailClient(tok.access_token).profileEmail();
  await ctx.db.query(`INSERT INTO oauth_connections(user_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at) VALUES ($1,'gmail',$2,$3,$4,$5,$6)
    ON CONFLICT (user_id, provider) DO UPDATE SET account_email=EXCLUDED.account_email, scopes=EXCLUDED.scopes, access_token_enc=EXCLUDED.access_token_enc,
      refresh_token_enc=COALESCE(EXCLUDED.refresh_token_enc, oauth_connections.refresh_token_enc), expires_at=EXCLUDED.expires_at, connected_at=now()`,
    [userId, email, tok.scope, sealer.seal(tok.access_token), tok.refresh_token ? sealer.seal(tok.refresh_token) : null, new Date(ctx.now().getTime() + tok.expires_in * 1000)]);
  await ctx.jobs.enqueue('gmail.sync', { userId }, { dedupeKey: `gmail-sync:${userId}:${ctx.now().toISOString().slice(0, 16)}` });
}

async function accessToken(ctx: AppContext, userId: string): Promise<string | null> {
  const sealer = requireSealer(ctx);
  const r = await ctx.db.query<any>(`SELECT * FROM oauth_connections WHERE user_id=$1 AND provider='gmail'`, [userId]);
  const c = r.rows[0];
  if (!c) return null;
  if (c.expires_at && new Date(c.expires_at).getTime() > ctx.now().getTime() + 60_000) return sealer.open(c.access_token_enc);
  if (!c.refresh_token_enc) return null;
  const t = await googleOAuth(ctx).refresh(sealer.open(c.refresh_token_enc));
  await ctx.db.query(`UPDATE oauth_connections SET access_token_enc=$2, expires_at=$3 WHERE id=$1`, [c.id, sealer.seal(t.access_token), new Date(ctx.now().getTime() + t.expires_in * 1000)]);
  return t.access_token;
}

/** Job: scans only this customer's own inbox for travel confirmations. Never touches any other mailbox. */
export async function gmailSyncJob(ctx: AppContext, p: { userId: string }) {
  const token = await accessToken(ctx, p.userId);
  if (!token) return { imported: 0 };
  const gm = new GmailClient(token);
  const q = 'newer_than:18m (subject:(confirmation OR confirmed OR booking OR reservation OR itinerary OR e-ticket OR "boarding pass") OR from:(booking.com OR airbnb.com OR ryanair.com OR easyjet.com OR brusselsairlines.com OR klm.com OR lufthansa.com OR getyourguide.com))';
  const ids = await gm.listIds(q, 150);
  let imported = 0; let dupes = 0;
  for (const id of ids) {
    const seen = await ctx.db.query('SELECT 1 FROM reservations WHERE user_id=$1 AND source_ref=$2', [p.userId, id]);
    if (seen.rows.length) continue;
    const m = await gm.get(id);
    const ex = extractReservation(m);
    if (!ex) continue;
    const r = await upsertReservation(ctx, p.userId, { ...ex, details: { ...ex.details, emailSubject: m.subject.slice(0, 200), emailDate: m.date, evidence: ex.evidence }, source: 'gmail' });
    if (r.inserted) imported++; else dupes++;
  }
  await ctx.db.query(`UPDATE oauth_connections SET last_sync_at=now() WHERE user_id=$1 AND provider='gmail'`, [p.userId]);
  return { imported, dupes, scanned: ids.length };
}

export async function gmailDisconnect(ctx: AppContext, userId: string, deleteImported: boolean) {
  const r = await ctx.db.query<any>(`DELETE FROM oauth_connections WHERE user_id=$1 AND provider='gmail' RETURNING access_token_enc, refresh_token_enc`, [userId]);
  const c = r.rows[0];
  let revoked = false;
  if (c && ctx.sealer) {
    try { await googleOAuth(ctx).revoke(ctx.sealer.open(c.refresh_token_enc ?? c.access_token_enc)); revoked = true; } catch { /* token already invalid; local copy deleted regardless */ }
  }
  await ctx.db.query(`UPDATE jobs SET status='cancelled' WHERE status='queued' AND queue='gmail.sync' AND payload->>'userId'=$1`, [userId]);
  if (deleteImported) await ctx.db.query(`DELETE FROM reservations WHERE user_id=$1 AND source='gmail'`, [userId]);
  return { disconnected: !!c, revoked };
}
