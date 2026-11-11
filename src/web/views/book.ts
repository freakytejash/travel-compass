// "Book everything" tab: one checklist with the best and cheapest live options, and prefilled comparison links
// for things without a free price feed (hostels, Airbnb, car rental, trains, tickets).
import { get, post } from '../api.ts';
import { extLink, fmtMoney, h, replace, toast } from '../dom.ts';
import { badge, errorBox, loading } from '../components.ts';
import { bookingPanel } from './booking.ts';

const SECTION: Record<string, string> = { flights: 'Flights', stays: 'Places to stay', transport: 'Getting around', car: 'Car rental', activities: 'Tickets & reservations', extras: 'Before you go' };
const STATUS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'muted']> = {
  booked: ['Booked', 'ok'], chosen: ['Chosen — finish booking', 'info'], to_book: ['To book', 'warn'], search_needed: ['Needs a search', 'muted'], optional: ['Optional', 'muted'],
};
const ROLE: Record<string, string> = { recommended: 'Best value', cheapest: 'Cheapest', convenient: 'Most convenient', comfortable: 'Most comfortable' };

export async function bookTab(c: { id: string; refresh: () => Promise<void>; root: HTMLElement }) {
  const root = c.root;
  let polls = 0;
  const load = async (): Promise<void> => {
    let plan: any; let running = false;
    try {
      const [p, s] = await Promise.all([get(`/api/trips/${c.id}/book`), get(`/api/trips/${c.id}/searches`).catch(() => [])]);
      plan = p; running = (s as any[]).some((x) => x.status === 'running');
    } catch (e) { replace(root, errorBox(e, load)); return; }
    const missing = plan.items.filter((i: any) => i.status === 'search_needed').map((i: any) => i.section);
    const startMissing = async () => {
      for (const kind of [...new Set(missing.map((m: string) => (m === 'flights' ? 'flight' : 'stay')))]) {
        try { await post(`/api/trips/${c.id}/searches`, { kind }); } catch (e) { toast((e as Error).message, 'error'); }
      }
      polls = 0; void load();
    };
    const bySection = new Map<string, any[]>();
    for (const it of plan.items) bySection.set(it.section, [...(bySection.get(it.section) ?? []), it]);
    replace(root,
      h('section', { class: 'panel book-summary' },
        h('div', { class: 'page-head' }, h('h2', null, 'Everything to book'), running ? badge('Searching live prices…', 'info') : null),
        h('p', null, `${plan.counts.toBook} to book · ${plan.counts.booked} booked`),
        plan.totals.recommended ? h('p', { class: 'small' }, `Flights + stays: about ${fmtMoney(plan.totals.recommended, plan.totals.currency)} (best value) or ${fmtMoney(plan.totals.cheapest, plan.totals.currency)} (cheapest). ${plan.totals.note}`) : null,
        plan.trip.budgetTotal && plan.totals.cheapest > plan.trip.budgetTotal ? h('p', { class: 'notice warn' }, `The cheapest combination is over your ${fmtMoney(plan.trip.budgetTotal, plan.totals.currency)} budget.`) : null,
        missing.length && !running ? h('button', { class: 'primary small', on: { click: startMissing } }, 'Search live prices now') : null,
        h('p', { class: 'small muted' }, 'You book and pay on the airline, hotel or rental site. Travel Compass never takes payment. Add bookings you made elsewhere on the Bookings tab so this list stays current.')),
      ...[...bySection.entries()].map(([sec, items]) => h('section', { class: 'panel' }, h('h2', null, SECTION[sec] ?? sec),
        h('ul', { class: 'book-list' }, ...items.map((it: any) => h('li', { class: `book-item ${it.status}` },
          h('div', { class: 'page-head' }, h('div', null, h('h3', null, it.title), h('p', { class: 'small mono' }, it.subtitle)), badge(...STATUS[it.status])),
          it.options.length ? h('div', { class: 'book-options' }, ...it.options.map((o: any) => h('article', { class: `offer ${o.role}` },
            h('p', { class: 'role' }, ROLE[o.role] ?? o.role),
            h('p', { class: 'price' }, o.price ? fmtMoney(o.price.amount, o.price.currency) : '—'),
            h('p', null, h('strong', null, o.title)),
            h('p', { class: 'small' }, o.detail),
            h('div', { class: 'actions' },
              o.offer && it.status !== 'booked' ? h('button', { class: o.role === 'recommended' ? 'primary small' : 'secondary small', on: { click: () => bookingPanel(o.offer, async () => { await c.refresh(); }) } }, o.offer.selected ? 'Continue booking' : 'Book') : null,
              o.link ? extLink(o.link, 'View') : null)))) : null,
          it.note ? h('p', { class: 'small' }, it.note) : null,
          it.links.length ? h('p', { class: 'links small' }, 'Compare: ', ...it.links.flatMap((l: any, i: number) => [i ? ' · ' : '', extLink(l.url, l.label)])) : null))))));
    if (running && polls++ < 40) setTimeout(() => { if (root.isConnected) void load(); }, 4000);
  };
  replace(root, loading('Collecting everything you need to book…'));
  await load();
}
