import { ApiError, get } from './api.ts';
import { debounce, h, replace } from './dom.ts';
import type { Place } from '../shared/types.ts';

let comboSeq = 0;

/** Accessible searchable place dropdown (WAI-ARIA combobox) backed by the server's worldwide place search. */
export function placePicker(opts: { label: string; value: Place | null; onChange: (p: Place | null) => void; allowLocate?: boolean; placeholder?: string }) {
  const id = `combo-${++comboSeq}`;
  let results: Place[] = []; let active = -1; let current = opts.value;
  const input = h('input', { id, type: 'text', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`, autocomplete: 'off', placeholder: opts.placeholder ?? 'City or airport', value: current?.name ?? '' });
  const list = h('ul', { id: `${id}-list`, role: 'listbox', class: 'combo-list', hidden: true });
  const status = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (p: Place) => { current = p; input.value = p.name; close(); opts.onChange(p); };
  const render = () => {
    replace(list, ...results.map((p, i) => h('li', { role: 'option', id: `${id}-o${i}`, 'aria-selected': String(i === active), class: i === active ? 'active' : '', on: { mousedown: (e: Event) => { e.preventDefault(); choose(p); } } },
      h('span', { class: 'opt-name' }, p.name), h('span', { class: 'opt-meta' }, [p.kind, p.cityName && p.kind === 'airport' ? p.cityName : null, p.countryCode].filter(Boolean).join(' · ')))));
    list.hidden = !results.length; input.setAttribute('aria-expanded', String(!!results.length));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-o${active}`); else input.removeAttribute('aria-activedescendant');
    status.textContent = results.length ? `${results.length} places found` : '';
  };
  const search = debounce(async (q: string, near?: { lat: number; lng: number }) => {
    try { results = await get(`/api/places?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat}&lng=${near.lng}` : ''}`); active = -1; render(); }
    catch (e) { results = []; render(); status.textContent = e instanceof ApiError ? e.message : 'Place search failed'; }
  }, 250);
  input.addEventListener('input', () => { if (input.value.trim().length >= 2) search(input.value.trim()); else { results = []; render(); } });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { choose(results[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => { setTimeout(close, 120); if (!input.value.trim() && current) { current = null; opts.onChange(null); } });
  const locate = opts.allowLocate ? h('button', { type: 'button', class: 'ghost small', on: { click: () => {
    if (!navigator.geolocation) { status.textContent = 'Location is not available in this browser.'; return; }
    status.textContent = 'Finding nearby airports…';
    navigator.geolocation.getCurrentPosition((pos) => { search('', { lat: pos.coords.latitude, lng: pos.coords.longitude }); input.focus(); }, () => { status.textContent = 'Location permission denied — type a city instead.'; }, { timeout: 8000 });
  } } }, 'Use my location') : null;
  return h('div', { class: 'field combo' }, h('label', { for: id }, opts.label), h('div', { class: 'combo-row' }, input, locate), list, status);
}

export function errorBox(e: unknown, retry?: () => void) {
  const msg = e instanceof ApiError ? e.message : (e as Error)?.message ?? 'Something went wrong';
  return h('div', { class: 'notice error', role: 'alert' }, h('p', null, msg), retry ? h('button', { class: 'secondary small', on: { click: retry } }, 'Retry') : null);
}

export function loading(text = 'Loading…') { return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text); }

export function badge(text: string, kind: 'ok' | 'warn' | 'bad' | 'info' | 'muted' = 'info') { return h('span', { class: `badge ${kind}` }, text); }

export function field(label: string, control: HTMLElement, hint?: string) {
  const id = control.id || `f-${++comboSeq}`; control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void) {
  return h('select', { on: { change: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) } }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}
