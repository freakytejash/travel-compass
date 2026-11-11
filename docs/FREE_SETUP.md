# Running Travel Compass for free

This setup costs **€0** for personal, non-commercial use. You need four free sign-ups (about 15 minutes): SerpApi, Groq, a Telegram bot, and nothing else. Everything else is key-less. Checked November 2026; free tiers change, so check them again before relying on them.

## What replaces what

| Capability | Paid default | Free replacement | What you give up |
|---|---|---|---|
| Flights | Duffel | **SerpApi → Google Flights**, 250 searches/month, no card | No in-app checkout, no fare rules or baggage data. You book on the airline or agency site Google lists. |
| Hotels | Duffel Stays / Booking.com | **SerpApi → Google Hotels** (same allowance) | Room type and cancellation terms are confirmed on the booking site |
| City and airport search | Duffel Places | **Photon** (OpenStreetMap geocoder) + **OurAirports** open data + Open-Meteo time zones | — |
| Venues (food, sights, hikes) | Google Places | **OpenStreetMap / Overpass**: names, addresses, opening hours, `diet:vegetarian` tags, hiking routes | No ratings or price levels; data quality depends on local mappers |
| Research (dishes, trails) | Brave Search | **Wikivoyage + Wikipedia** | Less coverage of very recent closures |
| AI planner | Anthropic | **Groq free tier** (OpenAI-compatible) or **Ollama** on your own machine | Smaller models; Groq rate limits |
| Weather | Open-Meteo (commercial key) | **Open-Meteo free tier** | Non-commercial use only |
| Reminders | WhatsApp Cloud API | **Telegram bot** | Not WhatsApp (see below) |
| Email | Resend | **Log-only mode**, or Resend's free plan (3,000/month) | Log-only: you read sign-up links from the server log |
| Hosting | Cloud | Your own computer with Docker; optionally an always-on free VM | Reminders only go out while it's running |

Why not some other "free" options:
- **Gemini** — its free API tier is not offered to users in the EEA, which includes Belgium.
- **WhatsApp** — from 1 October 2026 Meta charges for utility template messages, which is what scheduled reminders are.
- **Amadeus Self-Service** — shut down.
- **Brave Search** — now needs a card, even for the monthly credit.

## 1. Get the free keys

1. **SerpApi** — sign up at serpapi.com (no card). Copy your API key.
2. **Groq** — sign up at console.groq.com → API Keys → create a key. Groq says it does not retain inference data by default.
3. **Telegram bot** — in Telegram, open **@BotFather**, send `/newbot`, and pick a name and a username ending in `bot`. Copy the token and the username.
4. **Encryption key** — run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## 2. Run it

```bash
cp .env.free.example .env
# fill in: TOKEN_ENCRYPTION_KEY, SERPAPI_API_KEY, AI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, ADMIN_EMAILS
docker compose up -d --build
docker compose exec web npm run check:integrations      # every free service should say OK
```

Open http://localhost:3000 and sign up with the address you put in `ADMIN_EMAILS`. With `EMAIL_LOG_ONLY=true` no email is sent. Get the verification link from the log:

```bash
docker compose logs web | grep verify-email
```

Without Docker you need Node ≥ 22.18 and PostgreSQL 14+. Set `DATABASE_URL`, then run `npm install && npm run build:web && npm start`.

## 3. Turn on reminders

In the app, go to **Reminders → Connect Telegram**, press **Start** in Telegram, then **Turn on reminders**. You'll get the pre-trip briefing the evening before departure and a daily schedule each morning. Send `/stop` to the bot to stop.

Polling mode needs no public URL. If you later host it at a public `https://` address, run `npm run telegram:webhook` and set `TELEGRAM_MODE=webhook`.

## 4. Spending your 250 searches

Only flight and hotel actions use SerpApi. Generating and editing itineraries uses OpenStreetMap, Wikivoyage and Groq, so it never touches the allowance.

| Action | Searches used |
|---|---|
| Flight search | 3 (outbound list + return options for the two best outbound flights) |
| Check price before booking | 2 |
| Show sellers (booking handoff) | 1 |
| Hotel search | 1 per destination |
| Flexible dates | up to 9 (`FLEX_MAX_COMBOS`), plus 1 hotel search for each of 2 date options |
| Destination ideas | up to 4 flight + 4 hotel (`DESTINATION_CANDIDATES`) |
| `npm run check:integrations -- --serpapi` | 1 |

A typical trip (destination ideas, flights, flexible dates, hotels, booking) uses about 30 searches, so the free plan covers roughly 8 fully researched trips a month. The app stops at `SERPAPI_MONTHLY_LIMIT` (default 240) and says so; it never fails silently. The admin page shows how many you've used.

## Optional extras (still free)

- **Fully private AI with no rate limits:** `docker compose --profile local-ai up -d`, then `docker compose exec ollama ollama pull qwen2.5:7b`. Set `AI_BASE_URL=http://ollama:11434/v1`, `AI_MODEL=qwen2.5:7b` and leave `AI_API_KEY` empty. It needs about 8 GB RAM and is slower than Groq.
- **Gmail import for your own inbox:**
  1. In Google Cloud, create an OAuth client (Web) with redirect URI `http://localhost:3000/api/oauth/google/callback`.
  2. Leave the consent screen in **Testing**, add yourself as a test user, and enable the Gmail API.
  3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. This also turns on "Continue with Google".
  - Google expires refresh tokens for testing-mode apps after 7 days, so reconnect weekly. Publishing the app would require Google's paid security review.
- **Real emails:** use Brevo's free plan (300/day). Verify your own address as a sender, set `BREVO_API_KEY` and `EMAIL_FROM`, and set `EMAIL_LOG_ONLY=false` (steps in DEPLOY_FREE.md). Resend also works, but only with a domain you own verified in Resend.
- **Use it from your phone:** free Tailscale or Cloudflare Tunnel. Set `APP_URL` to the tunnel's https address and add it to the Google OAuth redirect URIs.
- **Always on:** an old laptop or Raspberry Pi. Oracle Cloud's Always Free tier also works; since June 2026 the Arm VM allowance is 2 OCPU / 12 GB, it needs a card for identity checks, and capacity is often unavailable.

## Limits to keep in mind

- These free plans are for **personal, non-commercial use**. Before offering the app to other people, switch to the paid providers (they still work: set their keys and the app uses them automatically).
- Google Flights prices are what Google showed at search time. The seller confirms the final price, baggage and fare rules.
- OpenStreetMap opening hours and vegetarian tags are community-maintained. The app labels them as such, marks hours it can't parse as unknown, and asks you to confirm dishes with staff.
- Groq's free tier has per-minute and per-day request limits. If you hit them, plan generation reports an error and keeps your saved plan.
