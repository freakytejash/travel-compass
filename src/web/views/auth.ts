import { ApiError, post } from '../api.ts';
import { h, replace, toast } from '../dom.ts';
import { errorBox, field } from '../components.ts';
import { navigate, refreshSession, session } from '../app.ts';

/** Where to go after signing in: a same-site path from ?next=, else the dashboard. */
export function nextPath() {
  const n = new URLSearchParams(location.search).get('next') ?? '/';
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/';
}

function card(title: string, sub: string, ...body: (Node | null)[]) {
  return h('section', { class: 'auth-card' }, h('h1', null, title), h('p', { class: 'lede' }, sub), ...body);
}

function form(onSubmit: (fd: FormData, msg: HTMLElement) => Promise<void>, ...fields: Node[]) {
  const msg = h('div', { 'aria-live': 'polite' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Continue');
  const f = h('form', { class: 'stack', on: { submit: async (e: Event) => {
    e.preventDefault(); btn.disabled = true; replace(msg);
    try { await onSubmit(new FormData(f), msg); } catch (err) { replace(msg, errorBox(err)); } finally { btn.disabled = false; }
  } } }, ...fields, msg, btn);
  return { f, btn };
}

export function loginView(root: HTMLElement) {
  const { f, btn } = form(async (fd, msg) => {
    try {
      await post('/api/auth/login', { email: fd.get('email'), password: fd.get('password') });
      await refreshSession(); navigate(nextPath());
    } catch (e) {
      if (e instanceof ApiError && e.code === 'email_not_verified') {
        replace(msg, h('div', { class: 'notice warn' }, h('p', null, e.message), h('button', { type: 'button', class: 'secondary small', on: { click: async () => { await post('/api/auth/resend-verification', { email: fd.get('email') }); toast('Verification email sent'); } } }, 'Send a new link')));
      } else throw e;
    }
  }, field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })), field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })));
  btn.textContent = 'Sign in';
  const google = session.googleLogin ? h('a', { class: 'button secondary block', href: '/api/auth/google/start' }, 'Continue with Google') : null;
  replace(root, card('Welcome back', 'Sign in to see your trips, bookings and reminders.', google, google ? h('div', { class: 'divider' }, 'or') : null, f,
    h('p', { class: 'small' }, h('a', { href: '/forgot-password' }, 'Forgot your password?'), ' · ', h('a', { href: '/register' }, 'Create an account'))));
}

export function registerView(root: HTMLElement) {
  const { f, btn } = form(async (fd, msg) => {
    const r = await post('/api/auth/register', { email: fd.get('email'), password: fd.get('password'), displayName: fd.get('name') });
    replace(msg, h('div', { class: 'notice ok' }, h('p', null, r.message)));
    f.querySelectorAll('input').forEach((i) => (i.disabled = true));
  }, field('Your name', h('input', { name: 'name', autocomplete: 'name', required: true, maxlength: 80 })), field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
    field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 10 }), 'At least 10 characters.'));
  btn.textContent = 'Create account';
  const google = session.googleLogin ? h('a', { class: 'button secondary block', href: '/api/auth/google/start' }, 'Sign up with Google') : null;
  replace(root, card('Plan trips that actually work', 'Real flights, real stays and a day-by-day plan with named places — built around how you travel.', google, google ? h('div', { class: 'divider' }, 'or') : null, f,
    h('p', { class: 'small' }, 'Already have an account? ', h('a', { href: '/login' }, 'Sign in'))));
}

export async function verifyEmailView(root: HTMLElement) {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  replace(root, card('Verifying…', 'One moment.'));
  try { await post('/api/auth/verify-email', { token }); await refreshSession(); toast('Email verified'); navigate('/welcome'); }
  catch (e) { replace(root, card('Link expired', 'Request a new verification email from the sign-in page.', errorBox(e), h('a', { class: 'button primary', href: '/login' }, 'Go to sign in'))); }
}

export function forgotView(root: HTMLElement) {
  const { f, btn } = form(async (fd, msg) => {
    const r = await post('/api/auth/forgot-password', { email: fd.get('email') });
    replace(msg, h('div', { class: 'notice ok' }, h('p', null, r.message)));
  }, field('Email', h('input', { name: 'email', type: 'email', required: true })));
  btn.textContent = 'Send reset link';
  replace(root, card('Reset your password', 'We will email you a link that is valid for one hour.', f));
}

export function resetView(root: HTMLElement) {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const { f, btn } = form(async (fd) => {
    await post('/api/auth/reset-password', { token, password: fd.get('password') });
    toast('Password updated — please sign in'); navigate('/login');
  }, field('New password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 10 })));
  btn.textContent = 'Set new password';
  replace(root, card('Choose a new password', 'All other sessions will be signed out.', f));
}
