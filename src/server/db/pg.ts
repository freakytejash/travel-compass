// Minimal, dependency-free PostgreSQL client (wire protocol v3).
// Supports: TCP/Unix sockets, TLS (sslmode=require/verify-full), cleartext/MD5/SCRAM-SHA-256 auth,
// the extended query protocol with text-format parameters, a bounded pool, and transactions.
// Kept deliberately small; all queries in the application are parameterised.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class PgError extends Error {
  code: string;
  detail?: string;
  constraint?: string;
  constructor(fields: Record<string, string>) {
    super(fields['M'] ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields['C'] ?? 'XX000';
    this.detail = fields['D'];
    this.constraint = fields['n'];
  }
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  command: string;
}

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  database: string;
  ssl: false | { rejectUnauthorized: boolean; ca?: string };
  applicationName?: string;
  connectTimeoutMs?: number;
}

export function parseDatabaseUrl(url: string): ConnectionConfig {
  const u = new URL(url);
  const params = u.searchParams;
  const sslmode = params.get('sslmode') ?? 'disable';
  let ssl: ConnectionConfig['ssl'] = false;
  if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'no-verify') ssl = { rejectUnauthorized: false };
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') ssl = { rejectUnauthorized: true };
  const hostParam = params.get('host');
  return {
    host: hostParam ?? (decodeURIComponent(u.hostname) || 'localhost'),
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    ssl,
    applicationName: params.get('application_name') ?? 'travel-compass',
  };
}

// ---- type parsing ----------------------------------------------------------------------------
const OID = {
  bool: 16, int8: 20, int2: 21, int4: 23, text: 25, json: 114, float4: 700, float8: 701,
  numeric: 1700, date: 1082, timestamp: 1114, timestamptz: 1184, jsonb: 3802, uuid: 2950,
  textArray: 1009, int4Array: 1007, uuidArray: 2951, varcharArray: 1015,
};

function parseTextArray(s: string): (string | null)[] {
  // Handles the simple cases produced by Postgres for text[] (quoted and unquoted elements).
  if (s === '{}') return [];
  const out: (string | null)[] = [];
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let v = '';
      i++;
      while (s[i] !== '"') {
        if (s[i] === '\\') i++;
        v += s[i++];
      }
      out.push(v);
      i += 2;
    } else {
      let j = i;
      while (j < s.length - 1 && s[j] !== ',') j++;
      const raw = s.slice(i, j);
      out.push(raw === 'NULL' ? null : raw);
      i = j + 1;
    }
  }
  return out;
}

function parseValue(oid: number, text: string): unknown {
  switch (oid) {
    case OID.bool: return text === 't';
    case OID.int2: case OID.int4: return Number(text);
    case OID.int8: { const n = Number(text); return Number.isSafeInteger(n) ? n : text; }
    case OID.float4: case OID.float8: return Number(text);
    case OID.numeric: return text; // keep exact; callers convert money with care
    case OID.json: case OID.jsonb: return JSON.parse(text);
    case OID.timestamptz: return new Date(text);
    case OID.timestamp: return text.replace(' ', 'T');
    case OID.date: return text;
    case OID.textArray: case OID.uuidArray: case OID.varcharArray: return parseTextArray(text);
    case OID.int4Array: return parseTextArray(text).map((v) => (v === null ? null : Number(v)));
    default: return text;
  }
}

function serialiseParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (Array.isArray(v)) {
    // Arrays are sent as Postgres array literals. Objects are not supported inside arrays; use JSON columns.
    return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- message framing ----------------------------------------------------------------------------
class Writer {
  private chunks: Buffer[] = [];
  int32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.chunks.push(b); return this; }
  int16(n: number) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.chunks.push(b); return this; }
  cstr(s: string) { this.chunks.push(Buffer.from(s, 'utf8'), Buffer.from([0])); return this; }
  bytes(b: Buffer) { this.chunks.push(b); return this; }
  build(type?: string): Buffer {
    const body = Buffer.concat(this.chunks);
    if (type === undefined) {
      const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4);
      return Buffer.concat([len, body]);
    }
    const head = Buffer.alloc(5); head.write(type, 0, 'ascii'); head.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([head, body]);
  }
}

interface Field { name: string; oid: number }

interface Pending {
  resolve: (r: QueryResult<any>) => void;
  reject: (e: Error) => void;
  fields: Field[];
  rows: Record<string, unknown>[];
  command: string;
  error?: Error;
  simple: boolean;
}

