// WhatsApp Cloud API (Meta) and transactional email (Resend).
import crypto from 'node:crypto';
import { log } from '../log.ts';
import { NotConfiguredError, requestJson } from './http.ts';
import type { Mailer, Messenger } from './types.ts';

export class WhatsAppCloud implements Messenger {
  name = 'whatsapp_cloud';
  private token?: string; private phoneId?: string; private appSecret?: string; private version: string;
  constructor(token: string | undefined, phoneId: string | undefined, appSecret: string | undefined, version: string) {
    this.token = token; this.phoneId = phoneId; this.appSecret = appSecret; this.version = version;
  }
  configured() { return !!this.token && !!this.phoneId && !!this.appSecret; }
  async sendTemplate(to: string, template: string, params: string[], language: string) {
    if (!this.configured()) throw new NotConfiguredError('WhatsApp Cloud API', ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET']);
    const r = await requestJson<{ messages?: { id: string }[] }>(`https://graph.facebook.com/${this.version}/${this.phoneId}/messages`, {
      provider: 'whatsapp', operation: `send.${template}`, method: 'POST', retries: 0, // retries are handled by the job queue with dedupe protection
      headers: { Authorization: `Bearer ${this.token}` },
      body: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'template',
        template: { name: template, language: { code: language }, components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p.slice(0, 1000) })) }] : [] },
      },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new Error('WhatsApp did not return a message id');
    return { messageId: id };
  }
  verifySignature(raw: Buffer, header: string | undefined): boolean {
    if (!this.appSecret || !header?.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', this.appSecret).update(raw).digest('hex');
    const got = header.slice(7);
    return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
  }
}

export interface WhatsAppStatus { id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp: string; errors?: { code: number; title: string }[] }
export function parseWhatsAppStatuses(payload: any): WhatsAppStatus[] {
  const out: WhatsAppStatus[] = [];
  for (const e of payload?.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
    if (s?.id && ['sent', 'delivered', 'read', 'failed'].includes(s.status)) out.push({ id: s.id, status: s.status, timestamp: s.timestamp, errors: s.errors });
  }
  return out;
}
/** Inbound messages: used for STOP/opt-out keywords. */
export function parseWhatsAppInbound(payload: any): { from: string; text: string; id: string }[] {
  const out: { from: string; text: string; id: string }[] = [];
  for (const e of payload?.entry ?? []) for (const c of e.changes ?? []) for (const m of c.value?.messages ?? []) {
    out.push({ from: '+' + String(m.from).replace(/^\+/, ''), text: m.text?.body ?? m.button?.text ?? '', id: m.id });
  }
  return out;
}

/** Splits "Name <addr@x>" into parts. */
export function parseFrom(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2].trim() } : { email: from.trim() };
}

/** Wraps a plain-text email with one call-to-action link into simple, mobile-friendly HTML. */
export function emailHtml(text: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = /(https?:\/\/\S+)/.exec(text)?.[1];
  const body = esc(text).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
  const button = url ? `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open link</a></p>` : '';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;max-width:520px">${button}<p>${body}</p></div>`;
}

type Mail = { to: string; subject: string; text: string; html?: string };

/** Brevo transactional email (free plan: 300 emails/day). Works with a single verified sender address, no domain needed. */
export class BrevoMailer implements Mailer {
  name = 'brevo';
  private key?: string; private from: string;
  constructor(key: string | undefined, from: string) { this.key = key; this.from = from; }
  configured() { return !!this.key; }
  async send(m: Mail) {
    if (!this.key) throw new NotConfiguredError('Brevo', ['BREVO_API_KEY']);
    const sender = parseFrom(this.from);
    await requestJson('https://api.brevo.com/v3/smtp/email', {
      provider: 'brevo', operation: 'smtp.email', method: 'POST', retries: 1, headers: { 'api-key': this.key, accept: 'application/json' },
      body: { sender, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html ?? emailHtml(m.text) },
    });
  }
}

export class ResendMailer implements Mailer {
  name = 'resend';
  private key?: string; private from: string; private devLog: boolean;
  constructor(key: string | undefined, from: string, devLog: boolean) { this.key = key; this.from = from; this.devLog = devLog; }
  configured() { return !!this.key || this.devLog; }
  async send(m: Mail) {
    if (!this.key) {
      if (this.devLog) { log.info('DEV EMAIL (not sent; no email provider key)', { to: m.to, subject: m.subject, body: m.text }); return; }
      throw new NotConfiguredError('Resend', ['RESEND_API_KEY']);
    }
    if (/@resend\.dev>?\s*$/i.test(this.from)) log.warn('EMAIL_FROM uses resend.dev: Resend only delivers this to your own Resend account address. Verify a domain or use Brevo.', {});
    await requestJson('https://api.resend.com/emails', { provider: 'resend', operation: 'emails.send', method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: { from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html ?? emailHtml(m.text) } });
  }
}

/** Picks the configured email provider: Brevo, then Resend, then log-only. */
export function chooseMailer(o: { brevoKey?: string; resendKey?: string; from: string; devLog: boolean }): Mailer {
  if (o.brevoKey) return new BrevoMailer(o.brevoKey, o.from);
  return new ResendMailer(o.resendKey, o.from, o.devLog);
}
