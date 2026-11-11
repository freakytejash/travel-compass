// Dashboard: the first page for everyone. Visitors can pick their city and see upcoming holiday windows and
// nearby airports without an account; live prices and saved trips need sign-in (they use the free search allowance).
import { get } from '../api.ts';
import { fmtDate, h, replace } from '../dom.ts';
import { badge, errorBox, loading, placePicker } from '../components.ts';
import { navigate, session } from '../app.ts';
import { tripsList } from './trips.ts';
import type { Place } from '../../shared/types.ts';

const HOME_KEY = 'tc.home';
export function savedHome(): Place | null { try { return JSON.parse(localStorage.getItem(HOME_KEY) ?? 'null'); } catch { return null; } }
export function saveHome(p: Place | null) { try { if (p) localStorage.setItem(HOME_KEY, JSON.stringify(p)); else localStorage.removeItem(HOME_KEY); } catch { /* storage unavailable */ } }

export function windowCard(w: any, extra?: Node | null) {
  return h('li', { class: 'window-card' },
    h('p', { class: 'eyebrow mono' }, `${fmtDate(w.start)} → ${fmtDate(w.end)} · ${w.nights} night${w.nights > 1 ? 's' : ''}`),
    h('h3', null, w.label),
    h('p', { class: 'small' }, w.leaveDays === 0 ? badge('No leave days needed', 'ok') : badge(`${w.leaveDays} leave day${w.leaveDays > 1 ? 's' : ''}`, w.leaveDays <= 1 ? 'info' : 'muted'), w.needsBridgeDay ? ' bridge day' : ''),
    extra ?? null);
}

export async function homeView(root: HTMLElement) {
  const signedIn = !!session.user;
  let home: Place | null = savedHome();
  let prof: any = null;
  if (signedIn) {
    prof = await get('/api/profile').catch(() => null);
    if (prof && !prof.onboardingComplete) { navigate('/welcome'); return; }
    home = prof?.homePlace ?? home;
  }
  const windowsBox = h('div');
  const airportsBox = h('div');
  const showFor = async (p: Place | null) => {
    replace(airportsBox); replace(windowsBox);
    if (!p) return;
    const aps = p.kind === 'airport' ? [{ iata: p.iata, name: p.name }] : p.airports ?? [];
    replace(airportsBox, aps.length
      ? h('p', { class: 'small' }, 'Airports we compare for you: ', ...aps.map((a: any) => h('span', { class: 'chip mono' }, a.iata)), h('span', { class: 'muted' }, ' — plus other sizeable airports within 150 km when we search. The cheapest overall (fare + getting there) wins.'))
      : h('p', { class: 'small muted' }, 'No airport found near this place — try the nearest big city.'));
    if (!p.countryCode) return;
    replace(windowsBox, loading('Finding your next long weekends…'));
    try {
      const w = await get(`/api/public/windows?country=${p.countryCode}&months=6`);
      replace(windowsBox,
        h('h2', null, 'Best dates to get away'),
        h('p', { class: 'small muted' }, w.note, w.source ? [' Source: ', h('a', { href: w.source.url, target: '_blank', rel: 'noopener' }, w.source.name), '.'] : ''),
        h('ul', { class: 'window-grid' }, ...w.windows.slice(0, 8).map((x: any) => windowCard(x,
          h('a', { class: 'button small primary', href: `/ideas?window=${x.id}` }, signedIn ? 'Find trips for these dates' : 'See prices (sign in)')))));
    } catch (e) { replace(windowsBox, errorBox(e, () => showFor(p))); }
  };

  const picker = placePicker({ label: 'Where do you start from?', value: home, allowLocate: true, placeholder: 'Your city', onChange: (p) => { home = p; saveHome(p); void showFor(p); } });
  const hero = h('section', { class: 'hero panel' },
    h('h1', null, signedIn ? `Hi ${session.user!.displayName.split(' ')[0]} — where next?` : 'Where should you go next — and when?'),
    h('p', { class: 'lede' }, 'Pick your city. We find the long weekends and holiday weeks that save leave days, compare every airport near you, and suggest the cheapest good trips. Choose one and we line up the flights, stays, car rental and tickets to book.'),
    picker, airportsBox,
    h('div', { class: 'actions' },
      h('a', { class: 'button primary', href: '/ideas' }, 'Suggest trips for me'),
      h('a', { class: 'button secondary', href: signedIn ? '/trips/new' : '/register' }, signedIn ? 'I know where I want to go' : 'Create a free account')));

  const how = h('section', { class: 'panel how' }, h('h2', null, 'How it works'),
    h('ol', { class: 'steps' },
      h('li', null, h('strong', null, 'Dates: '), 'your country\'s public holidays and long weekends, ranked by leave days needed.'),
      h('li', null, h('strong', null, 'Airports: '), 'all sizeable airports near you in one search; travel to the airport is added to the price.'),
      h('li', null, h('strong', null, 'Ideas: '), 'cheapest destinations for those dates (Google flight + hotel prices), with the weather.'),
      h('li', null, h('strong', null, 'Book: '), 'best and cheapest flights and stays, plus hostels, Airbnb, car rental and tickets — you pay on the seller\'s site.')),
    signedIn ? null : h('p', { class: 'small muted' }, 'Browsing is free and needs no account. Live prices need a free account because each search uses part of a small monthly allowance.'));

  const trips = h('div');
  replace(root, h('div', { class: 'page' }, hero, windowsBox, signedIn ? trips : how, signedIn ? how : null));
  void showFor(home);
  if (signedIn) {
    replace(trips, loading());
    try {
      const [list, latest] = await Promise.all([get('/api/trips'), get('/api/ideas/latest').catch(() => null)]);
      replace(trips,
        latest?.result?.ideas?.length ? h('section', { class: 'panel' }, h('div', { class: 'page-head' }, h('h2', null, 'Your latest trip ideas'), h('a', { href: `/ideas?id=${latest.id}` }, 'Open')),
          h('p', { class: 'small muted' }, `${latest.result.ideas.length} ideas from ${latest.params.origin?.name ?? 'home'} · ${new Date(latest.createdAt).toLocaleDateString()}`)) : null,
        h('div', { class: 'page-head' }, h('h2', null, 'Your trips'), h('a', { class: 'button small primary', href: '/trips/new' }, 'Plan a trip')),
        tripsList(list));
    } catch (e) { replace(trips, errorBox(e)); }
  }
}
