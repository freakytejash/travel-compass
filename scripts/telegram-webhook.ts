// Optional: switch the Telegram bot from polling to a webhook (needs a public https APP_URL):
//   npm run telegram:webhook          -> registers ${APP_URL}/api/webhooks/telegram (then set TELEGRAM_MODE=webhook)
//   npm run telegram:webhook -- --off -> removes the webhook (back to TELEGRAM_MODE=polling)
import { loadConfig } from '../src/server/config.ts';
import { requestJson } from '../src/server/integrations/http.ts';

const cfg = loadConfig();
if (!cfg.telegram.token) { console.error('TELEGRAM_BOT_TOKEN is not set'); process.exit(1); }
const base = `https://api.telegram.org/bot${cfg.telegram.token}`;
if (process.argv.includes('--off')) {
  console.log(await requestJson(`${base}/deleteWebhook`, { provider: 'telegram', operation: 'deleteWebhook', method: 'POST', body: {} }));
} else {
  if (!cfg.appUrl.startsWith('https://')) { console.error('A webhook needs a public https APP_URL. Keep TELEGRAM_MODE=polling instead.'); process.exit(1); }
  if (!cfg.telegram.webhookSecret) { console.error('Set TELEGRAM_WEBHOOK_SECRET first (any random string).'); process.exit(1); }
  console.log(await requestJson(`${base}/setWebhook`, { provider: 'telegram', operation: 'setWebhook', method: 'POST', body: { url: `${cfg.appUrl}/api/webhooks/telegram`, secret_token: cfg.telegram.webhookSecret, allowed_updates: ['message'] } }));
}
