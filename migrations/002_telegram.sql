-- Telegram as a free reminder channel (alternative to WhatsApp).
ALTER TABLE notification_channels DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_kind_check CHECK (kind IN ('whatsapp','telegram'));
ALTER TABLE notification_channels ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE notification_channels ADD COLUMN telegram_chat_id text;
ALTER TABLE notification_channels ADD COLUMN link_token_hash text;
ALTER TABLE notification_channels ADD COLUMN link_expires_at timestamptz;
CREATE UNIQUE INDEX notification_channels_link_token ON notification_channels(link_token_hash) WHERE link_token_hash IS NOT NULL;
CREATE TABLE kv_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
