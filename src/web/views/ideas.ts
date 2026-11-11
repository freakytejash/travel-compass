// Trip ideas: holiday-aware dates × cheapest destinations from every airport near home. Choosing an idea creates
// the trip and starts flights, stays and itinerary searches, then opens the "Book everything" checklist.
import { ApiError, get, post } from '../api.ts';
import { extLink, fmtDate, fmtMoney, h, hrs, replace, toast } from '../dom.ts';
import { badge, errorBox, field, loading, placePicker } from '../components.ts';
import { navigate, session } from '../app.ts';
import { savedHome, saveHome, windowCard } from './home.ts';
import type { Place } from '../../shared/types.ts';

export async function ideasView(root: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const signedIn = !!session.user;
  const prof = signedIn ? await get('/api/profile').catch(() => null) : null;
  const st = { origin: (prof?.homePlace ?? savedHome()) as Place | null, months: 6, adults: 1, budget: (prof?.budgetTotal ?? null) as number | null, currency: (prof?.currency ?? 'EUR') as string, picked: new Set<string>(q.get('window') ? [q.get('window')!] : []) };
  const windowsBox = h('div'); const results = h('div', { 'aria-live': 'polite' });
  let windows: any[] = [];

  const renderWindows = () => replace(windowsBox, windows.length ? [
    h('h2', null, 'Pick up to 3 date windows (or let us choose)'),
    h('ul', { class: 'window-grid' }, ...windows.slice(0, 12).map((w) => windowCard(w, h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: st.picked.has(w.id), on: { change: (e: Event) => {
      const on = (e.target as HTMLInputElement).checked;
      if (on && st.picked.size >= 3) { (e.target as HTMLInputElement).checked = false; toast('Choose at most 3 windows — each one uses a live search.', 'error'); return; }
      if (on) st.picked.add(w.id); else st.picked.delete(w.id);
    } } }), 'Price these dates')))),
  ] : null);

  const loadWindows = async () => {
    if (!st.origin?.countryCode) { windows = []; renderWindows(); return; }
    replace(windowsBox, loading('Finding holidays and long weekends…'));
    try { windows = (await get(`/api/public/windows?country=${st.origin.countryCode}&months=${st.months}`)).windows; renderWindows(); }
    catch (e) { replace(windowsBox, errorBox(e, loadWindows)); }
  };

  const run = async () => {
    if (!signedIn) { navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); return; }
    if (!st.origin) { replace(results, errorBox(new Error('Choose your home city first.'))); return; }
    replace(results, loading('Searching every airport near you for the cheapest trips…'));
    try {
      const { ideaId } = await post('/api/ideas', { origin: st.origin, months: st.months, adults: st.adults, budget: st.budget, currency: st.currency, windowIds: [...st.picked] });
      history.replaceState(null, '', `/ideas?id=${ideaId}`);
      await poll(ideaId);
    } catch (e) { replace(results, errorBox(e, run)); }
  };

  const poll = async (id: string) => {
    const started = Date.now();
    for (;;) {
      const r = await get(`/api/ideas/${id}`);
      if (r.status !== 'running') { renderIdeas(r); return; }
      if (Date.now() - started > 150000) { replace(results, errorBox(new ApiError(0, 'timeout', 'Still searching — come back to this page in a minute.', true, null), () => poll(id))); return; }
      await new Promise((res) => setTimeout(res, 2000));
    }
  };

  const renderIdeas = (r: any) => {
    if (r.status === 'failed') { replace(results, errorBox(new Error(r.error ?? 'No ideas found.'), run)); return; }
    const res = r.result;
    const cur = r.params.currency;
    replace(results,
      h('div', { class: 'page-head' }, h('h2', null, 'Trip ideas'), badge(r.status === 'partial' ? 'Some dates missing' : 'Live prices', r.status === 'partial' ? 'warn' : 'ok')),
      h('p', { class: 'small' }, 'From any of: ', ...res.airports.map((a: any) => h('span', { class: 'chip mono', title: a.name }, `${a.iata}${a.km !== null ? ` · ${a.km} km` : ''}`))),
      h('ul', { class: 'idea-grid' }, ...res.ideas.map((x: any) => h('li', { class: 'idea-card' },
        x.destination.thumbnail ? h('img', { src: x.destination.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        h('div', { class: 'idea-body' },
          h('p', { class: 'eyebrow mono' }, `${fmtDate(x.window.start)} → ${fmtDate(x.window.end)} · ${x.nights}n · ${x.window.label}`),
          h('h3', null, `${x.destination.name}`, h('span', { class: 'muted small' }, ` ${x.destination.country} · ${x.destination.iata}`)),
          h('p', { class: 'price-line' }, h('strong', null, fmtMoney(x.total, cur)), h('span', { class: 'small muted' }, ' est. total')),
          h('p', { class: 'small' }, `Flight ${fmtMoney(x.flight.price, cur)}${x.flight.minutes ? ` · ${hrs(x.flight.minutes)}` : ''}${x.flight.stops === 0 ? ' · direct' : x.flight.stops ? ` · ${x.flight.stops} stop` : ''}${x.flight.airline ? ` · ${x.flight.airline}` : ''}`,
            h('br'), x.hotelPerNight !== null ? `Hotel from ${fmtMoney(x.hotelPerNight, cur)}/night` : 'Hotel price not shown',
            x.weather?.tempMaxC !== null && x.weather?.tempMaxC !== undefined ? [h('br'), `${x.weather.kind === 'forecast' ? 'Forecast' : 'Typical'} ${Math.round(x.weather.tempMaxC)}°C${x.weather.precipitationProbability !== null ? ` · ${Math.round(x.weather.precipitationProbability)}% rain` : ''}`] : null),
          x.reasons.length ? h('ul', { class: 'reasons small' }, ...x.reasons.map((t: string) => h('li', null, t))) : null,
          x.caveats.length ? h('ul', { class: 'caveats small' }, ...x.caveats.map((t: string) => h('li', null, t))) : null,
          h('div', { class: 'actions' },
            h('button', { class: 'primary small', on: { click: async (e: Event) => {
              const b = e.target as HTMLButtonElement; b.disabled = true; b.textContent = 'Creating trip…';
              try { const c = await post(`/api/ideas/${r.id}/choose`, { index: x.index }); toast('Trip created — fetching flights, stays and a day plan'); navigate(`/trips/${c.tripId}?tab=book`); }
              catch (err) { b.disabled = false; b.textContent = 'Choose this trip'; toast((err as Error).message, 'error'); }
            } } }, 'Choose this trip'),
            x.link ? extLink(x.link, 'See on Google') : null))))),
      ...res.notes.map((n: string) => h('p', { class: 'small muted' }, n)),
      res.holidaySource ? h('p', { class: 'small muted' }, 'Holiday data: ', extLink(res.holidaySource.url, res.holidaySource.name)) : null);
  };

  const form = h('div', { class: 'panel stack' },
    placePicker({ label: 'Starting from', value: st.origin, allowLocate: true, placeholder: 'Your city', onChange: (p) => { st.origin = p; saveHome(p); st.picked.clear(); void loadWindows(); } }),
    h('div', { class: 'grid3' },
      field('Look ahead', h('select', { on: { change: (e: Event) => { st.months = Number((e.target as HTMLSelectElement).value); void loadWindows(); } } }, ...[2, 3, 6, 9, 12].map((m) => h('option', { value: m, selected: m === st.months }, `${m} months`)))),
      field('Travellers', h('input', { type: 'number', min: 1, max: 9, value: st.adults, on: { input: (e: Event) => (st.adults = Number((e.target as HTMLInputElement).value) || 1) } })),
      field(`Budget per trip (${st.currency})`, h('input', { type: 'number', min: 0, value: st.budget ?? '', placeholder: 'Any', on: { input: (e: Event) => { const v = (e.target as HTMLInputElement).value; st.budget = v ? Number(v) : null; } } }))),
    h('button', { class: 'primary', on: { click: run } }, signedIn ? 'Find the best trips' : 'Sign in to see live prices'),
    h('p', { class: 'small muted' }, 'Each date window you price uses one live search from the free monthly allowance. Without a pick we choose the 3 windows that need the fewest leave days.'));

  replace(root, h('div', { class: 'page' }, h('h1', null, 'Suggest trips for me'), h('p', { class: 'lede' }, 'Holiday-smart dates, every airport near you, the cheapest good destinations.'), form, windowsBox, results));
  void loadWindows();
  const id = q.get('id');
  if (id && signedIn) { replace(results, loading()); void poll(id).catch((e) => replace(results, errorBox(e))); }
}
