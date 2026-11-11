import { get, post, put } from '../api.ts';
import { h, replace, toast } from '../dom.ts';
import { errorBox, field, loading, placePicker, select } from '../components.ts';
import { navigate } from '../app.ts';
import type { Place } from '../../shared/types.ts';

const INTERESTS = ['food', 'architecture', 'history', 'art', 'museums', 'hiking', 'nature', 'beaches', 'nightlife', 'markets', 'photography', 'music', 'cycling', 'wellness'];

/** Onboarding (first run) and profile editing share one form. */
export async function profileView(root: HTMLElement, onboarding = false) {
  replace(root, loading());
  let p: any;
  try { p = await get('/api/profile'); } catch (e) { replace(root, errorBox(e, () => profileView(root, onboarding))); return; }
  const state = { ...p, timeZone: p.timeZone === 'UTC' ? Intl.DateTimeFormat().resolvedOptions().timeZone : p.timeZone };
  const airports = h('div', { class: 'chips' });
  const renderAirports = () => replace(airports, ...state.departureAirports.map((a: any, i: number) => h('span', { class: 'chip' }, `${a.iata} · ${a.name}`, h('button', { type: 'button', 'aria-label': `Remove ${a.iata}`, on: { click: () => { state.departureAirports.splice(i, 1); renderAirports(); } } }, '×'))));
  renderAirports();
  const addAirport = placePicker({ label: 'Add a departure airport', value: null, allowLocate: true, placeholder: 'e.g. Brussels or CRL', onChange: (pl: Place | null) => {
    if (!pl) return;
    const list = pl.kind === 'airport' ? [{ iata: pl.iata!, name: pl.name, cityName: pl.cityName }] : (pl.airports ?? []).map((a) => ({ iata: a.iata, name: a.name, cityName: pl.name }));
    for (const a of list) if (!state.departureAirports.some((x: any) => x.iata === a.iata) && state.departureAirports.length < 5) state.departureAirports.push(a);
    renderAirports();
  } });
  const interests = h('fieldset', { class: 'chips toggle' }, h('legend', null, 'Interests'), ...INTERESTS.map((i) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: state.interests.includes(i), on: { change: (e: Event) => { const on = (e.target as HTMLInputElement).checked; state.interests = on ? [...state.interests, i] : state.interests.filter((x: string) => x !== i); } } }), i)));
  const num = (v: number | null, set: (n: number | null) => void, attrs: Record<string, unknown> = {}) => h('input', { type: 'number', inputmode: 'decimal', value: v ?? '', ...attrs, on: { input: (e: Event) => { const s = (e.target as HTMLInputElement).value; set(s === '' ? null : Number(s)); } } });
  const txt = (v: string, set: (s: string) => void, attrs: Record<string, unknown> = {}) => h('input', { value: v, ...attrs, on: { input: (e: Event) => set((e.target as HTMLInputElement).value) } });
  const msg = h('div', { 'aria-live': 'polite' });
  const save = h('button', { class: 'primary', type: 'submit' }, onboarding ? 'Save and start planning' : 'Save profile');
  const form = h('form', { class: 'profile-form', on: { submit: async (e: Event) => {
    e.preventDefault(); save.disabled = true; replace(msg);
    try {
      await put('/api/profile', { displayName: state.displayName, homePlace: state.homePlace, departureAirports: state.departureAirports, timeZone: state.timeZone, currency: state.currency.toUpperCase(), contactEmailOptIn: state.contactEmailOptIn,
        diet: state.diet, allergies: state.allergiesText !== undefined ? state.allergiesText.split(',').map((s: string) => s.trim()).filter(Boolean) : state.allergies, dietaryNotes: state.dietaryNotes, budgetTotal: state.budgetTotal, pace: state.pace,
        interests: state.interests, hikingExperience: state.hikingExperience, hikingDifficulty: state.hikingDifficulty, accommodationPref: state.accommodationPref, checkedBag: state.checkedBag, wakeTime: state.wakeTime, prepMinutes: state.prepMinutes, onboardingComplete: true });
      toast('Profile saved');
      if (onboarding) navigate('/trips/new');
    } catch (err) { replace(msg, errorBox(err)); } finally { save.disabled = false; }
  } } },
    h('fieldset', null, h('legend', null, 'About you'),
      field('Display name', txt(state.displayName ?? '', (s) => (state.displayName = s), { maxlength: 80 })),
      placePicker({ label: 'Home city', value: state.homePlace, allowLocate: true, onChange: (pl) => {
        state.homePlace = pl; if (pl?.timeZone) state.timeZone = pl.timeZone;
        // Pre-fill departure airports with the airports near home; the flight search also adds others within 150 km.
        if (pl && !state.departureAirports.length) { for (const a of pl.kind === 'airport' ? [{ iata: pl.iata!, name: pl.name, cityName: pl.cityName }] : (pl.airports ?? []).map((a) => ({ iata: a.iata, name: a.name, cityName: pl.name }))) if (state.departureAirports.length < 5) state.departureAirports.push(a); renderAirports(); }
      } }),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Preferred departure airports'), airports, h('small', { class: 'hint' }, 'Filled in from your home city. Flight searches also check other sizeable airports within 150 km in the same search and pick the cheapest overall, including getting to the airport.')), addAirport,
      h('div', { class: 'grid2' }, field('Time zone', txt(state.timeZone, (s) => (state.timeZone = s), { list: 'tzlist' })), field('Currency', txt(state.currency, (s) => (state.currency = s), { maxlength: 3, pattern: '[A-Za-z]{3}' }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.contactEmailOptIn, on: { change: (e: Event) => (state.contactEmailOptIn = (e.target as HTMLInputElement).checked) } }), 'Email me trip updates (optional)')),
    h('fieldset', null, h('legend', null, 'Food'),
      field('Diet', select(state.diet, [['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['pescatarian', 'Pescatarian'], ['none', 'No restriction']], (v) => (state.diet = v))),
      field('Allergies', txt((state.allergies ?? []).join(', '), (s) => (state.allergiesText = s), { placeholder: 'e.g. peanuts, sesame' }), 'Shown to you with every meal; venues’ allergen information is never assumed.'),
      field('Other dietary notes', txt(state.dietaryNotes, (s) => (state.dietaryNotes = s), { maxlength: 500 }))),
    h('fieldset', null, h('legend', null, 'Travel style'),
      h('div', { class: 'grid2' }, field('Total budget per trip', num(state.budgetTotal, (n) => (state.budgetTotal = n), { min: 0 })), field('Pace', select(state.pace, [['relaxed', 'Relaxed — 2 things a day'], ['moderate', 'Moderate — 3 a day'], ['packed', 'Packed — 4 a day']], (v) => (state.pace = v)))),
      interests,
      h('div', { class: 'grid2' }, field('Hiking experience', select(state.hikingExperience, [['none', 'No hiking'], ['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['experienced', 'Experienced']], (v) => (state.hikingExperience = v))),
        field('Preferred difficulty', select(state.hikingDifficulty, [['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard']], (v) => (state.hikingDifficulty = v)))),
      h('div', { class: 'grid2' }, field('Accommodation', select(state.accommodationPref, [['private', 'Private room'], ['dorm', 'Shared dorm'], ['any', 'Either']], (v) => (state.accommodationPref = v))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.checkedBag, on: { change: (e: Event) => (state.checkedBag = (e.target as HTMLInputElement).checked) } }), 'I usually travel with a checked bag')),
      h('div', { class: 'grid2' }, field('Usual wake-up time', h('input', { type: 'time', value: state.wakeTime, on: { input: (e: Event) => (state.wakeTime = (e.target as HTMLInputElement).value) } })),
        field('Minutes to get ready', num(state.prepMinutes, (n) => (state.prepMinutes = n ?? 0), { min: 0, max: 240 })))),
    msg, save);
  const tz = h('datalist', { id: 'tzlist' }, ...((Intl as any).supportedValuesOf?.('timeZone') ?? []).map((z: string) => h('option', { value: z })));
  replace(root, h('div', { class: 'page narrow' }, h('h1', null, onboarding ? 'Tell us how you travel' : 'Your travel profile'), onboarding ? h('p', { class: 'lede' }, 'This shapes every recommendation. You can change it any time.') : null, form, tz));
}

export async function accountView(root: HTMLElement) {
  const pw = h('form', { class: 'stack', on: { submit: async (e: Event) => {
    e.preventDefault(); const fd = new FormData(pw);
    try { await post('/api/account/password', { current: fd.get('current'), next: fd.get('next') }); toast('Password changed; other sessions signed out'); pw.reset(); } catch (err) { toast((err as Error).message, 'error'); }
  } } }, field('Current password', h('input', { type: 'password', name: 'current', autocomplete: 'current-password' })), field('New password', h('input', { type: 'password', name: 'next', autocomplete: 'new-password', minlength: 10 })), h('button', { class: 'secondary' }, 'Change password'));
  const confirmBox = h('input', { placeholder: 'Type DELETE to confirm', 'aria-label': 'Type DELETE to confirm' });
  replace(root, h('div', { class: 'page narrow' }, h('h1', null, 'Account & privacy'),
    h('section', { class: 'panel' }, h('h2', null, 'Your data'), h('p', null, 'Download everything Travel Compass stores about you: profile, trips, itineraries, sources, reservations, reminders and connections.'),
      h('a', { class: 'button secondary', href: '/api/account/export', download: 'travel-compass-export.json' }, 'Export my data (JSON)')),
    h('section', { class: 'panel' }, h('h2', null, 'Password'), pw),
    h('section', { class: 'panel danger' }, h('h2', null, 'Delete account'), h('p', null, 'Permanently deletes your account and all trips, reservations and reminders, revokes Gmail access and cancels scheduled messages. This cannot be undone. Bookings already made with providers are not cancelled.'),
      confirmBox, h('button', { class: 'danger', on: { click: async () => { try { await post('/api/account/delete', { confirm: confirmBox.value }); location.href = '/'; } catch (err) { toast((err as Error).message, 'error'); } } } }, 'Delete my account'))));
}
