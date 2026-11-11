// CallMeBot: a free WhatsApp gateway for PERSONAL use. Each person activates it for their own number by sending
// "I allow callmebot to send me messages" to the CallMeBot WhatsApp contact, and receives a personal API key.
// It can only message the number that activated the key. There are no delivery receipts.
import { ProviderError, requestJson } from './http.ts';

export class CallMeBot {
  name = 'callmebot';
  private enabled: boolean;
  constructor(enabled: boolean) { this.enabled = enabled; }
  configured() { return this.enabled; }

  async send(phoneE164: string, apiKey: string, text: string, userId?: string | null): Promise<{ messageId: string }> {
    const qs = new URLSearchParams({ phone: phoneE164, text: text.slice(0, 3500), apikey: apiKey });
    const body = await requestJson<string>(`https://api.callmebot.com/whatsapp.php?${qs}`, { provider: 'callmebot', operation: 'whatsapp.send', text: true, retries: 0, idempotent: false, timeoutMs: 30000, userId });
    // CallMeBot answers with an HTML page; failures mention an error or an invalid key.
    if (/apikey is invalid|invalid apikey|not activated|error/i.test(body) && !/message queued|will be sent|sent to/i.test(body)) {
      throw new ProviderError('callmebot', 'CallMeBot rejected the message (check the phone number and API key)', 200, false, body.slice(0, 300));
    }
    return { messageId: `cmb:${Date.now()}` };
  }
}
