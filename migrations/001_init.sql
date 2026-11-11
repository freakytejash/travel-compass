-- Travel Compass initial schema. PostgreSQL 14+ (gen_random_uuid is built in from PG13).

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  email_verified_at  timestamptz,
  password_hash      text,
  google_sub         text UNIQUE,
  role               text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  display_name       text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- sha256(session token); the raw token only lives in the cookie
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  user_agent    text
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_states (
  state_hash   text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('google_login','gmail_connect')),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  expires_at   timestamptz NOT NULL
);

CREATE TABLE profiles (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_place            jsonb,               -- {name, lat, lng, countryCode, timeZone}
  departure_airports    jsonb NOT NULL DEFAULT '[]',  -- [{iata, name, cityName}]
  time_zone             text NOT NULL DEFAULT 'UTC',
  currency              text NOT NULL DEFAULT 'EUR',
  contact_email_opt_in  boolean NOT NULL DEFAULT false,
  diet                  text NOT NULL DEFAULT 'none' CHECK (diet IN ('none','vegetarian','vegan','pescatarian')),
  allergies             jsonb NOT NULL DEFAULT '[]',
  dietary_notes         text NOT NULL DEFAULT '',
  budget_total          numeric(12,2),
  pace                  text NOT NULL DEFAULT 'moderate' CHECK (pace IN ('relaxed','moderate','packed')),
  interests             jsonb NOT NULL DEFAULT '[]',
  hiking_experience     text NOT NULL DEFAULT 'none' CHECK (hiking_experience IN ('none','beginner','intermediate','experienced')),
  hiking_difficulty     text NOT NULL DEFAULT 'easy' CHECK (hiking_difficulty IN ('easy','moderate','hard')),
  accommodation_pref    text NOT NULL DEFAULT 'private' CHECK (accommodation_pref IN ('any','private','dorm')),
  checked_bag           boolean NOT NULL DEFAULT false,
  wake_time             text NOT NULL DEFAULT '07:00',
  prep_minutes          int NOT NULL DEFAULT 45 CHECK (prep_minutes BETWEEN 0 AND 240),
  value_of_time_per_hour numeric(8,2) NOT NULL DEFAULT 15,
  onboarding_complete   boolean NOT NULL DEFAULT false,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','planned','booked','completed','cancelled')),
  origin           jsonb,                      -- place incl. iata
  adults           int NOT NULL DEFAULT 1 CHECK (adults BETWEEN 1 AND 9),
  start_date       date,
  end_date         date,
  flex_days        int NOT NULL DEFAULT 0 CHECK (flex_days BETWEEN 0 AND 3),
  budget_total     numeric(12,2),
  currency         text NOT NULL DEFAULT 'EUR',
  plan_status      text NOT NULL DEFAULT 'none' CHECK (plan_status IN ('none','generating','complete','incomplete','failed')),
  plan_message     text,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX trips_user ON trips(user_id, updated_at DESC);

CREATE TABLE trip_stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  position     int NOT NULL,
  place        jsonb NOT NULL,                 -- {name, lat, lng, countryCode, timeZone, iata?}
  arrive_date  date,
  depart_date  date,
  UNIQUE (trip_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  url           text NOT NULL,
  title         text NOT NULL DEFAULT '',
  provider      text NOT NULL,
  retrieved_at  timestamptz NOT NULL,
  excerpt       text NOT NULL DEFAULT '',
  UNIQUE (trip_id, url, retrieved_at)
);

CREATE TABLE itinerary_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_date      date NOT NULL,
  stop_id       uuid REFERENCES trip_stops(id) ON DELETE SET NULL,
  time_zone     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('complete','incomplete','failed')),
  missing       jsonb NOT NULL DEFAULT '[]',
  notes         jsonb NOT NULL DEFAULT '[]',
  weather       jsonb,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (trip_id, day_date)
);

CREATE TABLE itinerary_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id           uuid NOT NULL REFERENCES itinerary_days(id) ON DELETE CASCADE,
  position         int NOT NULL,
  kind             text NOT NULL,
  start_local      text NOT NULL,             -- 'YYYY-MM-DDTHH:mm' in the day's time zone
  end_local        text NOT NULL,
  title            text NOT NULL,
  venue            jsonb,
  why              text NOT NULL DEFAULT '',
  booking_required text NOT NULL DEFAULT 'unknown' CHECK (booking_required IN ('yes','no','recommended','unknown')),
  uncertainty      text NOT NULL DEFAULT '',
  source_ids       jsonb NOT NULL DEFAULT '[]',
  retrieved_at     timestamptz,
  locked           boolean NOT NULL DEFAULT false,
  meta             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX itinerary_items_day ON itinerary_items(day_id, position);

