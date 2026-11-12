// Trip workspace: stops & dates (autosave), destination ideas, flights, stays, flexible dates, itinerary, bookings, reminders.
import { ApiError, get, patch, post, waitForSearch } from '../api.ts';
import { extLink, fmtDate, fmtDateTime, fmtMoney, h, hrs, replace, toast } from '../dom.ts';
import { badge, errorBox, field, loading, placePicker } from '../components.ts';
import { navigate } from '../app.ts';
import { bookingPanel } from './booking.ts';
import { bookTab } from './book.ts';
import type { Place } from '../../shared/types.ts';

type Tab = 'book' | 'plan' | 'discover' | 'flights' | 'stays' | 'flex' | 'bookings' | 'reminders';
const TABS: [Tab, string][] = [['book', 'Book everything'], ['plan', 'Itinerary'], ['discover', 'Destinations'], ['flights', 'Flights'], ['stays', 'Stays'], ['flex', 'Flexible dates'], ['bookings', 'Bookings'], ['reminders', 'Reminders']];

export async function tripView(root: HTMLElement, id: string) {
  const q = new URLSearchParams(location.search);
  let tab = (q.get('tab') as Tab) ?? 'plan';
  let detail: any;
  const body = h('div', { class: 'tab-body' });
  const header = h('div');
  const tabs = h('nav', { class: 'tabs', role: 'tablist' });
  const load = async () => { detail = await get(`/api/trips/${id}`); };
  try { await load(); } catch (e) { replace(root, errorBox(e, () => tripView(root, id))); return; }

  const renderHeader = () => {
    const t = detail.trip;
    replace(header, h('div', { class: 'trip-head' },
      h('div', null, h('p', { class: 'eyebrow mono' }, `${t.origin?.iata ?? t.origin?.name ?? '—'} → ${detail.stops.map((s: any) => s.place.iata ?? s.place.name).join(' → ') || '?'}`),
        h('h1', null, t.title), h('p', { class: 'mono' }, t.startDate ? `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)} · ${t.adults} traveller${t.adults > 1 ? 's' : ''}${t.flexDays ? ` · ±${t.flexDays} days` : ''}` : 'Add dates to begin')),
      h('div', { class: 'head-actions' }, t.planMessage ? h('p', { class: `plan-msg ${t.planStatus}` }, t.planMessage) : null)));
  };
  const renderTabs = () => replace(tabs, ...TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'active' : '', on: { click: () => { tab = k; history.replaceState(null, '', `/trips/${id}?tab=${k}`); renderTabs(); renderBody(); } } }, l)));
  const refresh = async () => { await load(); renderHeader(); renderBody(); };
  let gen = 0;
  const renderBody = () => {
    // Each render gets a generation; background polling from an older render (other tab, page left) stops itself.
    const mine = ++gen;
    const ctx = { id, detail, refresh, root: body, alive: () => mine === gen && body.isConnected };
    const map: Record<Tab, (c: typeof ctx) => void> = { book: (x) => bookTab(x), plan: planTab, discover: discoverTab, flights: flightsTab, stays: staysTab, flex: flexTab, bookings: bookingsTab, reminders: remindersTab };
    replace(body, loading()); map[tab](ctx);
  };
  replace(root, h('div', { class: 'page wide' }, header, tabs, body));
  renderHeader(); renderTabs(); renderBody();
  const sess = q.get('session');
  if (sess && q.get('result')) {
    try { const r = await post(`/api/booking-sessions/${sess}/complete`, { orderId: q.get('order_id'), result: q.get('result') }); toast(r.state === 'completed' ? 'Booking confirmed by the provider' : r.error ?? 'Checkout not completed', r.state === 'completed' ? 'ok' : 'error'); await refresh(); }
    catch (e) { toast((e as Error).message, 'error'); }
    history.replaceState(null, '', `/trips/${id}?tab=bookings`);
  }
}

interface TabCtx { id: string; detail: any; refresh: () => Promise<void>; root: HTMLElement; alive: () => boolean }

