# Travel Compass

Consumer travel planning: choose an affordable destination, compare **live** flight and accommodation offers (including ±1–3 day flexible dates by complete trip cost), get a day-by-day itinerary of **named, sourced** venues (vegetarian by default for profiles that set it), organise reservations (with optional Gmail import) and receive WhatsApp briefings.

> **Deploy it for free with a public URL:** [docs/DEPLOY_FREE.md](docs/DEPLOY_FREE.md) (Render + Neon, WhatsApp via CallMeBot).

> **Run it for free on your own computer:** see [docs/FREE_SETUP.md](docs/FREE_SETUP.md) — Google Flights/Hotels via SerpApi's free plan, OpenStreetMap, Wikivoyage, Groq or local Ollama, Telegram reminders, Open-Meteo.

> **Status:** implemented and tested locally against PostgreSQL with mocked providers. **No provider integration has been verified live yet** — see [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md). Do not treat it as customer-ready until the [administrator checklist](docs/ADMIN_CHECKLIST.md) is complete.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript end-to-end (strict, `erasableSyntaxOnly`) |
| Server | Node.js ≥ 22.18 `http` server, run directly via Node's TypeScript type stripping |
| Database | PostgreSQL 14+ (built-in wire-protocol client with SCRAM/TLS, `src/server/db/pg.ts`); SQL migrations in `migrations/` |
| Jobs | Durable PostgreSQL queue (`FOR UPDATE SKIP LOCKED`), retries with backoff, dedupe keys, hourly housekeeping |
| Auth | Email + password (scrypt) with verified email and recovery; Google sign-in (OIDC, PKCE); server-side sessions; CSRF tokens + origin checks |
| Frontend | Typed vanilla TS SPA bundled by esbuild (`public/app.js`), responsive, accessible combobox, light/dark |
| Integrations (paid) | Duffel (flights, places, stays, Links checkout), Booking.com Demand API, Google Places (New) & Routes, Anthropic, Brave Search, WhatsApp Cloud API, Resend |
| Integrations (free) | SerpApi Google Flights & Hotels, Photon + OurAirports, OpenStreetMap Overpass, Wikivoyage/Wikipedia, OpenAI-compatible AI (Groq, Ollama), Telegram Bot API, WhatsApp via CallMeBot (personal), Open-Meteo, Gmail API |
| Provider choice | Automatic: a paid provider is used when its key is set, otherwise the free one |

