import { get, setCsrf, post } from './api.ts';
import { h, replace } from './dom.ts';
import { forgotView, loginView, registerView, resetView, verifyEmailView } from './views/auth.ts';
import { accountView, profileView } from './views/profile.ts';
import { newTripView, tripsView } from './views/trips.ts';
import { tripView } from './views/trip.ts';
import { adminView, bookingsView, notificationsView } from './views/organiser.ts';
import { homeView } from './views/home.ts';
import { ideasView } from './views/ideas.ts';

export const session: { user: null | { id: string; email: string; role: string; displayName: string }; googleLogin: boolean } = { user: null, googleLogin: false };

export async function refreshSession() {
  const s = await get('/api/session');
  session.user = s.user; session.googleLogin = s.googleLogin; setCsrf(s.csrfToken);
}

export function navigate(path: string) { history.pushState(null, '', path); void route(); }

// Pages anyone can open without an account. Everything else asks to sign in and comes back afterwards.
const PUBLIC = ['/', '/ideas', '/login', '/register', '/verify-email', '/forgot-password', '/reset-password'];

function nav() {
  const u = session.user;
  const links: [string, string][] = u ? [['/', 'Dashboard'], ['/ideas', 'Trip ideas'], ['/bookings', 'Bookings'], ['/notifications', 'Reminders'], ['/profile', 'Profile'], ['/account', 'Account']] : [['/', 'Dashboard'], ['/ideas', 'Trip ideas'], ['/login', 'Sign in'], ['/register', 'Create account']];
  if (u?.role === 'admin') links.push(['/admin', 'Admin']);
  return h('header', { class: 'site' }, h('a', { class: 'brand', href: '/' }, h('span', { class: 'needle', 'aria-hidden': 'true' }, '◈'), 'Travel Compass'),
    h('nav', { 'aria-label': 'Main' }, ...links.map(([href, l]) => h('a', { href, 'aria-current': location.pathname === href ? 'page' : undefined }, l)),
      u ? h('button', { class: 'ghost small', on: { click: async () => { await post('/api/auth/logout'); await refreshSession(); navigate('/'); } } }, 'Sign out') : null));
}

export async function route() {
  const app = document.getElementById('app')!;
  const main = h('main', { id: 'main', tabindex: '-1' });
  replace(app, h('a', { class: 'skip', href: '#main' }, 'Skip to content'), nav(), main);
  const p = location.pathname;
  if (!session.user && !PUBLIC.includes(p)) { history.replaceState(null, '', `/login?next=${encodeURIComponent(p + location.search)}`); return loginView(main); }
  const m = /^\/trips\/([0-9a-f-]{36})(?:\/bookings)?$/.exec(p);
  if (p === '/login') return loginView(main);
  if (p === '/register') return registerView(main);
  if (p === '/verify-email') return verifyEmailView(main);
  if (p === '/forgot-password') return forgotView(main);
  if (p === '/reset-password') return resetView(main);
  if (p === '/welcome') return profileView(main, true);
  if (p === '/profile') return profileView(main);
  if (p === '/account') return accountView(main);
  if (p === '/bookings') return bookingsView(main);
  if (p === '/notifications') return notificationsView(main);
  if (p === '/admin') return adminView(main);
  if (p === '/trips/new') return newTripView(main);
  if (m) return tripView(main, m[1]);
  if (p === '/ideas') return ideasView(main);
  if (p === '/trips') return tripsView(main);
  if (p === '/') return homeView(main);
  replace(main, h('div', { class: 'page narrow' }, h('h1', null, 'Page not found'), h('a', { href: '/' }, 'Back to your trips')));
}

export async function start() {
  await refreshSession().catch(() => {});
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || e.metaKey || e.ctrlKey) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('/') && !href.startsWith('/api/')) { e.preventDefault(); navigate(href); }
  });
  window.addEventListener('popstate', () => void route());
  window.addEventListener('tc:unauthenticated', async () => { await refreshSession().catch(() => {}); if (!session.user && !PUBLIC.includes(location.pathname)) navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); });
  await route();
}
