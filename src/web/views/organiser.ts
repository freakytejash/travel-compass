// Booking organiser (reservations + Gmail import), notification settings and administrator dashboard.
import { del, get, patch, post, put } from '../api.ts';
import { fmtDate, fmtDateTime, fmtMoney, h, replace, toast } from '../dom.ts';
import { badge, errorBox, field, loading } from '../components.ts';

export async function bookingsView(root: HTMLElement) {
  replace(root, loading());
  try {
    const [res, gm, trips] = await Promise.all([get('/api/reservations'), get('/api/gmail'), get('/api/trips')]);
    if (new URLSearchParams(location.search).get('gmail') === 'connected') toast('Gmail connected — importing confirmations');
    const tripOpts = (cur: string | null) => [h('option', { value: '' }, 'Not linked'), ...trips.map((t: any) => h('option', { value: t.id, selected: t.id === cur }, t.title))];
    const gmail = h('section', { class: 'panel' }, h('h2', null, 'Import from Gmail'),
      !gm.available ? h('p', { class: 'notice info' }, 'Gmail import is not available yet.')
        : gm.connected ? h('div', null, h('p', null, `Connected to ${gm.accountEmail}. Last scan ${fmtDateTime(gm.lastSyncAt)}.`),
          h('button', { class: 'secondary', on: { click: async () => { await post('/api/gmail/sync'); toast('Scanning for new confirmations'); setTimeout(() => bookingsView(root), 4000); } } }, 'Scan again'), ' ',
          h('button', { class: 'ghost', on: { click: async () => { const delImported = confirm('Also delete reservations imported from Gmail? (Cancel keeps them)'); await post('/api/gmail/disconnect', { deleteImported: delImported }); toast('Gmail disconnected and access revoked'); bookingsView(root); } } }, 'Disconnect'))
          : h('div', null, h('p', null, 'Connect your own Gmail to find flight, accommodation and activity confirmations. We request read-only access, only scan travel-related messages, and you can disconnect at any time.'),
            h('button', { class: 'primary', on: { click: async () => { try { const { url } = await post('/api/gmail/connect'); location.href = url; } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Connect Gmail')));
    const manual = h('form', { class: 'grid3 manual', on: { submit: async (e: Event) => {
      e.preventDefault(); const fd = new FormData(manual);
      try { await post('/api/reservations', { kind: fd.get('kind'), providerName: fd.get('provider'), confirmationCode: fd.get('code') || null, startDate: fd.get('start') || null, endDate: fd.get('end') || null, tripId: fd.get('trip') || null }); toast('Added'); bookingsView(root); } catch (err) { toast((err as Error).message, 'error'); }
    } } }, field('Type', h('select', { name: 'kind' }, ...['flight', 'stay', 'activity', 'transport', 'other'].map((k) => h('option', { value: k }, k)))), field('Provider', h('input', { name: 'provider', required: true })), field('Reference', h('input', { name: 'code' })),
      field('Start', h('input', { name: 'start', type: 'date' })), field('End', h('input', { name: 'end', type: 'date' })), field('Trip', h('select', { name: 'trip' }, ...tripOpts(null))), h('button', { class: 'secondary' }, 'Add reservation'));
    replace(root, h('div', { class: 'page' }, h('h1', null, 'Bookings'), gmail,
      h('section', { class: 'panel' }, h('h2', null, 'Reservations'),
        res.length ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ...['Type', 'Provider', 'Reference', 'Dates', 'Trip', 'Source', 'Check-in', ''].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, ...res.map((r: any) => h('tr', { class: r.reviewStatus === 'needs_review' ? 'review' : '' },
            h('td', null, r.kind), h('td', null, r.details?.propertyName ?? r.providerName), h('td', { class: 'mono' }, r.confirmationCode ?? '—'),
            h('td', null, `${fmtDate(r.startAt)}${r.endAt ? ` – ${fmtDate(r.endAt)}` : ''}`),
            h('td', null, h('select', { 'aria-label': 'Trip', on: { change: async (e: Event) => { await patch(`/api/reservations/${r.id}`, { tripId: (e.target as HTMLSelectElement).value || null }); toast('Updated'); } } }, ...tripOpts(r.tripId))),
            h('td', null, r.source === 'gmail' ? h('span', null, 'Gmail', h('br'), h('span', { class: 'small muted' }, `${Math.round((r.extractionConfidence ?? 0) * 100)}% confidence · “${String(r.details?.emailSubject ?? '').slice(0, 40)}”`)) : r.source === 'booking_flow' ? 'Provider-confirmed' : 'Added by you'),
            h('td', null, r.kind === 'flight' ? h('select', { 'aria-label': 'Check-in status', on: { change: async (e: Event) => { await patch(`/api/reservations/${r.id}`, { checkinStatus: (e.target as HTMLSelectElement).value }); toast('Check-in status saved'); } } },
              ...[['unknown', 'Not confirmed'], ['not_open', 'Not open yet'], ['pending', 'To do'], ['customer_confirmed', 'I have checked in']].map(([v, l]) => h('option', { value: v, selected: r.checkinStatus === v }, l))) : '—'),
            h('td', null, r.reviewStatus === 'needs_review' ? h('button', { class: 'secondary small', on: { click: async () => { await patch(`/api/reservations/${r.id}`, { reviewStatus: 'confirmed' }); bookingsView(root); } } }, 'Looks right') : badge('Reviewed', 'ok'), ' ',
              h('button', { class: 'ghost small', on: { click: async () => { if (confirm('Remove this reservation record? (It does not cancel the booking.)')) { await del(`/api/reservations/${r.id}`); bookingsView(root); } } } }, 'Remove')))))))
          : h('p', { class: 'empty' }, 'No reservations yet.'),
        h('h3', null, 'Add one manually'), manual)));
  } catch (e) { replace(root, errorBox(e, () => bookingsView(root))); }
}

export async function notificationsView(root: HTMLElement) {
  replace(root, loading());
  try {
    const ch = await get('/api/notifications/channel');
    const phone = h('input', { type: 'tel', value: ch.phone ?? '', placeholder: '+32470123456', autocomplete: 'tel' });
    const code = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code' });
    const opts = { pretripBriefing: ch.pretripBriefing ?? true, dailySchedule: ch.dailySchedule ?? true, shareBookingRefs: ch.shareBookingRefs ?? false, dailyTime: ch.dailyTime ?? '07:30', pretripTime: ch.pretripTime ?? '18:00' };
    const chk = (k: 'pretripBriefing' | 'dailySchedule' | 'shareBookingRefs', label: string) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opts[k], on: { change: (e: Event) => (opts[k] = (e.target as HTMLInputElement).checked) } }), label);
    const telegram = ch.telegramAvailable ? h('section', { class: 'panel' }, h('h2', null, '1. Connect Telegram (free)'),
      ch.telegramConnected ? h('p', { class: 'notice ok' }, `Connected to @${ch.telegramBot}.`) : h('p', null, `Open the link, press Start in Telegram, then come back and refresh this page.`),
      h('button', { class: ch.telegramConnected ? 'ghost' : 'primary', on: { click: async () => { try { const { url } = await post('/api/notifications/telegram'); window.open(url, '_blank', 'noopener'); toast('Press Start in Telegram, then refresh'); } catch (e) { toast((e as Error).message, 'error'); } } } }, ch.telegramConnected ? 'Reconnect Telegram' : 'Connect Telegram'),
      ' ', h('button', { class: 'ghost', on: { click: () => notificationsView(root) } }, 'Refresh status')) : null;
    const whatsapp = ch.whatsappAvailable ? h('section', { class: 'panel' }, h('h2', null, `${ch.telegramAvailable ? 'Or: ' : '1. '}verify a WhatsApp number`), ch.kind === 'whatsapp' && ch.verified ? h('p', { class: 'notice ok' }, `Verified: ${ch.phone}`) : null,
      field('WhatsApp number (international format)', phone),
      h('button', { class: 'secondary', on: { click: async () => { try { await post('/api/notifications/phone', { phone: phone.value.trim() }); toast('Code sent on WhatsApp'); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Send code'),
      field('Code', code), h('button', { class: 'secondary', on: { click: async () => { try { await post('/api/notifications/phone/verify', { code: code.value.trim() }); toast('Number verified'); notificationsView(root); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Verify')) : null;
    const cmbPhone = h('input', { type: 'tel', value: ch.kind === 'callmebot' ? ch.phone ?? '' : '', placeholder: '+32470123456', autocomplete: 'tel' });
    const cmbKey = h('input', { inputmode: 'numeric', placeholder: 'Key from the CallMeBot message', autocomplete: 'off' });
    const cmbCode = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code' });
    const callmebot = ch.callmebotAvailable ? h('section', { class: 'panel' }, h('h2', null, `${ch.telegramAvailable ? 'Or: ' : '1. '}WhatsApp, free (CallMeBot)`),
      ch.kind === 'callmebot' && ch.verified ? h('p', { class: 'notice ok' }, `Connected: ${ch.phone}`) : null,
      h('ol', { class: 'small' },
        h('li', null, 'Save +34 684 78 37 08 in your phone contacts (the CallMeBot number; check it on callmebot.com).'),
        h('li', null, 'In WhatsApp, send it: I allow callmebot to send me messages'),
        h('li', null, 'Copy the API key it replies with and enter it below with your number.')),
      h('p', { class: 'small muted' }, 'Free for personal use. It can only message your own number, and gives no delivery receipts, so reminders show as "sent".'),
      field('Your WhatsApp number (international format)', cmbPhone), field('CallMeBot API key', cmbKey),
      h('button', { class: 'secondary', on: { click: async () => { try { await post('/api/notifications/callmebot', { phone: cmbPhone.value.trim(), apiKey: cmbKey.value.trim() }); toast('Code sent to your WhatsApp'); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Send test code'),
      field('Code from WhatsApp', cmbCode),
      h('button', { class: 'secondary', on: { click: async () => { try { await post('/api/notifications/phone/verify', { code: cmbCode.value.trim() }); toast('WhatsApp connected'); notificationsView(root); } catch (e) { toast((e as Error).message, 'error'); } } } }, 'Verify')) : null;
    const where = ch.kind === 'telegram' ? 'Telegram' : 'WhatsApp';
    replace(root, h('div', { class: 'page narrow' }, h('h1', null, 'Reminders'),
      !ch.available ? h('p', { class: 'notice info' }, 'Automatic reminders are not available yet. Nothing will be scheduled until they are.') : null,
      telegram, callmebot, whatsapp,
      h('section', { class: 'panel' }, h('h2', null, '2. Choose what to receive'),
        chk('pretripBriefing', 'Briefing the day before departure (flight, check-in, wake-up and leave times, stay, weather, first day)'),
        field('Send briefing at', h('input', { type: 'time', value: opts.pretripTime, on: { input: (e: Event) => (opts.pretripTime = (e.target as HTMLInputElement).value) } })),
        chk('dailySchedule', 'Each morning during the trip: that day’s schedule and food'),
        field('Send daily at (local time where you are)', h('input', { type: 'time', value: opts.dailyTime, on: { input: (e: Event) => (opts.dailyTime = (e.target as HTMLInputElement).value) } })),
        chk('shareBookingRefs', 'Include booking references in messages'),
        h('p', { class: 'small' }, ch.kind === 'telegram' ? 'Send /stop to the bot at any time to opt out.' : ch.kind === 'callmebot' ? 'Use “Turn off reminders” here to stop them.' : 'Reply STOP at any time to opt out.'),
        h('div', { class: 'row' },
          h('button', { class: 'primary', disabled: !ch.verified, on: { click: async () => { try { await put('/api/notifications/consent', { optIn: true, ...opts }); toast(`Reminders on (${where}) — scheduled for your upcoming trips`); notificationsView(root); } catch (e) { toast((e as Error).message, 'error'); } } } }, ch.optedIn ? 'Save settings' : 'Turn on reminders'),
          ch.optedIn ? h('button', { class: 'ghost', on: { click: async () => { await put('/api/notifications/consent', { optIn: false }); toast('Reminders turned off; scheduled messages cancelled'); notificationsView(root); } } }, 'Turn off reminders') : null))));
  } catch (e) { replace(root, errorBox(e, () => notificationsView(root))); }
}

export async function adminView(root: HTMLElement) {
  replace(root, loading());
  try {
    const [ready, usage, notif, errs, health, stats] = await Promise.all(['readiness', 'usage', 'notifications', 'errors', 'health', 'stats'].map((p) => get(`/api/admin/${p}`)));
    const statusBadge = (i: any) => i.status === 'configured' ? (i.verifiedLive ? badge('Configured · verified live', 'ok') : badge('Configured · not yet verified live', 'warn')) : i.status === 'disabled' ? badge('Disabled', 'muted') : badge('Awaiting credentials', 'bad');
    replace(root, h('div', { class: 'page wide' }, h('h1', null, 'Administration'),
      h('section', { class: 'panel' }, h('h2', null, 'Service health'), h('p', null, health.ok ? badge('Healthy', 'ok') : badge('Degraded', 'bad'), ` DB latency ${health.dbLatencyMs} ms · jobs overdue ${health.jobs?.overdue ?? '?'} · running ${health.jobs?.running ?? '?'} · dead (24h) ${health.jobs?.dead24h ?? '?'}`),
        h('p', { class: 'small' }, `Users ${stats.users} · trips ${stats.trips} · complete plans ${stats.complete_plans} · delivered messages ${stats.delivered_notifications} · provider-confirmed bookings ${stats.completed_bookings}`)),
      h('section', { class: 'panel' }, h('h2', null, 'Integration readiness'), h('p', { class: 'small' }, '“Verified live” means this deployment has recorded at least one successful call to the provider. Secrets are never shown here; set them in the platform secret manager.'),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ...['Integration', 'Capability', 'Status', 'Missing', 'Owner approvals', '24h calls / errors'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, ...ready.map((i: any) => h('tr', null, h('td', null, h('strong', null, i.name), i.required ? h('span', { class: 'small muted' }, ' (core)') : null), h('td', null, i.capability), h('td', null, statusBadge(i)), h('td', { class: 'mono small' }, i.missing.join(', ') || '—'), h('td', { class: 'small' }, i.approvals.join('; ') || '—'), h('td', null, `${i.calls24h} / ${i.errors24h}`))))))),
      h('section', { class: 'panel' }, h('h2', null, 'Usage & cost (7 days)'), h('p', null, `AI cost today ≈ ${fmtMoney(usage.aiCostTodayUsd, 'USD')} of ${fmtMoney(usage.aiDailyBudgetUsd, 'USD')} daily budget (estimate from token counts).`), h('p', null, `SerpApi searches this month: ${usage.serpapiUsedThisMonth} of ${usage.serpapiMonthlyLimit} (free plan guard).`),
        h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ...['Day', 'Provider', 'Calls', 'Errors', 'Tokens in/out', 'Cost (USD est.)', 'Avg latency'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, ...usage.rows.map((r: any) => h('tr', null, h('td', null, fmtDate(r.day)), h('td', null, r.provider), h('td', null, r.calls), h('td', null, r.errors), h('td', null, `${r.tokens_in}/${r.tokens_out}`), h('td', null, r.cost_usd.toFixed(3)), h('td', null, `${r.avg_latency_ms} ms`))))))),
      h('section', { class: 'panel' }, h('h2', null, 'Notification failures'), notif.notifications.length ? h('ul', { class: 'list' }, ...notif.notifications.map((n: any) => h('li', null, `${n.kind} · ${n.email} · ${n.status} · attempts ${n.attempts} · ${n.last_error ?? ''}`))) : h('p', { class: 'empty' }, 'None.'),
        notif.deadJobs.length ? h('details', null, h('summary', null, `${notif.deadJobs.length} dead jobs`), h('ul', null, ...notif.deadJobs.map((j: any) => h('li', { class: 'small' }, `#${j.id} ${j.queue} (${j.attempts}) ${j.last_error ?? ''}`)))) : null),
      h('section', { class: 'panel' }, h('h2', null, 'Recent errors'), errs.length ? h('ul', { class: 'list small' }, ...errs.slice(0, 50).map((e: any) => h('li', null, `${fmtDateTime(e.created_at)} · ${e.source} · ${e.message}`))) : h('p', { class: 'empty' }, 'None.'))));
  } catch (e) { replace(root, errorBox(e, () => adminView(root))); }
}
