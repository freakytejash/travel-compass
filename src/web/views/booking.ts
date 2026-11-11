// Booking dialog: select → live price check → traveller details → explicit review → provider handoff.
import { ApiError, post } from '../api.ts';
import { fmtDateTime, fmtMoney, h, replace, toast } from '../dom.ts';
import { errorBox, field, loading } from '../components.ts';

export async function bookingPanel(offer: any, onDone: () => Promise<void>) {
  const dlg = h('dialog', { class: 'booking', 'aria-labelledby': 'bk-title' });
  const body = h('div');
  dlg.append(h('header', null, h('h2', { id: 'bk-title' }, offer.kind === 'flight' ? 'Book this flight' : `Book ${offer.data.stay.propertyName}`), h('button', { class: 'ghost', 'aria-label': 'Close', on: { click: () => dlg.close() } }, '×')), body);
  dlg.addEventListener('close', () => { dlg.remove(); void onDone(); });
  document.body.appendChild(dlg); dlg.showModal();
  replace(body, loading('Selecting…'));
  let s: any;
  try { s = await post(`/api/offers/${offer.id}/select`); } catch (e) { replace(body, errorBox(e)); return; }
  const step = h('div');
  replace(body, h('ol', { class: 'steps' }, ...(offer.provider === 'duffel' ? ['Check price', 'Traveller details', 'Review', 'Pay on provider site'] : ['Check price', 'Review', 'Choose seller & pay on their site']).map((x) => h('li', null, x))), step,
    h('p', { class: 'small muted' }, 'Travel Compass never takes payment or stores card details, and nothing is booked until you complete payment on the provider’s own page.'));
  const show = (x: any) => { s = x; render(); };
  const render = () => {
    if (s.state === 'selected') {
      replace(step, h('p', null, `Quoted ${fmtMoney(s.originalAmount, s.currency)} at ${fmtDateTime(offer.quotedAt)}. Prices change; we re-check with the provider before you continue.`),
        h('button', { class: 'primary', on: { click: async (e: Event) => { (e.target as HTMLButtonElement).disabled = true; replace(step, loading('Checking current price and availability…')); try { show(await post(`/api/booking-sessions/${s.id}/reprice`)); } catch (err) { replace(step, errorBox(err, render)); } } } }, 'Check current price'));
      return;
    }
    if (s.state === 'expired' || s.state === 'failed') { replace(step, h('div', { class: 'notice error' }, h('p', null, s.error ?? 'This option is no longer available.')), h('button', { class: 'secondary', on: { click: () => dlg.close() } }, 'Back to results')); return; }
    if (['repriced', 'price_changed', 'details_collected'].includes(s.state)) {
      const changed = s.state === 'price_changed' || (s.repricedAmount !== null && s.repricedAmount !== s.originalAmount);
      const priceBox = h('div', { class: `notice ${changed ? 'warn' : 'ok'}` }, h('p', null, changed ? `Price changed: ${fmtMoney(s.originalAmount, s.currency)} → ${fmtMoney(s.repricedAmount, s.currency)}` : `Price confirmed: ${fmtMoney(s.repricedAmount, s.currency)}`));
      // Only needed when we prepare the provider order ourselves (Duffel); Google Flights sellers collect details on their own site.
      const needDetails = offer.kind === 'flight' && offer.provider === 'duffel' && !s.hasTravellerDetails;
      if (needDetails) { replace(step, priceBox, travellerForm(s, show, offer)); return; }
      const ack = h('input', { type: 'checkbox', id: 'ack' });
      const cond = s.conditions ?? {};
      replace(step, priceBox,
        h('h3', null, 'Important conditions'),
        offer.kind === 'flight' ? h('ul', null, h('li', null, `Refunds: ${cond.refundable === null ? 'not reported by the provider' : cond.refundable ? 'allowed' : 'not allowed'}`), h('li', null, `Changes: ${cond.changeable === null ? 'not reported' : cond.changeable ? `allowed${cond.changePenalty ? `, fee ${fmtMoney(cond.changePenalty.amount, cond.changePenalty.currency)}` : ''}` : 'not allowed'}`), h('li', null, 'Baggage as shown on the offer; extra bags cost more.'))
          : h('ul', null, h('li', null, cond.freeUntil ? `Free cancellation until ${fmtDateTime(cond.freeUntil)}` : cond.summary ?? 'See provider terms')),
        h('label', { class: 'check', for: 'ack' }, ack, ` I have reviewed the total of ${fmtMoney(s.repricedAmount, s.currency)} and these conditions for this specific ${offer.kind === 'flight' ? 'flight' : 'stay'}.`),
        h('button', { class: 'primary', on: { click: async () => {
          try { show(await post(`/api/booking-sessions/${s.id}/handoff`, { acceptedAmount: s.repricedAmount, acceptedCurrency: s.currency, acceptConditions: ack.checked })); }
          catch (err) { if (err instanceof ApiError && (err.code === 'quote_stale' || err.code === 'price_mismatch')) { toast(err.message, 'error'); show(await post(`/api/booking-sessions/${s.id}/reprice`)); } else replace(step, errorBox(err, render)); }
        } } }, 'Continue to secure checkout'));
      return;
    }
    if (s.state === 'ready_for_handoff' || s.state === 'handed_off') {
      const ho = s.handoff;
      if (ho.type === 'choices') {
        const mark = () => { void post(`/api/booking-sessions/${s.id}/handed-off`).catch(() => {}); };
        replace(step, h('div', { class: 'notice info' }, h('p', null, ho.note)),
          h('ul', { class: 'list' }, ...ho.choices.map((c: any) => h('li', { class: 'row' }, h('strong', null, c.label), c.price !== null ? h('span', { class: 'mono' }, ` ${fmtMoney(c.price, c.currency)}`) : null, ' ',
            c.method === 'POST'
              ? h('form', { method: 'POST', action: c.url, target: '_blank', rel: 'noopener', on: { submit: mark } }, ...Object.entries(c.fields ?? {}).map(([k, v]) => h('input', { type: 'hidden', name: k, value: String(v) })), h('button', { class: 'primary small' }, 'Go to seller'))
              : h('a', { class: 'button primary small', href: c.url, target: '_blank', rel: 'noopener noreferrer', on: { click: mark } }, 'Go to seller')))),
          h('p', { class: 'small' }, 'After booking, import the confirmation from Gmail or add the reference under Bookings.'));
        return;
      }
      replace(step, h('div', { class: 'notice info' }, h('p', null, ho.note)),
        h('a', { class: 'button primary', href: ho.url, target: '_blank', rel: 'noopener noreferrer', on: { click: () => { void post(`/api/booking-sessions/${s.id}/handed-off`).catch(() => {}); } } }, `Open ${ho.provider} to review and pay`),
        h('p', { class: 'small' }, 'After booking, the confirmation email can be imported automatically from Gmail, or add the reference under Bookings.'));
      return;
    }
    if (s.state === 'completed') { replace(step, h('div', { class: 'notice ok' }, h('p', null, `Booked — provider reference ${s.providerOrderRef}.`))); return; }
    replace(step, h('p', null, `Status: ${s.state}`));
  };
  render();
}

