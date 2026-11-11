// Tiny typed DOM helpers (no framework). Text is always set via textContent, never innerHTML, so
// provider/AI/email content cannot inject markup.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; on?: Record<string, (e: any) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') { for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn); continue; }
      if (k === 'class') { el.className = String(v); continue; }
      if (k === 'value' && 'value' in el) { (el as HTMLInputElement).value = String(v); continue; }
      if (k === 'checked' && el instanceof HTMLInputElement) { el.checked = !!v; continue; }
      if (k === 'href' && typeof v === 'string' && !/^(https?:|\/|#|mailto:)/.test(v)) continue; // block javascript: URLs
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }
export function replace(el: Element, ...children: Child[]) { clear(el); append(el, children); }

export function extLink(url: string | null | undefined, label: string) {
  if (!url || !/^https:\/\//.test(url)) return null;
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ext' }, label);
}

export function fmtMoney(amount: number | null | undefined, currency: string) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); } catch { return `${currency} ${amount.toFixed(2)}`; }
}

export function fmtDate(d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!d) return '—';
  return new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function hrs(min: number) { return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`; }

export function toast(msg: string, kind: 'ok' | 'error' = 'ok') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

export function debounce<T extends unknown[]>(fn: (...a: T) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: T) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