// ---------------------------------------------------------------- stops editor + itinerary
function stopsEditor(c: TabCtx) {
  const t = c.detail.trip;
  const st = { version: t.version, startDate: t.startDate ?? '', endDate: t.endDate ?? '', origin: t.origin as Place | null, adults: t.adults, flexDays: t.flexDays, budgetTotal: t.budgetTotal,
    stops: c.detail.stops.map((s: any) => ({ place: s.place as Place, arriveDate: s.arriveDate, departDate: s.departDate })) as { place: Place | null; arriveDate: string; departDate: string }[] };
  const status = h('span', { class: 'save-status', 'aria-live': 'polite' }, 'Saved');
  let timer: ReturnType<typeof setTimeout> | undefined; let saving = false; let pending = false;
  const save = async () => {
    if (saving) { pending = true; return; }
    const stops = st.stops.filter((s) => s.place) as { place: Place; arriveDate: string; departDate: string }[];
    saving = true; status.textContent = 'Saving…'; status.className = 'save-status saving';
    try {
      const r = await patch(`/api/trips/${c.id}`, { version: st.version, changes: { startDate: st.startDate || null, endDate: st.endDate || null, origin: st.origin, adults: st.adults, flexDays: st.flexDays, budgetTotal: st.budgetTotal, stops } });
      st.version = r.version; status.textContent = 'Saved'; status.className = 'save-status ok';
      c.detail.trip = r; c.detail.stops = r.stops;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        status.textContent = 'Changed elsewhere'; status.className = 'save-status bad';
        replace(conflict, h('div', { class: 'notice warn' }, h('p', null, 'This trip was edited in another tab or device. Your unsaved edits are still on this page.'),
          h('button', { class: 'secondary small', on: { click: () => { st.version = e.details.server.version; replace(conflict); void save(); } } }, 'Keep my version'),
          h('button', { class: 'ghost small', on: { click: () => c.refresh() } }, 'Load the other version')));
      } else { status.textContent = e instanceof ApiError ? e.message : 'Not saved'; status.className = 'save-status bad'; }
    } finally { saving = false; if (pending) { pending = false; void save(); } }
  };
  const schedule = () => { status.textContent = 'Unsaved changes'; status.className = 'save-status'; if (timer) clearTimeout(timer); timer = setTimeout(save, 800); };
  const conflict = h('div');
  const list = h('ol', { class: 'stops' });
  const renderStops = () => replace(list, ...st.stops.map((s, i) => h('li', { class: 'stop' },
    placePicker({ label: `Stop ${i + 1}`, value: s.place, onChange: (p) => { s.place = p; schedule(); } }),
    h('div', { class: 'grid2' },
      field('Arrive', h('input', { type: 'date', value: s.arriveDate, disabled: i > 0, title: i > 0 ? 'Starts when you leave the previous stop' : '', on: { input: (e: Event) => { s.arriveDate = (e.target as HTMLInputElement).value; if (i === 0) st.startDate = s.arriveDate; schedule(); } } })),
      field('Leave', h('input', { type: 'date', value: s.departDate, on: { input: (e: Event) => { s.departDate = (e.target as HTMLInputElement).value; if (st.stops[i + 1]) st.stops[i + 1].arriveDate = s.departDate; if (i === st.stops.length - 1) st.endDate = s.departDate; renderStops(); schedule(); } } }))),
    st.stops.length > 1 ? h('button', { class: 'ghost small', on: { click: () => { st.stops.splice(i, 1); if (st.stops[i]) st.stops[i].arriveDate = i ? st.stops[i - 1].departDate : st.startDate; renderStops(); schedule(); } } }, 'Remove stop') : null)));
  renderStops();
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Route & dates'), status),
    conflict,
    placePicker({ label: 'Leaving from', value: st.origin, allowLocate: true, onChange: (p) => { st.origin = p; schedule(); } }),
    h('div', { class: 'grid3' },
      field('Trip starts', h('input', { type: 'date', value: st.startDate, on: { input: (e: Event) => { st.startDate = (e.target as HTMLInputElement).value; if (st.stops[0]) st.stops[0].arriveDate = st.startDate; renderStops(); schedule(); } } })),
      field('Trip ends', h('input', { type: 'date', value: st.endDate, on: { input: (e: Event) => { st.endDate = (e.target as HTMLInputElement).value; const l = st.stops[st.stops.length - 1]; if (l) l.departDate = st.endDate; renderStops(); schedule(); } } })),
      field('Flexibility', h('select', { on: { change: (e: Event) => { st.flexDays = Number((e.target as HTMLSelectElement).value); schedule(); } } }, ...[0, 1, 2, 3].map((n) => h('option', { value: n, selected: n === st.flexDays }, n ? `± ${n} days` : 'Exact'))))),
    list,
    h('button', { class: 'secondary small', on: { click: () => { const last = st.stops[st.stops.length - 1]; st.stops.push({ place: null, arriveDate: last?.departDate ?? st.startDate, departDate: st.endDate }); if (last) last.departDate = last.departDate; renderStops(); } } }, '+ Add another destination'),
    h('p', { class: 'hint' }, 'Each stop starts on the day you leave the previous one, so every night is covered.'));
}