export class PgConnection extends EventEmitter {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private scram?: { clientNonce: string; clientFirstBare: string; serverSignature?: Buffer };
  closed = false;
  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    const c = this.config;
    const raw = c.host.startsWith('/')
      ? net.createConnection({ path: `${c.host}/.s.PGSQL.${c.port}` })
      : net.createConnection({ host: c.host, port: c.port });
    raw.setNoDelay(true);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('Database connect timeout')), c.connectTimeoutMs ?? 10000);
      raw.once('connect', () => { clearTimeout(t); res(); });
      raw.once('error', (e) => { clearTimeout(t); rej(e); });
    });
    let sock: net.Socket | tls.TLSSocket = raw;
    if (c.ssl) {
      raw.write(new Writer().int32(80877103).build());
      const answer = await new Promise<string>((res, rej) => {
        raw.once('data', (d) => res(d.toString('ascii', 0, 1)));
        raw.once('error', rej);
      });
      if (answer !== 'S') throw new Error('Server refused TLS but sslmode requires it');
      sock = tls.connect({ socket: raw, servername: c.host, rejectUnauthorized: c.ssl.rejectUnauthorized, ca: c.ssl.ca });
      await new Promise<void>((res, rej) => { sock.once('secureConnect', () => res()); sock.once('error', rej); });
    }
    this.socket = sock;
    sock.on('data', (d: Buffer) => this.onData(d));
    sock.on('error', (e: Error) => this.fail(e));
    sock.on('close', () => { this.closed = true; this.fail(new Error('Database connection closed')); });
    const ready = new Promise<void>((res, rej) => { this.readyResolve = res; this.readyReject = rej; });
    const w = new Writer().int32(196608).cstr('user').cstr(c.user).cstr('database').cstr(c.database)
      .cstr('application_name').cstr(c.applicationName ?? 'travel-compass').cstr('client_encoding').cstr('UTF8').cstr('TimeZone').cstr('UTC').cstr('');
    sock.write(w.build());
    await ready;
  }

  private fail(e: Error) {
    if (this.readyReject) { this.readyReject(e); this.readyReject = undefined; this.readyResolve = undefined; }
    const q = this.queue; this.queue = [];
    for (const p of q) p.reject(e);
    this.emit('dead', e);
  }

  private onData(d: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, d]) : d;
    while (this.buffer.length >= 5) {
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const type = String.fromCharCode(this.buffer[0]);
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try { this.handle(type, body); } catch (e) { this.fail(e as Error); }
    }
  }

  private handle(type: string, body: Buffer) {
    const cur = this.queue[0];
    switch (type) {
      case 'R': return this.handleAuth(body);
      case 'S': case 'K': case 'N': case '1': case '2': case 'n': case 't': case 's': return;
      case 'Z':
        if (this.readyResolve) { const r = this.readyResolve; this.readyResolve = undefined; this.readyReject = undefined; r(); return; }
        if (cur) {
          this.queue.shift();
          if (cur.error) cur.reject(cur.error);
          else cur.resolve({ rows: cur.rows, rowCount: cur.rows.length || Number(cur.command.split(' ').pop()) || 0, command: cur.command });
        }
        return;
      case 'T': {
        if (!cur) return;
        const n = body.readInt16BE(0); let off = 2; cur.fields = [];
        for (let i = 0; i < n; i++) {
          const end = body.indexOf(0, off); const name = body.toString('utf8', off, end); off = end + 1;
          const oid = body.readInt32BE(off + 6); off += 18;
          cur.fields.push({ name, oid });
        }
        return;
      }
      case 'D': {
        if (!cur) return;
        const n = body.readInt16BE(0); let off = 2; const row: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) {
          const l = body.readInt32BE(off); off += 4;
          const f = cur.fields[i];
          if (l === -1) { row[f.name] = null; continue; }
          row[f.name] = parseValue(f.oid, body.toString('utf8', off, off + l)); off += l;
        }
        cur.rows.push(row);
        return;
      }
      case 'C': if (cur) cur.command = body.toString('utf8', 0, body.length - 1); return;
      case 'I': return;
      case 'E': {
        const fields: Record<string, string> = {}; let off = 0;
        while (body[off] !== 0) { const code = String.fromCharCode(body[off]); const end = body.indexOf(0, off + 1); fields[code] = body.toString('utf8', off + 1, end); off = end + 1; }
        const err = new PgError(fields);
        if (this.readyReject) { this.readyReject(err); this.readyReject = undefined; return; }
        if (cur) cur.error = err;
        return;
      }
      default: return;
    }
  }

  private handleAuth(body: Buffer) {
    const kind = body.readInt32BE(0);
    const pw = this.config.password ?? '';
    if (kind === 0) return;
    if (kind === 3) { this.socket.write(new Writer().cstr(pw).build('p')); return; }
    if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(pw + this.config.user).digest('hex');
      const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this.socket.write(new Writer().cstr(outer).build('p'));
      return;
    }
    if (kind === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Unsupported SASL mechanism');
      const clientNonce = crypto.randomBytes(18).toString('base64');
      const clientFirstBare = `n=*,r=${clientNonce}`;
      this.scram = { clientNonce, clientFirstBare };
      const msg = Buffer.from('n,,' + clientFirstBare);
      this.socket.write(new Writer().cstr('SCRAM-SHA-256').int32(msg.length).bytes(msg).build('p'));
      return;
    }
    if (kind === 11) {
      const s = this.scram!; const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      if (!attrs['r'].startsWith(s.clientNonce)) throw new Error('SCRAM nonce mismatch');
      const salted = crypto.pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(attrs['s'], 'base64'), Number(attrs['i']), 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const clientFinalNoProof = `c=biws,r=${attrs['r']}`;
      const authMessage = `${s.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
      const sig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
      const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
      s.serverSignature = crypto.createHmac('sha256', serverKey).update(authMessage).digest();
      this.socket.write(new Writer().bytes(Buffer.from(`${clientFinalNoProof},p=${proof.toString('base64')}`)).build('p'));
      return;
    }
    if (kind === 12) {
      const v = body.toString('utf8', 4).replace(/^v=/, '');
      if (!this.scram?.serverSignature || !crypto.timingSafeEqual(Buffer.from(v, 'base64'), this.scram.serverSignature)) throw new Error('SCRAM server signature mismatch');
      return;
    }
    throw new Error(`Unsupported auth method ${kind}`);
  }

  query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (this.closed) return Promise.reject(new Error('Database connection closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, fields: [], rows: [], command: '', simple: false });
      const parse = new Writer().cstr('').cstr(text).int16(0).build('P');
      const bind = new Writer().cstr('').cstr('').int16(0).int16(params.length);
      for (const p of params) {
        const s = serialiseParam(p);
        if (s === null) bind.int32(-1); else { const b = Buffer.from(s, 'utf8'); bind.int32(b.length).bytes(b); }
      }
      bind.int16(0);
      const describe = new Writer().bytes(Buffer.from('P')).cstr('').build('D');
      const execute = new Writer().cstr('').int32(0).build('E');
      const sync = new Writer().build('S');
      this.socket.write(Buffer.concat([parse, bind.build('B'), describe, execute, sync]));
    });
  }

  /** Simple-protocol query; allows multiple statements (used by migrations). No parameters. */
  exec(text: string): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, fields: [], rows: [], command: '', simple: true });
      this.socket.write(new Writer().cstr(text).build('Q'));
    });
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.write(new Writer().build('X')); this.socket.end(); } catch { /* ignore */ }
  }
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export class Pool implements Queryable {
  private idle: PgConnection[] = [];
  private total = 0;
  private waiters: ((c: PgConnection) => void)[] = [];
  private config: ConnectionConfig;
  private max: number;
  ended = false;

  constructor(config: ConnectionConfig, max = 10) {
    this.config = config;
    this.max = max;
  }

  private async acquire(): Promise<PgConnection> {
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.closed) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      const c = new PgConnection(this.config);
      c.on('dead', () => { /* removed lazily */ });
      try { await c.connect(); } catch (e) { this.total--; throw e; }
      return c;
    }
    return new Promise((res) => this.waiters.push(res));
  }

  private release(c: PgConnection) {
    if (c.closed) { this.total--; return; }
    if (this.ended) { this.total--; c.end(); return; } // busy when the pool was shut down: close it now
    const w = this.waiters.shift();
    if (w) w(c); else this.idle.push(c);
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const c = await this.acquire();
    try { return await c.query<T>(text, params); } finally { this.release(c); }
  }

  async exec(text: string) {
    const c = await this.acquire();
    try { return await c.exec(text); } finally { this.release(c); }
  }

  /** Runs fn inside BEGIN/COMMIT on a dedicated connection; rolls back on error. */
  async tx<R>(fn: (q: Queryable) => Promise<R>): Promise<R> {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* connection may be dead */ }
      throw e;
    } finally { this.release(c); }
  }

  async end() {
    this.ended = true;
    for (const c of this.idle) c.end();
    this.idle = [];
  }
}
