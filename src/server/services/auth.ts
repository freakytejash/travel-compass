// Accounts: registration with verified email, password login, Google sign-in, recovery, sessions, export, deletion.
import crypto from 'node:crypto';
import type { AppContext } from '../context.ts';
import { HttpError, type AuthUser } from '../http/core.ts';
import { GoogleOAuth } from '../integrations/google.ts';
import { NotConfiguredError } from '../integrations/http.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from '../secrets.ts';

export const SESSION_COOKIE = 'tc_session';

function passwordPolicy(pw: string) {
  if (pw.length < 10) throw new HttpError(400, 'weak_password', 'Use at least 10 characters.');
  if (pw.length > 200) throw new HttpError(400, 'weak_password', 'Password is too long.');
  if (/^(.)\1+$/.test(pw) || /^(password|1234567890|qwertyuiop)/i.test(pw)) throw new HttpError(400, 'weak_password', 'Choose a less predictable password.');
}

async function issueEmailToken(ctx: AppContext, userId: string, purpose: 'verify_email' | 'reset_password', ttlMin: number) {
  const token = randomToken();
  await ctx.db.query(`UPDATE email_tokens SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL`, [userId, purpose]);
  await ctx.db.query(`INSERT INTO email_tokens(user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [userId, purpose, sha256(token), new Date(ctx.now().getTime() + ttlMin * 60000)]);
  return token;
}

export async function register(ctx: AppContext, i: { email: string; password: string; displayName: string }) {
  // Never create accounts that cannot be verified.
  if (ctx.cfg.isProd && !ctx.providers.mailer.configured()) throw new NotConfiguredError('Email', ['BREVO_API_KEY or RESEND_API_KEY']);
  passwordPolicy(i.password);
  const hash = await hashPassword(i.password);
  const existing = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower($1)', [i.email]);
  // Same response whether or not the account exists, to avoid account enumeration.
  if (existing.rows.length) {
    await ctx.providers.mailer.send({ to: i.email, subject: 'Travel Compass sign-up attempt', text: 'Someone tried to create a Travel Compass account with this email. If it was you, sign in or reset your password instead.' }).catch(() => {});
    return;
  }
  const role = ctx.cfg.adminEmails.includes(i.email.toLowerCase()) ? 'admin' : 'customer';
  const u = await ctx.db.tx(async (q) => {
    const r = await q.query<{ id: string }>(`INSERT INTO users(email, password_hash, display_name, role) VALUES ($1,$2,$3,$4) RETURNING id`, [i.email, hash, i.displayName, role]);
    await q.query(`INSERT INTO profiles(user_id) VALUES ($1)`, [r.rows[0].id]);
    return r.rows[0];
  });
  const token = await issueEmailToken(ctx, u.id, 'verify_email', 60 * 24);
  await ctx.providers.mailer.send({ to: i.email, subject: 'Verify your Travel Compass email', text: `Welcome to Travel Compass. Verify your email: ${ctx.cfg.appUrl}/verify-email?token=${token}\nThis link expires in 24 hours.` });
}

export async function resendVerification(ctx: AppContext, email: string) {
  const r = await ctx.db.query<{ id: string; email_verified_at: Date | null }>('SELECT id, email_verified_at FROM users WHERE lower(email)=lower($1)', [email]);
  const u = r.rows[0];
  if (!u || u.email_verified_at) return;
  const token = await issueEmailToken(ctx, u.id, 'verify_email', 60 * 24);
  await ctx.providers.mailer.send({ to: email, subject: 'Verify your Travel Compass email', text: `Verify your email: ${ctx.cfg.appUrl}/verify-email?token=${token}` });
}

async function consumeToken(ctx: AppContext, token: string, purpose: string): Promise<string> {
  const r = await ctx.db.query<{ user_id: string }>(
    `UPDATE email_tokens SET used_at=now() WHERE token_hash=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id`, [sha256(token), purpose, ctx.now()]);
  if (!r.rows.length) throw new HttpError(400, 'invalid_token', 'This link is invalid or has expired. Request a new one.');
  return r.rows[0].user_id;
}

export async function verifyEmail(ctx: AppContext, token: string) {
  const userId = await consumeToken(ctx, token, 'verify_email');
  await ctx.db.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()), updated_at=now() WHERE id=$1', [userId]);
  return userId;
}

export async function login(ctx: AppContext, email: string, password: string) {
  const r = await ctx.db.query<{ id: string; password_hash: string | null; email_verified_at: Date | null }>('SELECT id, password_hash, email_verified_at FROM users WHERE lower(email)=lower($1)', [email]);
  const u = r.rows[0];
  // Constant-ish work even when the user does not exist.
  const ok = u?.password_hash ? await verifyPassword(password, u.password_hash) : (await hashPassword(password), false);
  if (!u || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
  if (!u.email_verified_at) throw new HttpError(403, 'email_not_verified', 'Please verify your email first. We can send a new link.');
  return u.id;
}

export async function requestPasswordReset(ctx: AppContext, email: string) {
  const r = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
  if (!r.rows.length) return;
  const token = await issueEmailToken(ctx, r.rows[0].id, 'reset_password', 60);
  await ctx.providers.mailer.send({ to: email, subject: 'Reset your Travel Compass password', text: `Reset your password: ${ctx.cfg.appUrl}/reset-password?token=${token}\nThis link expires in 1 hour. If you did not request it, ignore this email.` });
}

export async function resetPassword(ctx: AppContext, token: string, password: string) {
  passwordPolicy(password);
  const userId = await consumeToken(ctx, token, 'reset_password');
  await ctx.db.query('UPDATE users SET password_hash=$2, email_verified_at=COALESCE(email_verified_at, now()), updated_at=now() WHERE id=$1', [userId, await hashPassword(password)]);
  await ctx.db.query('DELETE FROM sessions WHERE user_id=$1', [userId]); // sign out everywhere
}

export async function changePassword(ctx: AppContext, userId: string, current: string, next: string, keepSessionId: string) {
  passwordPolicy(next);
  const r = await ctx.db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id=$1', [userId]);
  if (r.rows[0]?.password_hash && !(await verifyPassword(current, r.rows[0].password_hash))) throw new HttpError(401, 'invalid_credentials', 'Current password is incorrect.');
  await ctx.db.query('UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1', [userId, await hashPassword(next)]);
  await ctx.db.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [userId, keepSessionId]);
}

export async function createSession(ctx: AppContext, userId: string, userAgent: string | undefined) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expires = new Date(ctx.now().getTime() + ctx.cfg.sessionDays * 86400000);
  await ctx.db.query('INSERT INTO sessions(id, user_id, csrf_token, expires_at, user_agent) VALUES ($1,$2,$3,$4,$5)', [sha256(token), userId, csrf, expires, (userAgent ?? '').slice(0, 300)]);
  return { token, csrf, maxAgeSec: ctx.cfg.sessionDays * 86400 };
}

export async function loadSession(ctx: AppContext, token: string | undefined): Promise<{ user: AuthUser; sessionId: string; csrf: string } | null> {
  if (!token || token.length > 100) return null;
  const r = await ctx.db.query<any>(
    `UPDATE sessions s SET last_seen_at=now() FROM users u WHERE s.id=$1 AND s.user_id=u.id AND s.expires_at > $2
     RETURNING s.id, s.csrf_token, u.id AS user_id, u.email, u.role, u.display_name, u.email_verified_at`, [sha256(token), ctx.now()]);
  const row = r.rows[0];
  if (!row) return null;
  return { sessionId: row.id, csrf: row.csrf_token, user: { id: row.user_id, email: row.email, role: row.role, displayName: row.display_name, emailVerified: !!row.email_verified_at } };
}

export async function destroySession(ctx: AppContext, sessionId: string) {
  await ctx.db.query('DELETE FROM sessions WHERE id=$1', [sessionId]);
}

// ---- Google sign-in (OIDC via authorization code + PKCE) ----
export function googleOAuth(ctx: AppContext) { return new GoogleOAuth(ctx.cfg.google.clientId, ctx.cfg.google.clientSecret); }

export async function startOAuth(ctx: AppContext, purpose: 'google_login' | 'gmail_connect', userId: string | null, scope: string, loginHint?: string) {
  const oauth = googleOAuth(ctx);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  await ctx.db.query('INSERT INTO oauth_states(state_hash, purpose, user_id, code_verifier, expires_at) VALUES ($1,$2,$3,$4,$5)', [sha256(state), purpose, userId, ctx.sealer ? ctx.sealer.seal(verifier) : verifier, new Date(ctx.now().getTime() + 10 * 60000)]);
  return oauth.authUrl({ redirectUri: `${ctx.cfg.appUrl}/api/oauth/google/callback`, scope, state, codeChallenge: challenge, offline: purpose === 'gmail_connect', loginHint });
}

export async function consumeOAuthState(ctx: AppContext, state: string) {
  const r = await ctx.db.query<{ purpose: 'google_login' | 'gmail_connect'; user_id: string | null; code_verifier: string }>(
    'DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at > $2 RETURNING purpose, user_id, code_verifier', [sha256(state), ctx.now()]);
  if (!r.rows.length) throw new HttpError(400, 'invalid_state', 'Sign-in session expired. Please try again.');
  const row = r.rows[0];
  return { ...row, code_verifier: ctx.sealer ? ctx.sealer.open(row.code_verifier) : row.code_verifier };
}

export async function googleLogin(ctx: AppContext, code: string, verifier: string): Promise<string> {
  const oauth = googleOAuth(ctx);
  const tok = await oauth.exchange(code, `${ctx.cfg.appUrl}/api/oauth/google/callback`, verifier);
  const info = await oauth.userInfo(tok.access_token);
  if (!info.email_verified) throw new HttpError(403, 'email_not_verified', 'Your Google email address is not verified.');
  const bySub = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE google_sub=$1', [info.sub]);
  if (bySub.rows.length) return bySub.rows[0].id;
  const byEmail = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=lower($1)', [info.email]);
  if (byEmail.rows.length) {
    // Google has verified the address, so linking is safe.
    await ctx.db.query('UPDATE users SET google_sub=$2, email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1', [byEmail.rows[0].id, info.sub]);
    return byEmail.rows[0].id;
  }
  const role = ctx.cfg.adminEmails.includes(info.email.toLowerCase()) ? 'admin' : 'customer';
  return ctx.db.tx(async (q) => {
    const r = await q.query<{ id: string }>('INSERT INTO users(email, google_sub, email_verified_at, display_name, role) VALUES ($1,$2,now(),$3,$4) RETURNING id', [info.email, info.sub, info.name ?? '', role]);
    await q.query('INSERT INTO profiles(user_id) VALUES ($1)', [r.rows[0].id]);
    return r.rows[0].id;
  });
}

// ---- Data rights ----
export async function exportAccount(ctx: AppContext, userId: string) {
  const one = async (sql: string) => (await ctx.db.query(sql, [userId])).rows;
  return {
    exportedAt: ctx.now().toISOString(),
    user: (await one('SELECT id, email, display_name, role, email_verified_at, created_at FROM users WHERE id=$1'))[0],
    profile: (await one('SELECT * FROM profiles WHERE user_id=$1'))[0],
    trips: await one('SELECT * FROM trips WHERE user_id=$1 ORDER BY created_at'),
    tripIdeas: await one('SELECT id, status, params, result, created_at FROM trip_ideas WHERE user_id=$1 ORDER BY created_at'),
    stops: await one('SELECT s.* FROM trip_stops s JOIN trips t ON t.id=s.trip_id WHERE t.user_id=$1'),
    itineraryDays: await one('SELECT d.* FROM itinerary_days d JOIN trips t ON t.id=d.trip_id WHERE t.user_id=$1'),
    itineraryItems: await one('SELECT i.* FROM itinerary_items i JOIN itinerary_days d ON d.id=i.day_id JOIN trips t ON t.id=d.trip_id WHERE t.user_id=$1'),
    researchSources: await one('SELECT r.* FROM research_sources r JOIN trips t ON t.id=r.trip_id WHERE t.user_id=$1'),
    offers: await one('SELECT o.* FROM offers o JOIN trips t ON t.id=o.trip_id WHERE t.user_id=$1'),
    reservations: await one('SELECT * FROM reservations WHERE user_id=$1'),
    notificationChannel: (await one('SELECT phone_e164, verified_at, opted_in_at, opted_out_at, share_booking_refs, pretrip_briefing, daily_schedule, daily_time, pretrip_time FROM notification_channels WHERE user_id=$1'))[0] ?? null,
    notifications: await one('SELECT kind, scheduled_for, status, body_preview, created_at FROM notifications WHERE user_id=$1'),
    connections: await one('SELECT provider, account_email, scopes, connected_at, last_sync_at FROM oauth_connections WHERE user_id=$1'),
    bookingSessions: await one('SELECT id, trip_id, offer_id, state, original_amount, repriced_amount, currency, handoff, created_at FROM booking_sessions WHERE user_id=$1'),
  };
}

export async function deleteAccount(ctx: AppContext, userId: string) {
  // Revoke third-party access first, then delete; ON DELETE CASCADE removes all owned rows.
  const conn = await ctx.db.query<{ access_token_enc: string; refresh_token_enc: string | null }>('SELECT access_token_enc, refresh_token_enc FROM oauth_connections WHERE user_id=$1', [userId]);
  for (const c of conn.rows) {
    try { const t = ctx.sealer?.open(c.refresh_token_enc ?? c.access_token_enc); if (t) await googleOAuth(ctx).revoke(t); } catch { /* best effort */ }
  }
  await ctx.db.query(`UPDATE jobs SET status='cancelled' WHERE status='queued' AND payload->>'userId' = $1`, [userId]);
  await ctx.db.query('DELETE FROM users WHERE id=$1', [userId]);
}