function planTab(c: TabCtx) {
  const t = c.detail.trip;
  const gen = h('button', { class: 'primary', disabled: t.planStatus === 'generating', on: { click: async () => {
    gen.disabled = true;
    try { await post(`/api/trips/${c.id}/plan`, {}); toast('Researching current venues — this takes a minute'); await pollPlan(c); } catch (e) { toast((e as Error).message, 'error'); gen.disabled = false; }
  } } }, c.detail.days.length ? 'Regenerate whole plan' : 'Generate plan');
  const days = c.detail.days.map((d: any) => dayCard(c, d));
  replace(c.root, stopsEditor(c), h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Day by day'), gen),
    !c.detail.offers.some((o: any) => o.kind === 'flight' && o.selected) ? h('p', { class: 'notice info' }, 'Tip: select a flight first so arrival and departure days use real flight times.') : null,
    t.planStatus === 'generating' ? h('div', { class: 'notice info' }, loading('Researching venues, menus, hikes and weather…')) : null,
    days.length ? h('div', { class: 'days' }, ...days) : h('p', { class: 'empty' }, 'No itinerary yet.')));
  if (t.planStatus === 'generating') void pollPlan(c);
}

async function pollPlan(c: TabCtx) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!c.alive()) return;
    const d = await get(`/api/trips/${c.id}`);
    if (d.trip.planStatus !== 'generating') { await c.refresh(); return; }
  }
}

const KIND_ICON: Record<string, string> = { wake: '☀', breakfast: '☕', lunch: '🍽', dinner: '🍷', activity: '◆', hike: '⛰', transfer: '→', break: '·', checkin: '🛏', checkout: '🧳', flight: '✈', travel: '✈' };