CREATE TABLE offers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('flight','stay')),
  stop_id            uuid REFERENCES trip_stops(id) ON DELETE CASCADE,
  search_id          uuid NOT NULL,
  provider           text NOT NULL,
  provider_offer_id  text NOT NULL,
  data               jsonb NOT NULL,
  total_amount       numeric(12,2) NOT NULL,
  currency           text NOT NULL,
  quoted_at          timestamptz NOT NULL,
  expires_at         timestamptz,
  role               text CHECK (role IN ('recommended','cheapest','convenient','comfortable')),
  explanation        text NOT NULL DEFAULT '',
  selected           boolean NOT NULL DEFAULT false
);
CREATE INDEX offers_trip ON offers(trip_id, kind, search_id);

CREATE TABLE searches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('flight','stay','flex','destinations')),
  status       text NOT NULL CHECK (status IN ('running','complete','partial','failed')),
  params       jsonb NOT NULL DEFAULT '{}',
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX searches_trip ON searches(trip_id, kind, created_at DESC);

CREATE TABLE reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id               uuid REFERENCES trips(id) ON DELETE SET NULL,
  kind                  text NOT NULL CHECK (kind IN ('flight','stay','activity','transport','other')),
  provider_name         text NOT NULL DEFAULT '',
  confirmation_code     text,
  details               jsonb NOT NULL DEFAULT '{}',
  start_at              timestamptz,
  end_at                timestamptz,
  source                text NOT NULL CHECK (source IN ('gmail','manual','booking_flow')),
  source_ref            text,
  dedupe_key            text NOT NULL,
  extraction_confidence numeric(4,3),
  review_status         text NOT NULL DEFAULT 'needs_review' CHECK (review_status IN ('needs_review','confirmed')),
  checkin_status        text NOT NULL DEFAULT 'unknown' CHECK (checkin_status IN ('unknown','not_open','pending','customer_confirmed','provider_confirmed','not_applicable')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE oauth_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('gmail')),
  account_email     text,
  scopes            text NOT NULL,
  access_token_enc  text NOT NULL,
  refresh_token_enc text,
  expires_at        timestamptz,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_sync_at      timestamptz,
  UNIQUE (user_id, provider)
);

CREATE TABLE notification_channels (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  kind                   text NOT NULL DEFAULT 'whatsapp' CHECK (kind IN ('whatsapp')),
  phone_e164             text NOT NULL,
  verification_code_hash text,
  code_expires_at        timestamptz,
  verify_attempts        int NOT NULL DEFAULT 0,
  verified_at            timestamptz,
  opted_in_at            timestamptz,
  opted_out_at           timestamptz,
  share_booking_refs     boolean NOT NULL DEFAULT false,
  pretrip_briefing       boolean NOT NULL DEFAULT true,
  daily_schedule         boolean NOT NULL DEFAULT true,
  daily_time             text NOT NULL DEFAULT '07:30',
  pretrip_time           text NOT NULL DEFAULT '18:00',
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id              uuid REFERENCES trips(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('pretrip_briefing','daily_schedule','phone_verification')),
  scheduled_for        timestamptz NOT NULL,
  dedupe_key           text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','sending','sent','delivered','read','failed','cancelled')),
  attempts             int NOT NULL DEFAULT 0,
  last_error           text,
  provider_message_id  text UNIQUE,
  job_id               bigint,
  body_preview         text NOT NULL DEFAULT '',
  status_updated_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, scheduled_for);

CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  queue         text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  run_at        timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead','cancelled')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 5,
  dedupe_key    text UNIQUE,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_ready ON jobs(run_at) WHERE status = 'queued';

CREATE TABLE booking_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id            uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  offer_id           uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  state              text NOT NULL CHECK (state IN ('selected','repriced','price_changed','details_collected','ready_for_handoff','handed_off','completed','expired','failed','cancelled')),
  original_amount    numeric(12,2) NOT NULL,
  repriced_amount    numeric(12,2),
  repriced_at        timestamptz,
  currency           text NOT NULL,
  conditions         jsonb NOT NULL DEFAULT '{}',
  traveller_details_enc text,
  handoff            jsonb,
  customer_ack_at    timestamptz,
  provider_order_ref text,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  provider     text NOT NULL,
  external_id  text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_id)
);

CREATE TABLE provider_usage (
  id                bigserial PRIMARY KEY,
  provider          text NOT NULL,
  operation         text NOT NULL,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  status            text NOT NULL,
  http_status       int,
  latency_ms        int,
  tokens_in         int,
  tokens_out        int,
  cost_estimate_usd numeric(10,5) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_usage_time ON provider_usage(created_at DESC);
CREATE INDEX provider_usage_user ON provider_usage(user_id, created_at DESC);

CREATE TABLE error_events (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,
  message     text NOT NULL,
  context     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE provider_cache (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);
