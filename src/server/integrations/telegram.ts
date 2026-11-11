// Telegram Bot API (free). Used for pre-trip briefings and daily schedules as a no-cost alternative to WhatsApp.
import crypto from 'node:crypto';
import { NotConfiguredError, ProviderError, requestJson } from './http.ts';
import type { ChatMessenger } from './types.ts';

export class TelegramBot implements ChatMessenger {
  name = 'telegram';
  private token?: string; private username?: string; private secret?: string;
  constructor(token?: string, username?: string, webhookSecret?: string) { this.token = token; this.username = username?.replace(/^@/, ''); this.secret = webhookSecret; }
  configured() { return !!this.token && !!this.username; }
  botUsername() { return this.username ?? null; }

  private async call<T>(method: string, body: unknown, op = method): Promise<T> {
    if (!this.token) throw new NotConfiguredError('Telegram', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']);
    const r = await requestJson<{ ok: boolean; result: T; description?: string }>(`https://api.telegram.org/bot${this.token}/${method}`, {
      provider: 'telegram', operation: op, method: 'POST', body, retries: method === 'sendMessage' ? 0 : 1, idempotent: method !== 'sendMessage', timeoutMs: 20000,
    });
    if (!r.ok) throw new ProviderError('telegram', r.description ?? 'request failed', 200, false);
    return r.result;
  }

  async sendText(chatId: string, text: string) {
    const m = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } });
    return { messageId: `tg:${chatId}:${m.message_id}` };
  }

  verifyWebhook(header: string | undefined) {
    if (!this.secret || !header) return false;
    const a = Buffer.from(header); const b = Buffer.from(this.secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async getUpdates(offset: number) {
    const r = await this.call<any[]>('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] }, 'getUpdates');
    return parseTelegramUpdates(r);
  }

  setWebhook(url: string) { return this.call('setWebhook', { url, secret_token: this.secret, allowed_updates: ['message'] }); }
}

export function parseTelegramUpdates(updates: any[]): { updateId: number; chatId: string; text: string }[] {
  return (updates ?? []).filter((u) => u?.message?.chat?.id !== undefined).map((u) => ({ updateId: u.update_id, chatId: String(u.message.chat.id), text: String(u.message.text ?? '') }));
}
