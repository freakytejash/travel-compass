# Feature status

Status as of 2026-11-04. Categories:

- **Tested locally** — implemented and covered by automated tests against PostgreSQL with mocked providers.
- **Verified live** — configured and confirmed against the real provider. *Nothing is in this category yet*: the build environment had no network access to any provider.
- **Awaiting credentials** — implemented adapter; needs keys and a live check.
- **Not implemented**
- **Blocked** — needs a provider capability or business approval the code cannot supply.

The admin page (`/admin`) shows the same information at runtime and marks an integration "verified live" only after this deployment records a successful call.

## Accounts and data

| Feature | Status |
|---|---|
| Registration, verified email, login, logout, password recovery, session revocation on reset | Tested locally |
| Google sign-in (OIDC + PKCE) | Awaiting credentials (`GOOGLE_CLIENT_ID/SECRET`); token exchange not tested end-to-end |
| Transactional email (Brevo free 300/day, or Resend) | Brevo request format tested with a simulated API; awaiting `BREVO_API_KEY` for a live send |
| Public dashboard (no sign-in): city search, holiday windows, nearby airports | Tested locally (API + headless browser) |
| Admin self-test of all live services from the deployed server; failures name the service and the setting to fix | Tested locally with simulated services; run it on Render to verify live |
| Suggest destinations (trip form) | Uses Google Travel Explore (1 search, all nearby airports, no AI) when SerpApi is set; AI + live checks only as fallback |
| Profile: home city, airports, time zone, currency, diet, allergies, budget, pace, interests, hiking, room preference, wake/prep times | Tested locally |
| Server-enforced per-customer data separation | Tested locally (two-user test across trips, searches, offers, reservations, admin) |
| Account export (JSON) and deletion (with Gmail revocation and job cancellation) | Tested locally |
| CSRF tokens, origin checks, rate limits, AI daily budgets | Tested locally (CSRF/origin); rate-limit and budget code paths implemented, not load-tested |

## Planning

| Feature | Status |
|---|---|
| Searchable worldwide city/airport dropdowns, "use my location" nearby airports | Awaiting credentials (Duffel places); UI tested with mocks |
| Destination ideas (AI) verified against live flights, stays and weather; unverifiable suggestions dropped | Tested locally / awaiting credentials |
| Forecast vs historical climate, labelled separately | Tested locally (labels); Open-Meteo awaiting live check |
| Flight offers with flight numbers, local times, duration, layovers, bags, conditions, price, quote time, expiry | Tested locally / awaiting `DUFFEL_ACCESS_TOKEN` |
| Recommended / lowest-price / more-convenient ranking incl. bags, transfers, timing | Tested locally |
| Flexible dates ±1–3 with independent outbound/return shifts, complete-cost comparison, coverage report | Tested locally |
| Multi-stop accommodation covering every night; gap/overlap detection; dorm vs private | Tested locally |
| Duffel Stays | Blocked until Duffel approves Stays access, then awaiting credentials |
| Booking.com Demand API | Blocked (affiliate partnership); field mapping must be validated in sandbox |
| Airbnb live inventory | Blocked — no authorised API; shown only as a labelled external search link |
| Named venues with address, hours, price provenance, map/website links, sources, retrieval time | Tested locally / awaiting `GOOGLE_MAPS_API_KEY` |
| Vegetarian dish verification (no name-only claims; stock/sauce risks flagged) | Tested locally |
| Hikes with facts only from cited sources; weather/daylight swaps to indoor alternatives | Tested locally / awaiting `BRAVE_SEARCH_API_KEY` |
| AI selection & explanations with prompt-injection hygiene; deterministic fallback without AI | Tested locally / awaiting `ANTHROPIC_API_KEY` |
| Day-by-day itinerary incl. arrival/departure days, real flight times, time zones/DST, buffers | Tested locally |
| Replace venue, move activity, change pace, regenerate one day | Tested locally (move, pace, single-day regenerate); replace uses the same path |
| Autosave with conflict detection | Tested locally |
| Live traffic transfer times (Google Routes) | Awaiting credentials; falls back to labelled planning assumptions |
| Inter-city transport (trains/buses between stops) | No prices; prefilled Rome2Rio links in "Book everything" |
| Trip ideas: holiday/long-weekend windows (Nager.Date) × cheapest destinations (SerpApi Google Travel Explore) × weather | Tested locally with simulated Nager/SerpApi responses; awaiting live check |
| All airports within 150 km searched in ONE Google Flights search; transfer cost to each airport included in ranking | Tested locally with simulated SerpApi |
| Choose an idea → trip created → flights, stays and itinerary searches start automatically | Tested locally |
| "Book everything" checklist: flights, stays, hostels/Airbnb links, car rental links, transport, tickets, extras; booked items tracked | Tested locally. Car rental and Airbnb/hostel-site prices are **not** loaded (no free price API) — links only |