Runtime dependencies: **none**. Dev dependencies: `typescript`, `esbuild`, `@types/node`.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dev dependencies (TypeScript, esbuild, Node types) |
| `npm run typecheck` | Type-check server, web app, tests and scripts |
| `npm run build:web` | Bundle the browser app into `public/app.js` (`NODE_ENV=production` minifies) |
| `npm run build` | Typecheck + bundle |
| `npm run db:migrate` | Apply pending SQL migrations (`DATABASE_URL` required) |
| `npm start` | Start the web server (runs migrations unless `MIGRATE_ON_START=false`; runs the worker in-process unless `RUN_WORKER_IN_PROCESS=false`) |
| `npm run start:worker` | Run the background worker/scheduler as a separate process |
| `npm run dev` | Bundle the web app and start the server with `--watch` |
| `npm test` | Run all tests (unit + integration; needs `TEST_DATABASE_URL`) |
| `npm run test:unit` | Unit and adapter-contract tests only (no database) |
| `npm run test:integration` | Integration tests (real PostgreSQL + HTTP, **mocked** providers) |
| `npm run db:create-admin -- you@example.com` | Promote a verified account to administrator |
| `npm run check:integrations` | Read-only live smoke test of configured providers (run in the deployed environment) |
| `npm run check:integrations -- --serpapi` | Same, plus one real Google Flights search (uses 1 of the 250 free SerpApi searches) |
| `npm run airports:download` | Download the OurAirports dataset into `DATA_DIR` (also happens automatically on first use; add `-- --refresh` to update) |
| `npm run telegram:webhook` | Register the Telegram webhook at `${APP_URL}/api/webhooks/telegram` (needs public https; `-- --off` to go back to polling) |
| `docker compose up --build` | Run PostgreSQL + web + worker locally from `docker-compose.yml` |
| `docker compose --profile local-ai up -d` | Also start a local Ollama server (free, private AI) |
| `docker compose exec ollama ollama pull qwen2.5:7b` | Download a local model for Ollama |
| `docker compose logs web \| grep verify-email` | Read your sign-up link when `EMAIL_LOG_ONLY=true` |
| `node --test test/unit/ideas.test.ts` | Unit tests for holiday windows, trip-idea ranking, booking links and Brevo email |
| `node --test test/integration/ideas-book.test.ts` | Dashboard → trip ideas → choose → multi-airport flights → Book everything (needs test DB) |
| `curl "https://<your-url>/api/public/windows?country=BE&months=6"` | Check the public holiday/long-weekend data on a deployment |
| `git am 0001-*.patch && git push` | Apply a patch file from Claude to your repo; Render redeploys on push |
| `rsync -a --exclude .git --exclude .env --exclude node_modules ~/Downloads/travel-compass/ ./` | Copy an updated project folder from a zip over your repo, keeping your git history and `.env` |
| `node test/e2e/serve-sim.ts` | Run the full app locally on a simulated network at http://127.0.0.1:4173 (admin@example.com / correct horse battery) — click through without keys or quota |
| Admin → **Run self-test** (in the app) | Check every live service from the deployed server; tick boxes to also send yourself a test email or run 1 flight search |
| `cp .env.free.example .env` | Start from the zero-cost configuration |
| `git remote add origin https://github.com/<you>/travel-compass.git && git push -u origin main` | Put the code on GitHub for Render to deploy (Render → New → Blueprint reads `render.yaml`) |
| `curl https://<your-url>/api/ready` | Check a deployed instance and its database are up |
| `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | Generate `TOKEN_ENCRYPTION_KEY` |

## Local setup

```bash
cp .env.example .env                 # fill in at least DATABASE_URL and TOKEN_ENCRYPTION_KEY
docker compose up -d db              # or use any PostgreSQL 14+
createdb -h 127.0.0.1 -p 5433 -U tc travel_compass_test   # for tests
npm install
npm run build:web
set -a && . ./.env && set +a
npm run db:migrate
npm start                            # http://localhost:3000
npm test
```

Without provider credentials the app still runs: accounts, profiles, trips, autosave, reservations and the admin page work; live searches, plan generation and reminders respond with a clear "not available yet" message and **never** substitute placeholder data. In development, verification emails are printed to the log when no email key is set (never in production unless `EMAIL_LOG_ONLY=true`). For real emails set `BREVO_API_KEY` (free 300/day) — see docs/DEPLOY_FREE.md.

## How it works

- **Searches** (`flight`, `stay`, `flex`, `destinations`) run as background jobs; results and every returned offer (with provider, quote time and expiry) are persisted. Ranking is deterministic (`src/server/domain/`).
- **Plans**: Google Places supplies venues with addresses, hours, price levels and map links; web research supplies hike facts and menu evidence; the AI selects and explains **only from those candidates** (untrusted content is fenced and sanitised); the scheduler assigns times around real flight times, opening hours, meal windows, daylight, weather, pace and airport buffers. Unverifiable items are reported as missing; a failed refresh never overwrites a saved day.
- **Booking**: select → reprice with the provider → traveller details (encrypted, purged after handoff) → explicit acknowledgement of the exact price and conditions → provider-hosted checkout (Duffel Links) or redirect (Booking.com). Travel Compass never takes payment or creates a booking itself; a booking is recorded only when the provider API confirms the order.
- **Reminders**: verified WhatsApp opt-in, persistent jobs per notification, at-most-once sending, delivery receipts via signed webhook, STOP opt-out.

## Documentation

- [docs/DEPLOY_FREE.md](docs/DEPLOY_FREE.md) — free public deployment (Render + Neon) and the WhatsApp options
- [docs/FREE_SETUP.md](docs/FREE_SETUP.md) — zero-cost setup and what each free provider gives up
- [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) — precise status of every feature
- [docs/ADMIN_CHECKLIST.md](docs/ADMIN_CHECKLIST.md) — credentials, approvals and go-live steps (incl. WhatsApp templates)
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — deployment, security, backups, retention, monitoring, support
- [docs/TESTING.md](docs/TESTING.md) — test coverage and results

## Layout

```
migrations/            SQL schema
src/shared/            types shared by server and browser
src/server/domain/     pure logic: ranking, flex dates, night coverage, scheduler, diet, reminders, email extraction
src/server/integrations/  provider adapters behind interfaces (types.ts)
src/server/services/   auth, trips, searches, planning, booking, reservations, notifications, admin
src/server/jobs/       queue, worker, scheduler
src/server/http/       router, validation, CSRF, rate limits
src/web/               browser app
test/                  unit, adapter-contract and integration tests (mocks in test/helpers)
```
