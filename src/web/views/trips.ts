import { get, post } from '../api.ts';
import { fmtDate, fmtMoney, h, replace } from '../dom.ts';
import { badge, errorBox, field, loading, placePicker } from '../components.ts';
import { navigate } from '../app.ts';
import type { Place } from '../../shared/types.ts';

const PLAN_BADGE: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'muted']> = {
  none: ['No plan yet', 'muted'], generating: ['Researching…', 'info'], complete: ['Plan complete', 'ok'], incomplete: ['Plan incomplete', 'warn'], failed: ['Plan failed', 'bad'],
};

export function tripsList(trips: any[]) {
  return trips.length ? h('ul', { class: 'trip-grid' }, ...trips.map((t: any) => h('li', null, h('a', { class: 'trip-card', href: `/trips/${t.id}` },
    h('span', { class: 'ticket-stub' }, t.origin?.iata ?? '···', ' → '),
    h('h2', null, t.title), h('p', { class: 'mono' }, t.startDate ? `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}` : 'Dates not set'),
    h('p', null, badge(...(PLAN_BADGE[t.planStatus] ?? ['', 'muted'])), ' ', badge(t.status, t.status === 'booked' ? 'ok' : 'muted'), t.budgetTotal ? ` · budget ${fmtMoney(t.budgetTotal, t.currency)}` : '')))))
    : h('div', { class: 'empty' }, h('p', null, 'No trips yet. Let us suggest one, or plan your own.'), h('a', { class: 'button primary', href: '/ideas' }, 'Suggest trips'), ' ', h('a', { class: 'button secondary', href: '/trips/new' }, 'Plan my own'));
}

export async function tripsView(root: HTMLElement) {
  replace(root, loading());
  try {
    const trips = await get('/api/trips');
    replace(root, h('div', { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', null, 'Your trips'), h('a', { class: 'button primary', href: '/trips/new' }, 'Plan a trip')),
      tripsList(trips)));
  } catch (e) { replace(root, errorBox(e, () => tripsView(root))); }
}

export async function newTripView(root: HTMLElement) {
  const prof = await get('/api/profile').catch(() => null);
  const st: { title: string; origin: Place | null; start: string; end: string; adults: number; flex: number; budget: number | null; dest: Place | null; mode: 'known' | 'discover' } =
    { title: '', origin: prof?.homePlace ?? null, start: '', end: '', adults: 1, flex: 0, budget: prof?.budgetTotal ?? null, dest: null, mode: 'known' };
  const msg = h('div', { 'aria-live': 'polite' });
  const destBox = h('div');
  const renderDest = () => replace(destBox, st.mode === 'known' ? placePicker({ label: 'Destination', value: st.dest, onChange: (p) => (st.dest = p) }) : h('p', { class: 'hint' }, 'We will suggest destinations using live flight and accommodation prices, the weather and your interests.'));
  renderDest();
  const today = new Date().toISOString().slice(0, 10);
  const form = h('form', { class: 'stack', on: { submit: async (e: Event) => {
    e.preventDefault(); replace(msg);
    if (!st.origin || !st.start || !st.end) { replace(msg, errorBox(new Error('Choose where you leave from and your dates.'))); return; }
    if (st.mode === 'known' && !st.dest) { replace(msg, errorBox(new Error('Choose a destination, or let us suggest one.'))); return; }
    try {
      const t = await post('/api/trips', { title: st.title || (st.dest ? `Trip to ${st.dest.name}` : 'New trip'), origin: st.origin, startDate: st.start, endDate: st.end, adults: st.adults, flexDays: st.flex, budgetTotal: st.budget,
        stops: st.mode === 'known' && st.dest ? [{ place: st.dest, arriveDate: st.start, departDate: st.end }] : [] });
      navigate(`/trips/${t.id}${st.mode === 'discover' ? '?tab=discover' : ''}`);
    } catch (err) { replace(msg, errorBox(err)); }
  } } },
    h('fieldset', { class: 'segmented' }, h('legend', null, 'Do you know where you want to go?'),
      ...([['known', 'I know where'], ['discover', 'Suggest destinations']] as const).map(([v, l]) => h('label', null, h('input', { type: 'radio', name: 'mode', value: v, checked: st.mode === v, on: { change: () => { st.mode = v; renderDest(); } } }), l))),
    placePicker({ label: 'Leaving from', value: st.origin, allowLocate: true, onChange: (p) => (st.origin = p) }),
    destBox,
    h('div', { class: 'grid2' }, field('Depart', h('input', { type: 'date', min: today, required: true, on: { input: (e: Event) => (st.start = (e.target as HTMLInputElement).value) } })), field('Return', h('input', { type: 'date', min: today, required: true, on: { input: (e: Event) => (st.end = (e.target as HTMLInputElement).value) } }))),
    h('div', { class: 'grid3' },
      field('Travellers', h('input', { type: 'number', min: 1, max: 9, value: 1, on: { input: (e: Event) => (st.adults = Number((e.target as HTMLInputElement).value) || 1) } })),
      field('Date flexibility', h('select', { on: { change: (e: Event) => (st.flex = Number((e.target as HTMLSelectElement).value)) } }, ...[0, 1, 2, 3].map((n) => h('option', { value: n }, n ? `± ${n} day${n > 1 ? 's' : ''}` : 'Exact dates')))),
      field('Total budget', h('input', { type: 'number', min: 0, value: st.budget ?? '', on: { input: (e: Event) => { const v = (e.target as HTMLInputElement).value; st.budget = v ? Number(v) : null; } } }))),
    field('Trip name (optional)', h('input', { maxlength: 120, on: { input: (e: Event) => (st.title = (e.target as HTMLInputElement).value) } })),
    msg, h('button', { class: 'primary', type: 'submit' }, 'Create trip'));
  replace(root, h('div', { class: 'page narrow' }, h('h1', null, 'Plan a trip'), form));
}
