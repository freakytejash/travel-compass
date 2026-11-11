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

export class ResendMailer implements Mailer {
  name = 'resend';
  private key?: string; private from: string; private devLog: boolean;
  constructor(key: string | undefined, from: string, devLog: boolean) { this.key = key; this.from = from; this.devLog = devLog; }
  configured() { return !!this.key || this.devLog; }
  async send(m: { to: string; subject: string; text: string; html?: string }) {
    if (!this.key) {
      if (this.devLog) { log.info('DEV EMAIL (not sent; RESEND_API_KEY missing)', { subject: m.subject, body: m.text }); return; }
      throw new NotConfiguredError('Resend', ['RESEND_API_KEY']);
    }
    await requestJson('https://api.resend.com/emails', { provider: 'resend', operation: 'emails.send', method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: { from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html } });
  }
}
