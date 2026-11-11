// Authenticated encryption for data at rest (OAuth tokens, traveller details) and hashing helpers.
import crypto from 'node:crypto';

export class Sealer {
  private key: Buffer;
  constructor(base64Key: string) {
    const k = Buffer.from(base64Key, 'base64');
    if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    this.key = k;
  }
  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
  }
  open(sealed: string): string {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1') throw new Error('Unknown sealed format');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  }
}

export function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }
export function randomToken(bytes = 32): string { return crypto.randomBytes(bytes).toString('base64url'); }
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Password hashing: scrypt (N=2^15) with per-password salt.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw.normalize('NFKC'), salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await new Promise<Buffer>((res, rej) => crypto.scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
  return crypto.timingSafeEqual(key, expected);
}