function dayCard(c: TabCtx, d: any) {
  const w = d.weather;
  const otherDays = c.detail.days.filter((x: any) => x.date !== d.date);
  return h('article', { class: `day ${d.status}` },
    h('header', null,
      h('div', null, h('h3', null, fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })), h('p', { class: 'small' }, `${c.detail.stops.find((s: any) => s.id === d.stopId)?.place.name ?? ''} · times in ${d.timeZone}`)),
      h('div', { class: 'day-meta' },
        w ? h('span', { class: 'weather', title: w.kind === 'forecast' ? 'Forecast' : 'Historical climate average — not a forecast' }, `${w.kind === 'forecast' ? 'Forecast' : 'Typical'} ${w.tempMinC ?? '?'}–${w.tempMaxC ?? '?'}°C · ${w.precipitationProbability ?? '?'}% rain`) : badge('No weather data', 'muted'),
        d.status === 'complete' ? badge('Verified sources', 'ok') : badge('Incomplete', 'warn'))),
    d.missing?.length ? h('div', { class: 'notice warn' }, h('strong', null, 'Missing from this day: '), d.missing.join('; ')) : null,
    h('ol', { class: 'timeline' }, ...d.items.map((it: any) => itemRow(c, d, it, otherDays))),
    d.notes?.length ? h('ul', { class: 'day-notes' }, ...d.notes.map((n: string) => h('li', null, n))) : null,
    h('footer', null,
      h('button', { class: 'ghost small', on: { click: async () => { try { await post(`/api/trips/${c.id}/plan`, { date: d.date }); toast('Regenerating this day'); await pollPlan(c); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Regenerate day'),
      h('label', { class: 'small' }, 'Pace ', h('select', { on: { change: async (e: Event) => { try { await post(`/api/trips/${c.id}/days/${d.date}/reschedule`, { pace: (e.target as HTMLSelectElement).value, expectedVersion: d.version }); await c.refresh(); } catch (err) { toast((err as Error).message, 'error'); } } } },
        h('option', { value: '' }, '—'), h('option', { value: 'relaxed' }, 'Relaxed'), h('option', { value: 'moderate' }, 'Moderate'), h('option', { value: 'packed' }, 'Packed'))),
      h('span', { class: 'small muted' }, `Generated ${fmtDateTime(d.generatedAt)}`)));
}

function itemRow(c: TabCtx, d: any, it: any, otherDays: any[]) {
  const v = it.venue;
  const minor = ['transfer', 'break', 'wake'].includes(it.kind);
  const actions = ['activity', 'hike'].includes(it.kind) ? h('div', { class: 'item-actions' },
    h('button', { class: 'ghost small', on: { click: async () => { try { await post(`/api/trips/${c.id}/items/${it.id}/replace`, {}); toast('Finding an alternative'); await pollPlan(c); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Replace'),
    h('select', { 'aria-label': 'Move to day', class: 'small', on: { change: async (e: Event) => { const to = (e.target as HTMLSelectElement).value; if (!to) return; try { await post(`/api/trips/${c.id}/items/${it.id}/move`, { toDate: to }); await c.refresh(); } catch (err) { toast((err as Error).message, 'error'); (e.target as HTMLSelectElement).value = ''; } } } },
      h('option', { value: '' }, 'Move to…'), ...otherDays.map((x) => h('option', { value: x.date }, fmtDate(x.date))))) : null;
  return h('li', { class: `item ${it.kind}${minor ? ' minor' : ''}` },
    h('span', { class: 'time mono' }, it.startLocal.slice(11, 16)),
    h('span', { class: 'icon', 'aria-hidden': 'true' }, KIND_ICON[it.kind] ?? '·'),
    h('div', { class: 'item-body' },
      h('p', { class: 'item-title' }, it.title, it.bookingRequired === 'yes' ? badge('Book ahead', 'warn') : it.bookingRequired === 'recommended' ? badge('Reservation recommended', 'info') : null),
      v ? h('p', { class: 'small' }, v.address, ' · ', extLink(v.mapsUrl, 'Map'), v.website ? [' · ', extLink(v.website, 'Website')] : null) : null,
      it.why ? h('p', { class: 'why' }, it.why) : null,
      v?.price ? h('p', { class: 'small' }, `Price: ${v.price.text}`, v.price.provenance === 'estimate' ? ' (estimate)' : '') : null,
      v?.openingHours?.length ? h('details', { class: 'small' }, h('summary', null, 'Opening hours'), h('ul', null, ...v.openingHours.map((x: string) => h('li', null, x)))) : null,
      v?.dishes?.length ? h('ul', { class: 'dishes' }, ...v.dishes.map((x: any) => h('li', null, x.name, ' ', badge(x.dietStatus === 'confirmed' ? 'menu-labelled' : x.dietStatus === 'likely' ? 'check stock/sauce' : 'unconfirmed', x.dietStatus === 'confirmed' ? 'ok' : 'warn'), h('span', { class: 'small muted' }, ` ${x.note}`)))) : null,
      it.uncertainty ? h('p', { class: 'uncertainty' }, it.uncertainty) : null,
      it.sources?.length ? h('p', { class: 'sources small' }, 'Sources: ', ...it.sources.flatMap((s: any, i: number) => [i ? ', ' : '', extLink(s.url, s.title || s.provider)]), it.retrievedAt ? ` · retrieved ${fmtDateTime(it.retrievedAt)}` : '') : null,
      actions));
}

// ---------------------------------------------------------------- searches
async function runSearch(c: TabCtx, kind: string, out: HTMLElement, render: (s: any) => void, existingId?: string) {
  replace(out, loading(kind === 'flex' ? 'Comparing date combinations with live quotes… this can take a few minutes' : kind === 'destinations' ? 'Searching the cheapest destinations from every airport near you… (usually 10–40 seconds)' : 'Fetching live offers…'));
  try {
    // Resume a search that is already running instead of starting (and paying for) another one.
    const searchId = existingId ?? (await post(`/api/trips/${c.id}/searches`, { kind })).searchId;
    const s = await waitForSearch(searchId, undefined, kind === 'flex' ? 600000 : 180000, c.alive);
    if (!s || !c.alive()) return;
    await c.refresh();
  } catch (e) { if (c.alive()) replace(out, errorBox(e, () => runSearch(c, kind, out, render))); }
}

async function latest(c: TabCtx, kind: string) {
  const rows = await get(`/api/trips/${c.id}/searches`);
  const r = rows.find((x: any) => x.kind === kind);
  return r ? get(`/api/searches/${r.id}`) : null;
}

function searchPanel(c: TabCtx, kind: string, title: string, intro: string, render: (s: any, out: HTMLElement) => void) {
  const out = h('div');
  const btn = h('button', { class: 'primary', on: { click: () => runSearch(c, kind, out, (s) => render(s, out)) } }, 'Search live prices');
  replace(c.root, h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title), btn), h('p', { class: 'hint' }, intro), out));
  latest(c, kind).then((s) => { if (!c.alive()) return; if (s) { if (s.status === 'running') runSearch(c, kind, out, (x) => render(x, out), s.id); else render(s, out); } else replace(out); }).catch((e) => { if (c.alive()) replace(out, errorBox(e)); });
}

function searchMeta(s: any) {
  return h('p', { class: 'small muted' }, `Searched ${fmtDateTime(s.finishedAt ?? s.createdAt)}`, s.status === 'partial' ? ' · partial results' : '');
}

function flightsTab(c: TabCtx) {
  searchPanel(c, 'flight', 'Flights', 'Live offers from our flight provider, ranked by complete value (fare, baggage, transfers, timing). Prices are the lowest among offers retrieved, not a guaranteed market minimum.', (s, out) => {
    if (s.status === 'failed') { replace(out, errorBox(new Error(s.error ?? 'Search failed'))); return; }
    const roles = ['recommended', 'cheapest', 'convenient'];
    const short = roles.map((r) => s.offers.find((o: any) => o.role === r)).filter(Boolean);
    const others = s.offers.filter((o: any) => !o.role).slice(0, 10);
    replace(out, searchMeta(s), s.result?.notes?.length ? h('ul', { class: 'notes' }, ...s.result.notes.map((n: string) => h('li', null, n))) : null,
      h('div', { class: 'offer-grid' }, ...short.map((o: any) => flightCard(c, o))),
      others.length ? h('details', null, h('summary', null, `${others.length} more offers`), h('div', { class: 'offer-grid' }, ...others.map((o: any) => flightCard(c, o)))) : null);
  });
}

const ROLE_LABEL: Record<string, string> = { recommended: 'Recommended best value', cheapest: 'Lowest price found', convenient: 'More convenient', comfortable: 'More comfortable' };

function flightCard(c: TabCtx, o: any) {
  const f = o.data.offer;
  const expired = f.expiresAt && new Date(f.expiresAt) < new Date();
  const selected = c.detail.offers.some((x: any) => x.id === o.id && x.selected);
  return h('article', { class: `offer ${o.role ?? ''}` },
    o.role ? h('p', { class: 'role' }, ROLE_LABEL[o.role]) : null,
    h('p', { class: 'price' }, fmtMoney(o.total.amount, o.total.currency), h('span', { class: 'small' }, f.incomplete ? ' round trip from' : ' total')),
    ...f.slices.map((sl: any) => h('div', { class: 'slice' },
      h('p', { class: 'mono' }, `${sl.segments[0].departLocal.slice(0, 10)} · ${sl.segments[0].departLocal.slice(11, 16)} ${sl.from} → ${sl.segments.at(-1).arriveLocal.slice(11, 16)} ${sl.to}`, sl.segments.at(-1).arriveLocal.slice(0, 10) !== sl.segments[0].departLocal.slice(0, 10) ? h('sup', null, '+1') : null),
      h('p', { class: 'small' }, `${sl.segments.map((g: any) => `${g.carrierName} ${g.flightNumber}`).join(' + ')} · ${hrs(sl.durationMinutes)} · ${sl.segments.length - 1 ? `${sl.segments.length - 1} stop${sl.segments.length > 2 ? 's' : ''}` : 'direct'}`),
      sl.layovers.length ? h('p', { class: 'small' }, sl.layovers.map((l: any) => `${l.airport} ${hrs(l.minutes)}${l.overnight ? ' (overnight)' : ''}`).join(', ')) : null)),
    h('p', { class: 'small' }, `Bags: ${f.baggage.source === 'unknown' ? 'not reported' : `${f.baggage.checkedBags} checked, ${f.baggage.carryOn} cabin`} · Refund: ${f.conditions.refundable === null ? 'unknown' : f.conditions.refundable ? 'allowed' : 'not allowed'} · Changes: ${f.conditions.changeable === null ? 'unknown' : f.conditions.changeable ? `allowed${f.conditions.changePenalty ? ` (fee ${fmtMoney(f.conditions.changePenalty.amount, f.conditions.changePenalty.currency)})` : ''}` : 'not allowed'}`),
    o.explanation ? h('p', { class: 'why' }, o.explanation) : null,
    f.incomplete ? h('p', { class: 'uncertainty' }, f.incomplete) : null,
    f.providerData?.priceNote ? h('p', { class: 'small muted' }, f.providerData.priceNote) : null,
    h('p', { class: 'small muted' }, `${f.owner} via ${o.provider === 'serpapi' ? 'Google Flights (SerpApi)' : o.provider} · quoted ${fmtDateTime(o.quotedAt)}${f.expiresAt ? ` · offer expires ${fmtDateTime(f.expiresAt)}` : ''} · price re-checked before booking`),
    expired ? badge('Expired — search again', 'bad') : h('button', { class: selected ? 'secondary' : 'primary', on: { click: () => bookingPanel(o, c.refresh) } }, selected ? 'Selected — continue booking' : 'Select this flight'));
}

function staysTab(c: TabCtx) {
  searchPanel(c, 'stay', 'Accommodation', 'Live availability for every night of every stop, ranked by total value: price incl. taxes, location versus your plan, cancellation terms and guest scores.', (s, out) => {
    if (s.status === 'failed' && !s.result) { replace(out, errorBox(new Error(s.error ?? 'Search failed'))); return; }
    const r = s.result;
    replace(out, searchMeta(s),
      r.coverage && !r.coverage.ok ? h('div', { class: 'notice warn' }, `Coverage problem: ${r.coverage.gaps.length} night(s) without a recommended stay, ${r.coverage.overlaps.length} overlapping.`) : h('p', { class: 'notice ok' }, `All ${r.requiredNights} nights are covered by the recommended stays.`),
      ...(r.advice ?? []).map((a: any) => h('p', { class: 'notice info' }, a.message)),
      ...r.perStop.map((p: any) => {
        const opts = s.offers.filter((o: any) => o.stopId === p.stopId && o.role);
        return h('section', { class: 'stop-stays' }, h('h3', null, `${p.stopName} · ${fmtDate(p.checkIn)} → ${fmtDate(p.checkOut)} · ${p.nights} night${p.nights > 1 ? 's' : ''}`),
          p.error ? errorBox(new Error(p.error)) : null,
          opts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'stays' },
            h('thead', null, h('tr', null, ...['', 'Property', 'Room', 'Total', 'Taxes/fees', 'Cancellation', 'Location', ''].map((x) => h('th', { scope: 'col' }, x)))),
            h('tbody', null, ...opts.map((o: any) => { const st = o.data.stay; return h('tr', null,
              h('td', null, badge(ROLE_LABEL[o.role], o.role === 'recommended' ? 'ok' : 'info')),
              h('td', null, h('strong', null, st.propertyName), h('br'), h('span', { class: 'small' }, st.address), st.reviewScore ? h('span', { class: 'small' }, ` · ${st.reviewScore}/10`) : null),
              h('td', null, `${st.roomType} · ${st.occupancy} guest${st.occupancy > 1 ? 's' : ''}`),
              h('td', { class: 'mono' }, fmtMoney(st.total.amount, st.total.currency)),
              h('td', { class: 'mono' }, st.taxesAndFees ? fmtMoney(st.taxesAndFees.amount, st.taxesAndFees.currency) : 'not itemised'),
              h('td', null, st.cancellation.freeUntil ? `Free until ${fmtDate(st.cancellation.freeUntil)}` : st.cancellation.refundable === false ? 'Non-refundable' : st.cancellation.summary, h('br'), h('span', { class: 'small' }, `Payment: ${st.payment}`)),
              h('td', null, o.data.distanceToActivitiesKm !== null ? `${o.data.distanceToActivitiesKm.toFixed(1)} km from plan` : '—'),
              h('td', null, h('button', { class: 'secondary small', on: { click: () => bookingPanel(o, c.refresh) } }, 'Select'), h('p', { class: 'small muted' }, `${o.provider} · ${fmtDateTime(o.quotedAt)}`))); })))) : null,
          ...(p.externalOptions ?? []).map((x: any) => h('p', { class: 'small' }, extLink(x.url, `Search ${x.provider} yourself`), ` — ${x.note}`)));
      }));
  });
}

function flexTab(c: TabCtx) {
  if (!c.detail.trip.flexDays) { replace(c.root, h('section', { class: 'panel' }, h('h2', null, 'Flexible dates'), h('p', null, 'Set flexibility (±1 to ±3 days) under Itinerary → Route & dates to compare departure and return days independently.'))); return; }
  searchPanel(c, 'flex', 'Flexible dates', `Compares departure and return dates independently within ±${c.detail.trip.flexDays} days using complete trip cost — flights, accommodation for the resulting nights and transfers.`, (s, out) => {
    const r = s.result;
    if (!r) { replace(out, errorBox(new Error(s.error ?? 'Comparison failed'))); return; }
    const cur = c.detail.trip.currency;
    const total = (x: any) => (x?.total !== null && x?.total !== undefined ? fmtMoney(x.total, cur) : 'not fully quoted');
    const rows = [...r.combos].sort((a: any, b: any) => (a.total ?? 1e9) - (b.total ?? 1e9));
    replace(out, searchMeta(s),
      h('div', { class: 'compare' },
        h('div', { class: 'compare-col' }, h('p', { class: 'eyebrow' }, 'Your dates'), h('p', { class: 'mono' }, r.original ? `${r.original.combo.outbound} → ${r.original.combo.inbound}` : '—'), h('p', { class: 'price' }, total(r.original))),
        h('div', { class: 'compare-col highlight' }, h('p', { class: 'eyebrow' }, 'Recommended'), h('p', { class: 'mono' }, r.recommendation ? `${r.recommendation.combo.outbound} → ${r.recommendation.combo.inbound}` : '—'), h('p', { class: 'price' }, r.recommendation ? fmtMoney(r.recommendation.total, cur) : '—'),
          r.savings !== null ? h('p', null, r.savings > 0 ? `Saves ${fmtMoney(r.savings, cur)}` : r.savings === 0 ? 'Same cost' : `Costs ${fmtMoney(-r.savings, cur)} more`, r.savingsSupportedByQuotes ? ' (from returned quotes)' : ' (includes estimates)') : null)),
      r.tradeOffs?.length ? h('ul', { class: 'notes' }, ...r.tradeOffs.map((x: string) => h('li', null, x))) : null,
      r.coverage?.notes?.length ? h('div', { class: 'notice info' }, h('strong', null, 'Coverage: '), r.coverage.notes.join(' ')) : null,
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ...['Depart', 'Return', 'Nights', 'Flights', 'Accommodation', 'Complete total'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, ...rows.map((x: any) => h('tr', { class: r.recommendation && x.combo.outbound === r.recommendation.combo.outbound && x.combo.inbound === r.recommendation.combo.inbound ? 'rec' : '' },
          h('td', { class: 'mono' }, `${x.combo.outbound} (${x.combo.outShift >= 0 ? '+' : ''}${x.combo.outShift})`), h('td', { class: 'mono' }, `${x.combo.inbound} (${x.combo.inShift >= 0 ? '+' : ''}${x.combo.inShift})`), h('td', null, x.combo.nights),
          h('td', { class: 'mono' }, x.flight ? fmtMoney(x.flight.amount, cur) : '—'), h('td', { class: 'mono' }, x.stays ? fmtMoney(x.stays.reduce((a: number, b: any) => a + b.amount, 0), cur) : 'not quoted'), h('td', { class: 'mono' }, x.total !== null ? fmtMoney(x.total, cur) : '—')))))),
      r.recommendation ? h('button', { class: 'primary', on: { click: async () => {
        const rc = r.recommendation.combo; const t = c.detail.trip; const stops = c.detail.stops.map((s: any) => ({ place: s.place, arriveDate: s.arriveDate, departDate: s.departDate }));
        stops[0].arriveDate = rc.outbound; stops[stops.length - 1].departDate = rc.inbound;
        try { await patch(`/api/trips/${c.id}`, { version: t.version, changes: { startDate: rc.outbound, endDate: rc.inbound, stops } }); toast('Dates updated — search flights and stays again for bookable offers'); await c.refresh(); } catch (e) { toast((e as Error).message, 'error'); }
      } } }, 'Use recommended dates') : null);
  });
}

