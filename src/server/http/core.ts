// HTTP plumbing: router, JSON bodies, cookies, errors, security headers, static files.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { ValidationError } from './validate.ts';
import { NotConfiguredError, ProviderError, QuotaExceededError } from '../integrations/http.ts';
import { AiBudgetExceeded } from '../integrations/ai.ts';
import { PgError } from '../db/pg.ts';
import { log } from '../log.ts';

export class HttpError extends Error {
  status: number; code: string; retryable: boolean; details?: unknown;
  constructor(status: number, code: string, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(message); this.status = status; this.code = code; this.retryable = opts.retryable ?? false; this.details = opts.details;
  }
}

export interface AuthUser { id: string; email: string; role: 'customer' | 'admin'; displayName: string; emailVerified: boolean }
export interface Session { id: string; csrfToken: string }

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  rawBody: Buffer;
  body: unknown;
  ip: string;
  user: AuthUser | null;
  session: Session | null;
  setCookie(name: string, value: string, opts?: { maxAgeSec?: number; httpOnly?: boolean }): void;
}

export type Handler = (c: Ctx) => Promise<unknown> | unknown;
export interface RouteOpts { auth?: 'none' | 'user' | 'admin'; csrf?: boolean; raw?: boolean; rate?: 'auth' | 'expensive' | 'default' | 'none' }
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; opts: RouteOpts }

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p: string, h: Handler, o?: RouteOpts) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: RouteOpts) { this.add('POST', p, h, o); }
  put(p: string, h: Handler, o?: RouteOpts) { this.add('PUT', p, h, o); }
  patch(p: string, h: Handler, o?: RouteOpts) { this.add('PATCH', p, h, o); }
  delete(p: string, h: Handler, o?: RouteOpts) { this.add('DELETE', p, h, o); }
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null | 'method' {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** Maps internal errors to customer-safe responses. Provider configuration details never reach customers. */
export function errorResponse(e: unknown): { status: number; body: { error: { code: string; message: string; retryable: boolean; details?: unknown } } } {
  if (e instanceof HttpError) return { status: e.status, body: { error: { code: e.code, message: e.message, retryable: e.retryable, details: e.details } } };
  if (e instanceof ValidationError) return { status: 400, body: { error: { code: 'invalid_input', message: e.message, retryable: false, details: { path: e.path } } } };
  if (e instanceof NotConfiguredError) return { status: 503, body: { error: { code: 'service_unavailable', message: 'This feature is not available yet. Your saved work is unaffected.', retryable: false } } };
  if (e instanceof QuotaExceededError) return { status: 429, body: { error: { code: 'free_quota_used', message: e.message, retryable: false } } };
  if (e instanceof AiBudgetExceeded) return { status: 429, body: { error: { code: 'ai_limit_reached', message: 'Planning limit reached for today. Your saved trips are unaffected; please try again tomorrow.', retryable: false } } };
  if (e instanceof ProviderError) return { status: 502, body: { error: { code: 'provider_unavailable', message: 'A travel data service did not respond. Your saved work is unaffected; please retry.', retryable: e.retryable } } };
  // A database rule rejected the input (e.g. dates in the wrong order): that's the customer's input, not a server fault.
  if (e instanceof PgError && e.code === '23514') return { status: 400, body: { error: { code: 'invalid_input', message: 'Some details don\'t fit together (for example a return date before the departure date). Please check and try again.', retryable: false } } };
  if (e instanceof PgError && e.code === '23505') return { status: 409, body: { error: { code: 'conflict', message: 'This record already exists.', retryable: false } } };
  log.error('unhandled error', { error: (e as Error)?.message, stack: (e as Error)?.stack?.split('\n').slice(0, 5).join(' | ') });
  return { status: 500, body: { error: { code: 'internal_error', message: 'Something went wrong on our side. Your saved work is unaffected.', retryable: true } } };
}

export function securityHeaders(res: http.ServerResponse, isProd: boolean) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://www.google.com");
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

export function serveStatic(publicDir: string, pathname: string, res: http.ServerResponse): boolean {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, '.' + path.posix.normalize(rel));
  if (!file.startsWith(publicDir)) return false;
  let target = file;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    if (path.extname(rel)) return false;
    target = path.join(publicDir, 'index.html'); // SPA fallback
  }
  const ext = path.extname(target);
  const data = fs.readFileSync(target);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300', 'Content-Length': data.length });
  res.end(data);
  return true;
}
