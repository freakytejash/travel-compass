// Trips and stops. Every query is scoped by user_id on the server; optimistic concurrency via `version`.
import type { AppContext } from '../context.ts';
import type { Queryable } from '../db/pg.ts';
import { HttpError } from '../http/core.ts';
import type { Place } from '../../shared/types.ts';

export interface StopInput { place: Place; arriveDate: string; departDate: string }
export interface TripInput {
  title?: string; origin?: Place | null; adults?: number; startDate?: string | null; endDate?: string | null;
  flexDays?: number; budgetTotal?: number | null; currency?: string; stops?: StopInput[]; status?: 'draft' | 'planned' | 'booked' | 'completed' | 'cancelled';
}

export function tripFromRow(r: any) {
  return {
    id: r.id as string, title: r.title as string, status: r.status as string, origin: r.origin as Place | null, adults: r.adults as number, startDate: r.start_date as string | null, endDate: r.end_date as string | null,
    flexDays: r.flex_days as number, budgetTotal: r.budget_total === null ? null : Number(r.budget_total), currency: r.currency as string,
    planStatus: r.plan_status as string, planMessage: r.plan_message as string | null, version: r.version as number, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export type Trip = ReturnType<typeof tripFromRow>;
export interface Stop { id: string; position: number; place: Place; arriveDate: string; departDate: string }

/** Loads a trip only if it belongs to the user. Returns 404 (not 403) for other users' trips to avoid disclosure. */
export async function getOwnedTrip(ctx: AppContext | { db: Queryable }, userId: string, tripId: string, forUpdate = false): Promise<Trip> {
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) throw new HttpError(404, 'not_found', 'Trip not found');
  const r = await ctx.db.query(`SELECT * FROM trips WHERE id=$1 AND user_id=$2 ${forUpdate ? 'FOR UPDATE' : ''}`, [tripId, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Trip not found');
  return tripFromRow(r.rows[0]);
}

export async function getStops(db: Queryable, tripId: string): Promise<Stop[]> {
  const r = await db.query<any>('SELECT id, position, place, arrive_date, depart_date FROM trip_stops WHERE trip_id=$1 ORDER BY position', [tripId]);
  return r.rows.map((s) => ({ id: s.id, position: s.position, place: s.place, arriveDate: s.arrive_date, departDate: s.depart_date }));
}

function validateStops(stops: StopInput[], start: string | null | undefined, end: string | null | undefined) {
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s.departDate < s.arriveDate) throw new HttpError(400, 'invalid_input', `${s.place.name}: departure is before arrival`);
    if (i > 0 && s.arriveDate !== stops[i - 1].departDate) throw new HttpError(400, 'invalid_input', `${s.place.name} must start on the day you leave ${stops[i - 1].place.name}, so every night is covered`);
  }
  if (stops.length && start && stops[0].arriveDate !== start) throw new HttpError(400, 'invalid_input', 'The first stop must start on the trip start date');
  if (stops.length && end && stops[stops.length - 1].departDate !== end) throw new HttpError(400, 'invalid_input', 'The last stop must end on the trip end date');
}

export async function listTrips(ctx: AppContext, userId: string) {
  const r = await ctx.db.query(`SELECT * FROM trips WHERE user_id=$1 ORDER BY COALESCE(start_date, '9999-12-31'::date), updated_at DESC`, [userId]);
  return r.rows.map(tripFromRow);
}

export async function createTrip(ctx: AppContext, userId: string, i: TripInput) {
  const stops = i.stops ?? [];
  validateStops(stops, i.startDate, i.endDate);
  return ctx.db.tx(async (q) => {
    const prof = await q.query<{ currency: string; budget_total: string | null }>('SELECT currency, budget_total FROM profiles WHERE user_id=$1', [userId]);
    const r = await q.query(
      `INSERT INTO trips(user_id, title, origin, adults, start_date, end_date, flex_days, budget_total, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [userId, i.title || 'New trip', i.origin ?? null, i.adults ?? 1, i.startDate ?? null, i.endDate ?? null, i.flexDays ?? 0, i.budgetTotal ?? prof.rows[0]?.budget_total ?? null, i.currency ?? prof.rows[0]?.currency ?? 'EUR']);
    const trip = tripFromRow(r.rows[0]);
    for (const [idx, s] of stops.entries()) await q.query('INSERT INTO trip_stops(trip_id, position, place, arrive_date, depart_date) VALUES ($1,$2,$3,$4,$5)', [trip.id, idx, s.place, s.arriveDate, s.departDate]);
    return trip;
  });
}

/** Autosave endpoint: rejects stale writes with 409 and returns the server copy so the client can resolve the conflict. */
export async function updateTrip(ctx: AppContext, userId: string, tripId: string, expectedVersion: number, i: TripInput) {
  return ctx.db.tx(async (q) => {
    const cur = await getOwnedTrip({ db: q }, userId, tripId, true);
    if (cur.version !== expectedVersion) {
      throw new HttpError(409, 'version_conflict', 'This trip was changed in another window or device.', { details: { server: { ...cur, stops: await getStops(q, tripId) } } });
    }
    const merged = { ...cur, ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) } as Trip & TripInput;
    if (merged.startDate && merged.endDate && merged.endDate < merged.startDate) throw new HttpError(400, 'invalid_input', 'End date is before start date');
    if (i.stops) validateStops(i.stops, merged.startDate, merged.endDate);
    const datesChanged = i.startDate !== undefined && i.startDate !== cur.startDate || i.endDate !== undefined && i.endDate !== cur.endDate || i.stops !== undefined;
    const r = await q.query(
      `UPDATE trips SET title=$3, origin=$4, adults=$5, start_date=$6, end_date=$7, flex_days=$8, budget_total=$9, currency=$10, status=$11,
         plan_status = CASE WHEN $12 AND plan_status IN ('complete','incomplete') THEN 'incomplete' ELSE plan_status END,
         plan_message = CASE WHEN $12 AND plan_status IN ('complete','incomplete') THEN 'Trip details changed; regenerate affected days.' ELSE plan_message END,
         version=version+1, updated_at=now()
       WHERE id=$1 AND user_id=$2 RETURNING *`,
      [tripId, userId, merged.title, merged.origin ?? null, merged.adults, merged.startDate ?? null, merged.endDate ?? null, merged.flexDays, merged.budgetTotal ?? null, merged.currency, merged.status, datesChanged]);
    if (i.stops) {
      // Keep existing stop ids where the place is unchanged so offers/itinerary links survive edits.
      const existing = await getStops(q, tripId);
      const keep = new Set<string>();
      for (const [idx, s] of i.stops.entries()) {
        const match = existing.find((e) => !keep.has(e.id) && e.place.name === s.place.name && Math.abs(e.place.lat - s.place.lat) < 1e-4);
        if (match) { keep.add(match.id); await q.query('UPDATE trip_stops SET position=$2, arrive_date=$3, depart_date=$4, place=$5 WHERE id=$1', [match.id, idx, s.arriveDate, s.departDate, s.place]); }
        else { const ins = await q.query<{ id: string }>('INSERT INTO trip_stops(trip_id, position, place, arrive_date, depart_date) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tripId, idx, s.place, s.arriveDate, s.departDate]); keep.add(ins.rows[0].id); }
      }
      for (const e of existing) if (!keep.has(e.id)) await q.query('DELETE FROM trip_stops WHERE id=$1', [e.id]);
    }
    return { ...tripFromRow(r.rows[0]), stops: await getStops(q, tripId) };
  });
}

export async function deleteTrip(ctx: AppContext, userId: string, tripId: string) {
  await getOwnedTrip(ctx, userId, tripId);
  await ctx.db.query(`UPDATE notifications SET status='cancelled', updated_at=now() WHERE trip_id=$1 AND status='scheduled'`, [tripId]);
  await ctx.db.query(`UPDATE jobs SET status='cancelled' WHERE status='queued' AND payload->>'tripId'=$1`, [tripId]);
  await ctx.db.query('DELETE FROM trips WHERE id=$1 AND user_id=$2', [tripId, userId]);
}

export async function getTripDetail(ctx: AppContext, userId: string, tripId: string) {
  const trip = await getOwnedTrip(ctx, userId, tripId);
  const stops = await getStops(ctx.db, tripId);
  const days = (await ctx.db.query<any>('SELECT * FROM itinerary_days WHERE trip_id=$1 ORDER BY day_date', [tripId])).rows;
  const items = days.length ? (await ctx.db.query<any>('SELECT * FROM itinerary_items WHERE day_id = ANY($1::uuid[]) ORDER BY position', [days.map((d) => d.id)])).rows : [];
  const sources = (await ctx.db.query<any>('SELECT id, url, title, provider, retrieved_at FROM research_sources WHERE trip_id=$1', [tripId])).rows;
  const srcById = new Map(sources.map((s) => [s.id, { url: s.url, title: s.title, provider: s.provider, retrievedAt: s.retrieved_at }]));
  const offers = (await ctx.db.query<any>(`SELECT * FROM offers WHERE trip_id=$1 AND (role IS NOT NULL OR selected) ORDER BY kind, quoted_at DESC`, [tripId])).rows;
  const reservations = (await ctx.db.query<any>('SELECT * FROM reservations WHERE trip_id=$1 AND user_id=$2 ORDER BY start_at NULLS LAST', [tripId, userId])).rows;
  return {
    trip, stops,
    days: days.map((d) => ({
      id: d.id, date: d.day_date, stopId: d.stop_id, timeZone: d.time_zone, status: d.status, missing: d.missing, notes: d.notes, weather: d.weather, generatedAt: d.generated_at, version: d.version,
      items: items.filter((i) => i.day_id === d.id).map((i) => ({
        id: i.id, kind: i.kind, startLocal: i.start_local, endLocal: i.end_local, title: i.title, venue: i.venue, why: i.why,
        bookingRequired: i.booking_required, uncertainty: i.uncertainty, retrievedAt: i.retrieved_at, locked: i.locked,
        sources: (i.source_ids as string[]).map((id) => srcById.get(id)).filter(Boolean),
      })),
    })),
    offers: offers.map(offerFromRow),
    reservations: reservations.map(reservationFromRow),
  };
}

export function offerFromRow(o: any) {
  return { id: o.id, kind: o.kind, stopId: o.stop_id, searchId: o.search_id, provider: o.provider, data: o.data, total: { amount: Number(o.total_amount), currency: o.currency }, quotedAt: o.quoted_at, expiresAt: o.expires_at, role: o.role, explanation: o.explanation, selected: o.selected };
}

export function reservationFromRow(r: any) {
  return { id: r.id, tripId: r.trip_id, kind: r.kind, providerName: r.provider_name, confirmationCode: r.confirmation_code, details: r.details, startAt: r.start_at, endAt: r.end_at, source: r.source, sourceRef: r.source_ref, extractionConfidence: r.extraction_confidence === null ? null : Number(r.extraction_confidence), reviewStatus: r.review_status, checkinStatus: r.checkin_status, updatedAt: r.updated_at };
}
