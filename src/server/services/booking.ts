// Assisted booking: select → reprice/revalidate → traveller details (sealed) → explicit acknowledgement → provider handoff.
// Travel Compass never takes payment, never stores card data and never creates a binding booking itself.
import type { AppContext } from '../context.ts';
import { requireSealer } from '../context.ts';
import { HttpError } from '../http/core.ts';
import { compareReprice } from '../domain/flights.ts';
import type { FlightOffer, StayOption } from '../../shared/types.ts';
import { getOwnedTrip, getStops } from './trips.ts';
import { scheduleTripNotifications } from './notifications.ts';

async function ownedOffer(ctx: AppContext, userId: string, offerId: string) {
  const r = await ctx.db.query<any>('SELECT o.* FROM offers o JOIN trips t ON t.id=o.trip_id WHERE o.id=$1 AND t.user_id=$2', [offerId, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Offer not found');
  return r.rows[0];
}

async function ownedSession(ctx: AppContext, userId: string, id: string) {
  const r = await ctx.db.query<any>('SELECT * FROM booking_sessions WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rows.length) throw new HttpError(404, 'not_found', 'Booking session not found');
  return r.rows[0];
}

function view(s: any) {
  return { id: s.id, tripId: s.trip_id, offerId: s.offer_id, state: s.state, originalAmount: Number(s.original_amount), repricedAmount: s.repriced_amount === null ? null : Number(s.repriced_amount), currency: s.currency, conditions: s.conditions, handoff: s.handoff, customerAcknowledgedAt: s.customer_ack_at, providerOrderRef: s.provider_order_ref, error: s.error, hasTravellerDetails: !!s.traveller_details_enc, updatedAt: s.updated_at };
}

/** Selecting an offer marks it as the trip's chosen option (used by itinerary timing) and opens a booking session. */
export async function selectOffer(ctx: AppContext, userId: string, offerId: string) {
  const o = await ownedOffer(ctx, userId, offerId);
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE offers SET selected=false WHERE trip_id=$1 AND kind=$2 AND ($2='flight' OR stop_id IS NOT DISTINCT FROM $3)`, [o.trip_id, o.kind, o.stop_id]);
    await q.query('UPDATE offers SET selected=true WHERE id=$1', [o.id]);
    await q.query(`UPDATE booking_sessions SET state='cancelled', updated_at=now() WHERE user_id=$1 AND trip_id=$2 AND state IN ('selected','repriced','price_changed','details_collected','ready_for_handoff') AND offer_id IN (SELECT id FROM offers WHERE trip_id=$2 AND kind=$3 AND id<>$4)`, [userId, o.trip_id, o.kind, o.id]);
  });
  if (o.kind === 'flight') await scheduleTripNotifications(ctx, userId, o.trip_id).catch(() => {});
  const r = await ctx.db.query<any>(`INSERT INTO booking_sessions(user_id, trip_id, offer_id, state, original_amount, currency, conditions) VALUES ($1,$2,$3,'selected',$4,$5,$6) RETURNING *`,
    [userId, o.trip_id, o.id, o.total_amount, o.currency, o.kind === 'flight' ? o.data.offer.conditions : o.data.stay.cancellation]);
  return view(r.rows[0]);
}

export async function getBookingSession(ctx: AppContext, userId: string, id: string) { return view(await ownedSession(ctx, userId, id)); }

/** Re-fetches the offer from the provider. Expired or changed offers are never handed off silently. */
export async function reprice(ctx: AppContext, userId: string, id: string) {
  const s = await ownedSession(ctx, userId, id);
  if (['handed_off', 'completed', 'cancelled'].includes(s.state)) throw new HttpError(409, 'invalid_state', `This booking is already ${s.state.replace('_', ' ')}.`);
  const o = await ownedOffer(ctx, userId, s.offer_id);
  const trip = await getOwnedTrip(ctx, userId, s.trip_id);
  let fresh: { total: { amount: number; currency: string }; conditions: unknown; expiresAt: string | null } | null = null;
  let freshFlight: FlightOffer | null = null;
  if (o.kind === 'flight') {
    const f: FlightOffer | null = await ctx.providers.flights.getOffer(o.provider_offer_id, trip.currency);
    if (f && !(f.expiresAt && new Date(f.expiresAt) <= ctx.now())) { fresh = { total: f.total, conditions: f.conditions, expiresAt: f.expiresAt }; freshFlight = f; }
  } else {
    const provider = ctx.providers.stays.find((p) => p.name === o.provider);
    if (!provider?.configured()) throw new HttpError(503, 'service_unavailable', 'This accommodation provider is not available right now.');
    const stay: StayOption = o.data.stay;
    const stops = await getStops(ctx.db, s.trip_id);
    const st = stops.find((x) => x.id === o.stop_id);
    const f = await provider.refresh(stay, { lat: stay.lat, lng: stay.lng, radiusKm: 1, checkIn: stay.checkIn, checkOut: stay.checkOut, adults: trip.adults, rooms: 1, currency: trip.currency, userId });
    if (f && st) fresh = { total: f.total, conditions: f.cancellation, expiresAt: f.expiresAt };
  }
  const cmp = compareReprice({ amount: Number(s.original_amount), currency: s.currency }, fresh?.total ?? null);
  const state = cmp === 'unavailable' ? 'expired' : cmp === 'increased' ? 'price_changed' : (s.traveller_details_enc ? 'details_collected' : 'repriced');
  const r = await ctx.db.query<any>(`UPDATE booking_sessions SET state=$2, repriced_amount=$3, conditions=COALESCE($4, conditions), error=$5, customer_ack_at=NULL, repriced_at=$6, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, state, fresh?.total.amount ?? null, fresh?.conditions ?? null, cmp === 'unavailable' ? 'This offer is no longer available. Search again for current prices.' : cmp === 'increased' ? `The price increased to ${fresh!.total.currency} ${fresh!.total.amount.toFixed(2)}. Review before continuing.` : null, ctx.now()]);
  if (fresh) await ctx.db.query('UPDATE offers SET total_amount=$2, expires_at=$3, quoted_at=now() WHERE id=$1', [o.id, fresh.total.amount, fresh.expiresAt]);
  // Keep the itinerary itself current (e.g. a price-level offer now expanded with its return flight and booking token).
  if (freshFlight) await ctx.db.query(`UPDATE offers SET data = jsonb_set(data, '{offer}', $2::jsonb), provider_offer_id=$3 WHERE id=$1`, [o.id, JSON.stringify(freshFlight), freshFlight.providerOfferId]);
  return view(r.rows[0]);
}

export async function saveTravellerDetails(ctx: AppContext, userId: string, id: string, travellers: { givenName: string; familyName: string; bornOn: string; email: string; phone: string; title: string; gender: string }[]) {
  const s = await ownedSession(ctx, userId, id);
  if (!['repriced', 'details_collected', 'price_changed'].includes(s.state)) throw new HttpError(409, 'invalid_state', 'Refresh the price before entering traveller details.');
  const trip = await getOwnedTrip(ctx, userId, s.trip_id);
  if (travellers.length !== trip.adults) throw new HttpError(400, 'invalid_input', `Enter details for ${trip.adults} traveller(s).`);
  const sealed = requireSealer(ctx).seal(JSON.stringify(travellers));
  const r = await ctx.db.query<any>(`UPDATE booking_sessions SET traveller_details_enc=$2, state=CASE WHEN state='price_changed' THEN state ELSE 'details_collected' END, updated_at=now() WHERE id=$1 RETURNING *`, [id, sealed]);
  return view(r.rows[0]);
}

/**
 * Customer explicitly acknowledges the final price and conditions for this specific offer, then we prepare the provider
 * handoff. No payment or binding reservation is made by Travel Compass.
 */
export async function acknowledgeAndHandoff(ctx: AppContext, userId: string, id: string, ack: { acceptedAmount: number; acceptedCurrency: string; acceptConditions: boolean }) {
  const s = await ownedSession(ctx, userId, id);
  if (!ack.acceptConditions) throw new HttpError(400, 'ack_required', 'Please confirm you have reviewed the price and conditions.');
  if (!['repriced', 'details_collected', 'price_changed'].includes(s.state)) throw new HttpError(409, 'invalid_state', 'Refresh the price first.');
  const price = Number(s.repriced_amount ?? NaN);
  if (!Number.isFinite(price) || Math.abs(price - ack.acceptedAmount) > 0.005 || ack.acceptedCurrency !== s.currency) throw new HttpError(409, 'price_mismatch', 'The price changed since you reviewed it. Please review the new price.');
  if (!s.repriced_at || new Date(s.repriced_at).getTime() < ctx.now().getTime() - 20 * 60_000) throw new HttpError(409, 'quote_stale', 'The price check is more than 20 minutes old. Refresh it before continuing.');
  const o = await ownedOffer(ctx, userId, s.offer_id);
  let handoff;
  if (o.kind === 'flight' && o.provider !== 'duffel' && ctx.providers.flights.handoff) {
    handoff = await ctx.providers.flights.handoff(o.data.offer);
  } else if (o.kind === 'flight') {
    if (ctx.providers.checkout.configured()) {
      const base = `${ctx.cfg.appUrl}/trips/${s.trip_id}/bookings?session=${s.id}`;
      const sess = await ctx.providers.checkout.createSession({ reference: s.id, currency: s.currency, successUrl: `${base}&result=success`, failureUrl: `${base}&result=failure`, abandonmentUrl: `${base}&result=abandoned` });
      const offer: FlightOffer = o.data.offer;
      handoff = { type: 'hosted_checkout', url: sess.url, provider: 'Duffel', note: `On Duffel's secure checkout, search ${offer.slices.map((x) => `${x.from}→${x.to} on ${x.segments[0].departLocal.slice(0, 10)}`).join(' and ')} and choose ${offer.slices.map((x) => x.segments.map((g) => g.flightNumber).join('+')).join(' / ')}. The price shown there is final and may differ from the price checked here. You pay on Duffel's page; Travel Compass never sees your card.` };
    } else {
      handoff = { type: 'unsupported', provider: 'Duffel', reason: 'Online checkout for flights is not enabled yet. You can book this exact flight directly with the airline using the flight numbers shown.' };
    }
  } else {
    const provider = ctx.providers.stays.find((p) => p.name === o.provider);
    handoff = provider ? await provider.handoff(o.data.stay) : { type: 'unsupported', provider: o.provider, reason: 'Provider not available.' };
  }
  const state = handoff.type === 'unsupported' ? 'failed' : 'ready_for_handoff';
  const r = await ctx.db.query<any>(`UPDATE booking_sessions SET state=$2, handoff=$3, customer_ack_at=now(), error=$4, updated_at=now() WHERE id=$1 RETURNING *`, [id, state, handoff, handoff.type === 'unsupported' ? (handoff as any).reason : null]);
  return view(r.rows[0]);
}

export async function markHandedOff(ctx: AppContext, userId: string, id: string) {
  const r = await ctx.db.query<any>(`UPDATE booking_sessions SET state='handed_off', updated_at=now() WHERE id=$1 AND user_id=$2 AND state='ready_for_handoff' RETURNING *`, [id, userId]);
  if (!r.rows.length) throw new HttpError(409, 'invalid_state', 'This booking is not ready for handoff.');
  return view(r.rows[0]);
}

/** Return from the provider. Only an order verified with the provider API is recorded as a booking. */
export async function completeFromProvider(ctx: AppContext, userId: string, id: string, orderId: string | null, result: string) {
  const s = await ownedSession(ctx, userId, id);
  if (s.state === 'completed') return view(s);
  if (result !== 'success' || !orderId) {
    const r = await ctx.db.query<any>(`UPDATE booking_sessions SET state=CASE WHEN state='handed_off' THEN 'ready_for_handoff' ELSE state END, error=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, result === 'abandoned' ? 'Checkout was not completed. No booking was made.' : 'The provider reported that the booking did not complete.']);
    return view(r.rows[0]);
  }
  const order = await ctx.providers.checkout.getOrder(orderId);
  if (!order) throw new HttpError(400, 'order_not_found', 'The provider could not confirm this booking.');
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE booking_sessions SET state='completed', provider_order_ref=$2, error=NULL, updated_at=now() WHERE id=$1`, [id, order.id]);
    await q.query(`INSERT INTO reservations(user_id, trip_id, kind, provider_name, confirmation_code, details, source, source_ref, dedupe_key, extraction_confidence, review_status, checkin_status)
      VALUES ($1,$2,'flight','Duffel',$3,$4,'booking_flow',$5,$6,1,'confirmed','unknown') ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
      [userId, s.trip_id, order.bookingReference, { orderId: order.id, total: order.total }, order.id, `flight:${(order.bookingReference ?? order.id).toUpperCase()}`]);
    await q.query(`UPDATE trips SET status='booked', updated_at=now() WHERE id=$1 AND status IN ('draft','planned')`, [s.trip_id]);
  });
  return view(await ownedSession(ctx, userId, id));
}

export async function cancelSession(ctx: AppContext, userId: string, id: string) {
  const r = await ctx.db.query<any>(`UPDATE booking_sessions SET state='cancelled', traveller_details_enc=NULL, updated_at=now() WHERE id=$1 AND user_id=$2 AND state NOT IN ('completed') RETURNING *`, [id, userId]);
  if (!r.rows.length) throw new HttpError(409, 'invalid_state', 'This booking cannot be cancelled here.');
  return view(r.rows[0]);
}