function discoverTab(c: TabCtx) {
  searchPanel(c, 'destinations', 'Destination ideas', 'The cheapest destinations for your dates from every airport near you, with Google flight and hotel prices and the weather (forecast where available, otherwise typical climate — always labelled). Uses one live search.', (s, out) => {
    if (s.status === 'failed') { replace(out, errorBox(new Error(s.error ?? 'No destinations could be verified'))); return; }
    const r = s.result;
    replace(out, searchMeta(s), h('p', { class: 'small' }, r.note), h('div', { class: 'offer-grid' }, ...r.destinations.map((d: any) => h('article', { class: 'offer' },
      h('h3', null, d.place.name), d.total !== null ? h('p', { class: 'price' }, fmtMoney(d.total, c.detail.trip.currency), h('span', { class: 'small' }, ' flights + stay')) : null,
      d.withinBudget === false ? badge('Over budget', 'warn') : d.withinBudget ? badge('Within budget', 'ok') : null,
      h('ul', { class: 'small' }, ...d.reasons.map((x: string) => h('li', null, x))), d.caveats.length ? h('p', { class: 'uncertainty' }, d.caveats.join(' ')) : null,
      h('button', { class: 'secondary', on: { click: async () => {
        const t = c.detail.trip;
        try { await patch(`/api/trips/${c.id}`, { version: t.version, changes: { title: t.title === 'New trip' ? `Trip to ${d.place.name}` : t.title, stops: [{ place: d.place, arriveDate: t.startDate, departDate: t.endDate }] } }); toast(`${d.place.name} added — fetching flights and stays`);
          for (const kind of ['flight', 'stay']) await post(`/api/trips/${c.id}/searches`, { kind }).catch(() => null);
          await c.refresh(); navigate(`/trips/${c.id}?tab=book`); } catch (e) { toast((e as Error).message, 'error'); }
      } } }, 'Choose this destination')))));
  });
}

