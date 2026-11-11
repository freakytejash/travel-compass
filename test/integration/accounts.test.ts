// MOCKED integration tests (real DB + HTTP; providers mocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, signUp, type Harness } from '../helpers/harness.ts';
import { PLACES } from '../helpers/mocks.ts';

let h: Harness;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

test('registration requires email verification; login, logout, recovery', async () => {
  const c = h.client();
  assert.equal((await c.post('/api/auth/register', { email: 'ana@example.com', password: 'short', displayName: 'Ana' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'ana@example.com', password: 'a long enough secret', displayName: 'Ana' })).status, 200);
  // Re-registering does not reveal the account exists.
  assert.equal((await c.post('/api/auth/register', { email: 'ana@example.com', password: 'another long secret', displayName: 'Ana' })).status, 200);
  const blocked = await c.post('/api/auth/login', { email: 'ana@example.com', password: 'a long enough secret' });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'email_not_verified');
  const token = h.mocks.mailer.lastLink('ana@example.com', '/verify-email');
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 200);
  assert.equal((await c.post('/api/auth/verify-email', { token })).status, 400, 'token is single-use');
  assert.equal((await c.get('/api/session')).body.user.email, 'ana@example.com');
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/session')).body.user, null);
  assert.equal((await c.post('/api/auth/login', { email: 'ana@example.com', password: 'wrong password!!' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'ana@example.com', password: 'a long enough secret' })).status, 200);
  // Password recovery invalidates other sessions.
  const other = h.client();
  await other.post('/api/auth/forgot-password', { email: 'ana@example.com' });
  const reset = h.mocks.mailer.lastLink('ana@example.com', '/reset-password');
  assert.equal((await other.post('/api/auth/reset-password', { token: reset, password: 'brand new passphrase' })).status, 200);
  assert.equal((await c.get('/api/profile')).status, 401, 'old session revoked');
  assert.equal((await other.post('/api/auth/login', { email: 'ana@example.com', password: 'brand new passphrase' })).status, 200);
});

test('CSRF and origin checks protect state-changing requests', async () => {
  const c = await signUp(h, 'csrf@example.com');
  const noToken = await c.req('POST', '/api/trips', { title: 'x' }, { 'X-CSRF-Token': 'wrong' });
  assert.equal(noToken.status, 403);
  const crossSite = await c.req('POST', '/api/trips', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  assert.equal((await c.post('/api/trips', { title: 'ok' })).status, 200);
});

test('two customers have strictly separate data (server-enforced)', async () => {
  const a = await signUp(h, 'alice@example.com');
  const b = await signUp(h, 'bob@example.com');
  const t = (await a.post('/api/trips', { title: 'Alice in Barcelona', origin: PLACES.BRU, startDate: '2027-03-10', endDate: '2027-03-14', stops: [{ place: PLACES.BCN, arriveDate: '2027-03-10', departDate: '2027-03-14' }] })).body;
  assert.ok(t.id);
  assert.equal((await b.get(`/api/trips/${t.id}`)).status, 404);
  assert.equal((await b.patch(`/api/trips/${t.id}`, { version: 1, changes: { title: 'pwned' } })).status, 404);
  assert.equal((await b.del(`/api/trips/${t.id}`)).status, 404);
  assert.equal((await b.post(`/api/trips/${t.id}/searches`, { kind: 'flight' })).status, 404);
  assert.equal((await b.post(`/api/trips/${t.id}/plan`, {})).status, 404);
  assert.deepEqual((await b.get('/api/trips')).body, []);
  const s = (await a.post(`/api/trips/${t.id}/searches`, { kind: 'flight' })).body.searchId;
  await h.worker.drain();
  assert.equal((await b.get(`/api/searches/${s}`)).status, 404);
  const offerId = (await a.get(`/api/searches/${s}`)).body.offers[0].id;
  assert.equal((await b.post(`/api/offers/${offerId}/select`)).status, 404);
  const res = (await a.post('/api/reservations', { kind: 'other', providerName: 'Museum', confirmationCode: 'AB12CD' })).body;
  assert.equal((await b.patch(`/api/reservations/${res.id}`, { reviewStatus: 'confirmed' })).status, 404);
  assert.equal((await b.del(`/api/reservations/${res.id}`)).status, 404);
  assert.equal((await b.get('/api/admin/readiness')).status, 404, 'customers cannot see admin endpoints');
  assert.equal((await a.get('/api/trips')).body.length, 1);
});

test('trips persist across sessions; autosave detects conflicting edits', async () => {
  const c = await signUp(h, 'carol@example.com', 'carols long password');
  const t = (await c.post('/api/trips', { title: 'Porto', startDate: '2027-04-01', endDate: '2027-04-04', stops: [{ place: PLACES.OPO, arriveDate: '2027-04-01', departDate: '2027-04-04' }] })).body;
  const tab1 = await c.patch(`/api/trips/${t.id}`, { version: 1, changes: { title: 'Porto long weekend' } });
  assert.equal(tab1.status, 200); assert.equal(tab1.body.version, 2);
  const tab2 = await c.patch(`/api/trips/${t.id}`, { version: 1, changes: { title: 'Stale edit' } });
  assert.equal(tab2.status, 409);
  assert.equal(tab2.body.error.details.server.title, 'Porto long weekend');
  await c.post('/api/auth/logout');
  const again = h.client();
  await again.post('/api/auth/login', { email: 'carol@example.com', password: 'carols long password' });
  const detail = (await again.get(`/api/trips/${t.id}`)).body;
  assert.equal(detail.trip.title, 'Porto long weekend');
  assert.equal(detail.stops[0].place.name, 'Porto');
});

test('stops must chain so every night is covered', async () => {
  const c = await signUp(h, 'gap@example.com');
  const r = await c.post('/api/trips', { title: 'Gap', startDate: '2027-05-01', endDate: '2027-05-07', stops: [{ place: PLACES.LIS, arriveDate: '2027-05-01', departDate: '2027-05-03' }, { place: PLACES.OPO, arriveDate: '2027-05-04', departDate: '2027-05-07' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /every night/);
});

test('account export and deletion', async () => {
  const c = await signUp(h, 'dan@example.com');
  await c.put('/api/profile', { diet: 'vegetarian', allergies: ['peanuts'], interests: ['food', 'hiking'] });
  await c.post('/api/trips', { title: 'Export me' });
  const ex = await c.get('/api/account/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.body.profile.diet, 'vegetarian');
  assert.equal(ex.body.trips[0].title, 'Export me');
  assert.ok(!JSON.stringify(ex.body).includes('password_hash'));
  assert.equal((await c.post('/api/account/delete', { confirm: 'nope' })).status, 400);
  assert.equal((await c.post('/api/account/delete', { confirm: 'DELETE' })).status, 200);
  const left = await h.ctx.db.query(`SELECT count(*)::int AS n FROM trips t JOIN users u ON u.id=t.user_id WHERE u.email='dan@example.com'`);
  assert.equal(left.rows[0].n, 0);
  assert.equal((await c.get('/api/profile')).status, 401);
});
