-- WhatsApp via CallMeBot: free, personal-use gateway that only sends to the customer's own number.
ALTER TABLE notification_channels DROP CONSTRAINT notification_channels_kind_check;
ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_kind_check CHECK (kind IN ('whatsapp','telegram','callmebot'));
ALTER TABLE notification_channels ADD COLUMN callmebot_key_enc text;