function travellerForm(s: any, show: (x: any) => void, offer: any) {
  void offer;
  const rows = h('div');
  const add = () => rows.append(h('fieldset', { class: 'traveller' }, h('legend', null, `Traveller ${rows.children.length + 1} (as on passport)`),
    h('div', { class: 'grid3' }, field('Title', h('select', { name: 'title' }, ...['ms', 'mr', 'mrs', 'miss', 'dr'].map((t) => h('option', { value: t }, t)))), field('Given names', h('input', { name: 'givenName', required: true, autocomplete: 'given-name' })), field('Surname', h('input', { name: 'familyName', required: true, autocomplete: 'family-name' }))),
    h('div', { class: 'grid3' }, field('Date of birth', h('input', { name: 'bornOn', type: 'date', required: true })), field('Gender (as on passport)', h('select', { name: 'gender' }, h('option', { value: 'f' }, 'F'), h('option', { value: 'm' }, 'M'), h('option', { value: 'x' }, 'X'))), field('Phone', h('input', { name: 'phone', type: 'tel', placeholder: '+32…', required: true, autocomplete: 'tel' }))),
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' }))));
  add();
  const msg = h('div');
  const f = h('form', { class: 'stack', on: { submit: async (e: Event) => {
    e.preventDefault();
    const travellers = [...rows.querySelectorAll('fieldset')].map((fs) => Object.fromEntries([...fs.querySelectorAll('input,select')].map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])));
    try { show(await post(`/api/booking-sessions/${s.id}/travellers`, { travellers })); } catch (err) { replace(msg, errorBox(err)); }
  } } }, rows, h('button', { type: 'button', class: 'ghost small', on: { click: add } }, '+ Add traveller'), h('p', { class: 'small muted' }, 'Details are encrypted and deleted after handoff.'), msg, h('button', { class: 'primary' }, 'Save travellers'));
  return f;
}
