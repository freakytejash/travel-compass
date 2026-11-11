# Administrator activation checklist

Put every secret in the hosting platform's secret manager (never in git, chat, or browser code). After each step, open `/admin` and run `npm run check:integrations` in the deployed environment.

## 1. Core (required)
- [ ] PostgreSQL 14+ with TLS (`DATABASE_URL=...?sslmode=verify-full`), automated backups enabled (see OPERATIONS.md).
- [ ] `TOKEN_ENCRYPTION_KEY` — 32 random bytes, base64. Store a copy in a separate vault: losing it makes stored OAuth tokens and in-flight traveller details unreadable.
- [ ] `APP_URL` = your https origin; `NODE_ENV=production`; `TRUST_PROXY=true` behind a load balancer.
- [ ] Deploy web + worker (`RUN_WORKER_IN_PROCESS=false` on web, run `npm run start:worker`), or a single process with the in-process worker.
- [ ] Sign up with an address in `ADMIN_EMAILS` (or run `npm run db:create-admin -- you@domain`).

## 2. Email — Resend
Enables verification and password recovery (required for sign-up in production).
- [ ] Verify your sending domain (SPF, DKIM). Set `RESEND_API_KEY`, `EMAIL_FROM`.
- [ ] Register a test account and confirm the verification email arrives.

## 3. Google OAuth (sign-in + Gmail import)
- [ ] Google Cloud project → OAuth consent screen (external), add privacy policy and terms URLs.
- [ ] OAuth client (web). Redirect URI: `${APP_URL}/api/oauth/google/callback`. Set `GOOGLE_CLIENT_ID/SECRET`.
- [ ] Enable the Gmail API. `gmail.readonly` is a **restricted scope**: production use for the public requires Google verification and an annual **CASA security assessment**. Until approved, Gmail import works only for test users you add to the consent screen.

## 4. Duffel (flights, places, checkout, optional stays)
- [ ] Create a Duffel account; start with a `duffel_test_` token and run test searches.
- [ ] Go-live: complete Duffel verification for live mode; set the `duffel_live_` token.
- [ ] Hosted checkout: enable **Duffel Links** (requires Duffel Payments in a supported country) → `DUFFEL_LINKS_ENABLED=true`. Configure webhooks for `order.created` if you want server-side confirmation in addition to the redirect.
- [ ] Stays: request access from Duffel; when approved set `DUFFEL_STAYS_ENABLED=true`.

## 5. Booking.com Demand API (optional second accommodation source)
- [ ] Apply for the affiliate partnership; obtain token and affiliate ID.
- [ ] Validate field mapping (`src/server/integrations/booking.ts`) against the sandbox before enabling in production.

## 6. Google Maps Platform
- [ ] Enable **Places API (New)** and **Routes API**, set billing alerts, restrict the key to those APIs and your server IPs. Set `GOOGLE_MAPS_API_KEY`.
- [ ] Review Places attribution and caching rules; the app links every venue to its Google Maps page.

## 7. Open-Meteo
- [ ] Commercial use requires a subscription: set `OPEN_METEO_API_KEY` (the free tier is disabled in production by default).

## 8. Anthropic
- [ ] Set `ANTHROPIC_API_KEY`, choose `ANTHROPIC_MODEL`, and set `AI_DAILY_BUDGET_USD`, `AI_PER_USER_DAILY_BUDGET_USD` and the per-token prices used for cost estimates.

## 9. Brave Search API
- [ ] Choose a plan whose terms allow your use and retention of results; set `BRAVE_SEARCH_API_KEY`.

## 10. WhatsApp Cloud API
- [ ] Meta Business verification; add a phone number; create a **system-user** token with `whatsapp_business_messaging`.
- [ ] Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- [ ] Webhook: callback `${APP_URL}/api/webhooks/whatsapp`, verify token as above, subscribe to `messages`.
- [ ] Submit and get approved these templates (names configurable via env). Parameters are single-line text.

`tc_verification_code` (category: Authentication) — one parameter: the 6-digit code.

`tc_pretrip_briefing` (Utility):
```
Hi {{1}}, your trip ({{2}}) starts tomorrow.
Flight: {{3}}
Check-in: {{4}}
Wake up {{5}}, leave home {{6}}. Transfer: {{7}}
Stay: {{8}}
Weather: {{9}}
Day 1: {{10}}
Food: {{11}}
Reply STOP to stop reminders.
```

`tc_daily_schedule` (Utility):
```
Good morning {{1}}! {{2}} in {{3}}: {{4}}
Weather: {{5}}. {{6}}
Reply STOP to stop reminders.
```

- [ ] In the app: verify your own number, opt in, and confirm the admin page shows `delivered` after a reminder is sent.

## 11. Before announcing to customers
- [ ] Every core integration shows "Configured · verified live" on `/admin`.
- [ ] Run the full journey manually on production: sign up → profile → trip → flights → stays → plan → booking handoff (stop at the provider's payment page) → reminders.
- [ ] Legal (owner's responsibility, not established by this code): privacy policy and GDPR records of processing (incl. Gmail and WhatsApp data), terms of service, cookie notice (only a strictly necessary session cookie is used), travel-agent/intermediary licensing and package-travel rules where you operate, provider terms (Duffel, Booking.com, Google, Meta, Brave, Open-Meteo, Anthropic), and data-processing agreements with each provider.