## Bookings, Gmail, reminders

| Feature | Status |
|---|---|
| Select → reprice → traveller details (encrypted) → explicit acknowledgement → handoff | Tested locally |
| Expired fare / price increase handling | Tested locally |
| Duffel Links hosted checkout handoff and provider-verified completion | Awaiting credentials + Duffel Links/Payments enablement. Limitation: the hosted page does not pre-select our offer; the customer re-selects the shown flight numbers |
| Booking for exactly the selected Duffel offer with in-app card component | **Not implemented** |
| Reservation organiser, manual entries, review/correct, customer-confirmed check-in | Tested locally |
| Gmail OAuth (read-only), extraction, dedupe, trip association, disconnect + revoke | Tested locally with simulated Google APIs; blocked for public launch until Google restricted-scope verification + CASA |
| WhatsApp verification, opt-in, scheduled pre-trip and daily messages, retries, duplicate protection, signed delivery webhooks, STOP opt-out | Tested locally with mocked Meta API; awaiting credentials, Meta business verification and approved templates |
| Admin: readiness, usage/cost, notification failures, errors, health | Tested locally (readiness, health) |

## Free provider stack (added 2026-11-04)

All of these are implemented and tested locally against simulated network responses in the documented formats (`test/unit/free-adapters.test.ts`, `test/integration/free-stack.test.ts`). **None has been verified live from this build environment**, which has no internet access to these services. Run `npm run check:integrations` after setup.

| Feature | Status |
|---|---|
| Google Flights results via SerpApi: round trip and open-jaw, multiple origin airports, local→UTC times, layovers, ranking, repricing by re-search | Tested locally / awaiting `SERPAPI_API_KEY` |
| Seller handoff via Google booking options (POST to google.com only; other URLs dropped), fallback to the Google Flights results page | Tested locally. The `booking_options` field names come from SerpApi's examples and must be confirmed with a live search |
| Google Hotels via SerpApi: totals, taxes where shown, rating, free-cancellation hint, nightly-rate estimates labelled | Tested locally / awaiting key |
| Free monthly allowance guard (stops before calling SerpApi) | Tested locally |
| City and airport search: Photon + OurAirports + Open-Meteo time zones | Tested locally (dataset downloads on first use) |
| OpenStreetMap venues, `diet:vegetarian/vegan` tags, opening-hours conversion (unknown when unparseable), hiking routes as citable facts | Tested locally |
| Wikivoyage/Wikipedia research (Eat/See/Do sections first) | Tested locally |
| OpenAI-compatible AI (Groq, Ollama, OpenRouter…), JSON-mode fallback | Tested locally / awaiting `AI_BASE_URL` (+ key for Groq) |
| Telegram reminders: deep-link connect, explicit opt-in, scheduled delivery, `/stop`, polling or signed webhook | Tested locally / awaiting `TELEGRAM_BOT_TOKEN` |
| Log-only email for personal self-hosting | Tested locally |
| Bookable checkout for exactly the chosen fare on the free stack | **Blocked** — no free booking API; the customer books with the seller Google lists |
| Gemini free tier | **Blocked** for users in the EEA by Google's terms (use Groq or Ollama instead) |

## Free WhatsApp and free hosting (added 2026-11-09)

| Feature | Status |
|---|---|
| WhatsApp reminders via CallMeBot (free, personal, own number only): encrypted key, code verification, scheduled briefing marked "sent" (no receipts) | Tested locally with simulated CallMeBot responses (`test/integration/callmebot.test.ts`); not verified live |
| Meta Cloud API test number (free, up to 5 verified numbers) | Supported by the existing WhatsApp adapter; its default 24-hour access token is impractical for scheduled reminders |
| Render Blueprint (`render.yaml`) + Neon free Postgres, Telegram webhook auto-registration, idle worker that sleeps until the next job is due | Implemented and the worker timing tested locally; **not deployed** — needs the owner's GitHub, Render and Neon accounts |
