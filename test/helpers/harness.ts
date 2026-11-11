// Integration-test harness: real PostgreSQL + real HTTP server + MOCK providers.
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool, parseDatabaseUrl } from '../../src/server/db/pg.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { loadConfig } from '../../src/server/config.ts';
import { makeContext, type AppContext } from '../../src/server/context.ts';
import { createApp } from '../../src/server/app.ts';
import { Worker } from '../../src/server/jobs/worker.ts';
import { mockProviders, type MockSet } from './mocks.ts';

process.env.LOG_SILENT = '1';
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://tc:devpass@127.0.0.1:5433/travel_compass_test';

export interface Harness {
  ctx: AppContext; mocks: MockSet; base: string; worker: Worker; clock: { now: Date };
  close(): Promise<void>;
  client(): Client;
}

export async function startHarness(env: Record<string, string> = {}, override: (m: MockSet) => Record<string, unknown> = () => ({})): Promise<Harness> {
  const db = new Pool(parseDatabaseUrl(TEST_DB), 8);
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  Object.assign(process.env, { NODE_ENV: 'test', APP_URL: 'http://localhost', TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', ADMIN_EMAILS: 'admin@example.com', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-me', API_RATE_PER_MINUTE: '10000', AUTH_RATE_PER_MINUTE: '10000', EXPENSIVE_RATE_PER_HOUR: '10000', SESSION_DAYS: '400', ...env });
  const cfg = loadConfig();
  const mocks = mockProviders();
  const clock = { now: new Date('2027-02-01T09:00:00Z') };
  const ctx = makeContext(cfg, db, { ...mocks, ...override(mocks) } as any, () => clock.now);
  const server = http.createServer(createApp(ctx));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = new Worker(ctx);
  return {
    ctx, mocks, base, worker, clock,
    client: () => new Client(base),
    async close() { await new Promise((r) => server.close(r)); await db.end(); },
  };
}

export class Client {
  cookie = ''; csrf = '';
  base: string;
  constructor(base: string) { this.base = base; }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: 'http://localhost', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    for (const c of set) { const [kv] = c.split(';'); const [k, val] = kv.split('='); if (k === 'tc_session') this.cookie = val ? `tc_session=${val}` : ''; }
    if (set.length) await this.refreshCsrf();
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  async refreshCsrf() {
    const r = await fetch(this.base + '/api/session', { headers: this.cookie ? { Cookie: this.cookie } : {} });
    this.csrf = (await r.json()).csrfToken ?? '';
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b: unknown = {}) { return this.req('POST', p, b); }
  put(p: string, b: unknown) { return this.req('PUT', p, b); }
  patch(p: string, b: unknown) { return this.req('PATCH', p, b); }
  del(p: string) { return this.req('DELETE', p); }
}

export async function signUp(h: Harness, email: string, password = 'correct horse battery') {
  const c = h.client();
  const r = await c.post('/api/auth/register', { email, password, displayName: email.split('@')[0] });
  if (r.status !== 200) throw new Error(`register failed ${JSON.stringify(r.body)}`);
  const token = h.mocks.mailer.lastLink(email, '/verify-email');
  const v = await c.post('/api/auth/verify-email', { token });
  if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  return c;
}
