// API client: same-origin cookies, CSRF header on writes, typed errors.
export class ApiError extends Error {
  status: number; code: string; retryable: boolean; details: any;
  constructor(status: number, code: string, message: string, retryable: boolean, details: any) { super(message); this.status = status; this.code = code; this.retryable = retryable; this.details = details; }
}

let csrf = '';
export function setCsrf(t: string | null) { csrf = t ?? ''; }

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'You appear to be offline. Your changes are kept on this page; retry when connected.', true, null);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new CustomEvent('tc:unauthenticated'));
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'Request failed', !!e.retryable, e.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

/** Polls a search until it finishes. */
export async function waitForSearch(id: string, onTick?: (s: any) => void, timeoutMs = 120000, alive: () => boolean = () => true) {
  const start = Date.now();
  for (;;) {
    if (!alive()) return null; // the user moved on: stop polling
    const s = await get(`/api/searches/${id}`);
    onTick?.(s);
    if (s.status !== 'running') return s;
    if (Date.now() - start > timeoutMs) throw new ApiError(0, 'timeout', 'The search is taking longer than expected. It will keep running; check back shortly.', true, null);
    await new Promise((r) => setTimeout(r, Date.now() - start < 20000 ? 2000 : 4000));
  }
}
