// Small runtime validator for request bodies. Every mutating endpoint validates input on the server.

export class ValidationError extends Error {
  path: string;
  constructor(path: string, message: string) { super(`${path || 'body'}: ${message}`); this.name = 'ValidationError'; this.path = path; }
}

export type Schema<T> = { parse(v: unknown, path?: string): T };
export type Infer<S> = S extends Schema<infer T> ? T : never;

const mk = <T>(parse: (v: unknown, path: string) => T): Schema<T> => ({ parse: (v, path = '') => parse(v, path) });

export const v = {
  string: (o: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}) => mk<string>((x, p) => {
    if (typeof x !== 'string') throw new ValidationError(p, 'must be a string');
    const s = o.trim === false ? x : x.trim();
    if (o.min !== undefined && s.length < o.min) throw new ValidationError(p, `must be at least ${o.min} characters`);
    if (s.length > (o.max ?? 2000)) throw new ValidationError(p, `must be at most ${o.max ?? 2000} characters`);
    if (o.pattern && !o.pattern.test(s)) throw new ValidationError(p, 'has an invalid format');
    return s;
  }),
  email: () => mk<string>((x, p) => {
    const s = v.string({ max: 254 }).parse(x, p).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new ValidationError(p, 'must be a valid email address');
    return s;
  }),
  number: (o: { min?: number; max?: number; int?: boolean } = {}) => mk<number>((x, p) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new ValidationError(p, 'must be a number');
    if (o.int && !Number.isInteger(x)) throw new ValidationError(p, 'must be an integer');
    if (o.min !== undefined && x < o.min) throw new ValidationError(p, `must be ≥ ${o.min}`);
    if (o.max !== undefined && x > o.max) throw new ValidationError(p, `must be ≤ ${o.max}`);
    return x;
  }),
  bool: () => mk<boolean>((x, p) => { if (typeof x !== 'boolean') throw new ValidationError(p, 'must be true or false'); return x; }),
  date: () => mk<string>((x, p) => {
    const s = v.string({ max: 10 }).parse(x, p);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) throw new ValidationError(p, 'must be a date YYYY-MM-DD');
    return s;
  }),
  time: () => v.string({ pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
  uuid: () => v.string({ pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i }),
  enum: <const E extends readonly string[]>(vals: E) => mk<E[number]>((x, p) => {
    if (typeof x !== 'string' || !vals.includes(x)) throw new ValidationError(p, `must be one of ${vals.join(', ')}`);
    return x as E[number];
  }),
  array: <T>(item: Schema<T>, o: { max?: number; min?: number } = {}) => mk<T[]>((x, p) => {
    if (!Array.isArray(x)) throw new ValidationError(p, 'must be a list');
    if (x.length > (o.max ?? 100)) throw new ValidationError(p, `must have at most ${o.max ?? 100} items`);
    if (o.min !== undefined && x.length < o.min) throw new ValidationError(p, `must have at least ${o.min} items`);
    return x.map((e, i) => item.parse(e, `${p}[${i}]`));
  }),
  optional: <T>(s: Schema<T>) => mk<T | undefined>((x, p) => (x === undefined ? undefined : s.parse(x, p))),
  nullable: <T>(s: Schema<T>) => mk<T | null>((x, p) => (x === null ? null : s.parse(x, p))),
  object: <S extends Record<string, Schema<any>>>(shape: S) => mk<{ [K in keyof S]: Infer<S[K]> }>((x, p) => {
    if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new ValidationError(p, 'must be an object');
    const out: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(shape)) {
      const val = s.parse((x as Record<string, unknown>)[k], p ? `${p}.${k}` : k);
      if (val !== undefined) out[k] = val;
    }
    return out as { [K in keyof S]: Infer<S[K]> };
  }),
};

export const placeSchema = v.object({
  name: v.string({ min: 1, max: 200 }),
  kind: v.enum(['city', 'airport', 'region', 'country', 'point'] as const),
  lat: v.number({ min: -90, max: 90 }),
  lng: v.number({ min: -180, max: 180 }),
  countryCode: v.optional(v.string({ max: 2 })),
  timeZone: v.optional(v.string({ max: 64 })),
  iata: v.optional(v.string({ pattern: /^[A-Z]{3}$/ })),
  cityName: v.optional(v.string({ max: 200 })),
  airports: v.optional(v.array(v.object({ iata: v.string({ pattern: /^[A-Z]{3}$/ }), name: v.string({ max: 200 }), lat: v.number(), lng: v.number(), timeZone: v.optional(v.string({ max: 64 })) }), { max: 20 })),
  source: v.string({ max: 40 }),
});