// ---------------------------------------------------------------- bookings & reminders
function bookingsTab(c: TabCtx) {
  const res = c.detail.reservations;
  const selected = c.detail.offers.filter((o: any) => o.selected);
  replace(c.root, h('section', { class: 'panel' }, h('h2', null, 'Selected options'),
    selected.length ? h('ul', { class: 'list' }, ...selected.map((o: any) => h('li', null, `${o.kind === 'flight' ? 'Flight' : `Stay: ${o.data.stay.propertyName}`} · ${fmtMoney(o.total.amount, o.total.currency)} (checked ${fmtDateTime(o.quotedAt)}) `, h('button', { class: 'secondary small', on: { click: () => bookingPanel(o, c.refresh) } }, 'Continue booking')))) : h('p', { class: 'empty' }, 'Nothing selected yet.')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Reservations for this trip'), h('a', { class: 'button ghost small', href: '/bookings' }, 'Manage all & import from Gmail')),
      res.length ? h('ul', { class: 'list' }, ...res.map((r: any) => h('li', null, h('strong', null, `${r.kind} · ${r.providerName}`), r.confirmationCode ? h('span', { class: 'mono' }, ` · ${r.confirmationCode}`) : null,
        ' ', badge(r.reviewStatus === 'confirmed' ? 'Reviewed' : 'Needs review', r.reviewStatus === 'confirmed' ? 'ok' : 'warn'),
        r.kind === 'flight' ? badge(r.checkinStatus === 'customer_confirmed' ? 'Checked in (you confirmed)' : r.checkinStatus === 'provider_confirmed' ? 'Checked in (airline)' : 'Check-in not confirmed', r.checkinStatus.endsWith('confirmed') ? 'ok' : 'warn') : null))) : h('p', { class: 'empty' }, 'No reservations linked yet.')));
}

async function remindersTab(c: TabCtx) {
  try {
    const [ch, list] = await Promise.all([get('/api/notifications/channel'), get(`/api/trips/${c.id}/notifications`)]);
    const label: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'muted']> = { scheduled: ['Scheduled', 'info'], sending: ['Sending', 'info'], sent: ['Sent (awaiting delivery receipt)', 'info'], delivered: ['Delivered', 'ok'], read: ['Read', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', 'muted'] };
    replace(c.root, h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Reminders'), h('a', { class: 'button ghost small', href: '/notifications' }, 'Settings')),
      !ch.available ? h('p', { class: 'notice info' }, 'Automatic WhatsApp reminders are not available yet.') : !ch.optedIn ? h('p', { class: 'notice info' }, 'Reminders are off. Verify your number and opt in under Settings.') : null,
      list.length ? h('ul', { class: 'list' }, ...list.map((n: any) => h('li', null, h('strong', null, n.kind === 'pretrip_briefing' ? 'Pre-trip briefing' : 'Daily schedule'), ` · ${fmtDateTime(n.scheduledFor)} `, badge(...(label[n.status] ?? [n.status, 'muted'])), n.lastError && n.status !== 'delivered' ? h('span', { class: 'small muted' }, ` ${n.lastError}`) : null)))
        : h('p', { class: 'empty' }, 'No reminders scheduled for this trip.')));
  } catch (e) { replace(c.root, errorBox(e)); }
}
