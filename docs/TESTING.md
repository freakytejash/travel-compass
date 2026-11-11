# Testing

Run: `npm test` (needs PostgreSQL at `TEST_DATABASE_URL`; the integration suite drops and recreates the `public` schema of that database).

**All automated tests use mocked providers** (`test/helpers/mocks.ts`) or simulated provider HTTP responses. They prove the application logic, persistence, security rules and failure handling — not that any live provider works. Live verification is done per deployment with `npm run check:integrations` and the manual journey in ADMIN_CHECKLIST.md §11.

Last run (2026-11-11, Node 22.23, PostgreSQL 16): **94 tests, 94 passed, 0 failed**, plus a browser walkthrough in headless Chrome at phone size (dashboard signed out → sign in → trip ideas → choose → Book everything → new trip date logic → Suggest destinations → Admin self-test) against the simulated network, with no page errors. New tests: `test/unit/ideas.test.ts`, `test/integration/ideas-book.test.ts` (incl. Brevo sign-up email, the Charleroi journey, named failure messages, admin self-test).

**Live check after each deploy:** sign in as admin → **Admin → Run self-test**. It calls every configured service from the server and shows which work and which setting to fix.

| Suite | Covers |
|---|---|
| `test/unit/domain.test.ts` | DST/time zones, flight ranking, ±3-day independent shifts, complete-cost ranking, night coverage (multi-stop, overnight transport, early arrival), stay ranking, scheduler (arrival/departure buffers, very early departures, closures, weather swaps, daylight, missing meals), vegetarian rules, reminder timing, email extraction/dedupe, placeholder guard |
| `test/unit/adapters.test.ts` | Duffel/Google/Gmail/WhatsApp response normalisation against documented shapes, Duffel headers, retry/backoff and bounded concurrency, webhook signatures, SSRF guard, readiness never over-reports |
| `test/integration/accounts.test.ts` | Register → verify → login/logout → recovery; CSRF/origin; two-user isolation; persistence across sessions; autosave conflicts; stop chaining; export and deletion |
| `test/integration/planning.test.ts` | Live-shaped flight search & ranking, multi-stop stays, flex dates, sourced vegetarian plan (no placeholders, injection ignored, rain swap, arrival/departure times), move/pace/regenerate-day, provider outage without data loss, reprice/expiry/price-change/handoff without purchase, destination verification |
| `test/unit/free-adapters.test.ts` | OSM opening-hours conversion and tag mapping, Overpass caching/ranking, OurAirports parsing + Photon search, Google Hotels normalisation (no key leaks), Wikivoyage section selection, OpenAI-compatible JSON-mode fallback, Telegram rendering/parsing/secret |
| `test/integration/free-stack.test.ts` | Whole free stack through the real server: Google Flights search (UTC times, ranking, price-level offers), reprice + seller handoff (Google-only URLs), Google Hotels night coverage, OSM + Wikivoyage + Groq plan (vegetarian venue, OSM-cited hike, injection ignored), Telegram connect/opt-in/briefing/`/stop`, SerpApi allowance guard |
| `test/integration/callmebot.test.ts` | Free WhatsApp via CallMeBot: rejected key, code verification, encrypted key, scheduled briefing sent and shown as "sent", opt-out cancels |
| `test/integration/worker-idle.test.ts` | Idle worker sleeps until the next due job (for scale-to-zero databases) |
| `test/integration/notifications-gmail.test.ts` | WhatsApp verification, persistent time-zone-aware scheduling, idempotent rescheduling, retry, at-most-once send, signed/duplicate/out-of-order callbacks, STOP opt-out; Gmail OAuth (read-only, PKCE), encrypted tokens, extraction, dedupe, trip association, account-mismatch protection, disconnect + revoke; admin readiness |

A UI walkthrough (register → onboarding → trip → flights → booking dialog → stays → itinerary → admin) was also run in headless Chromium at desktop and 390 px mobile widths against mocked providers, with no console errors.

Not covered: real provider calls, Google sign-in token exchange end-to-end, load/rate-limit behaviour, screen-reader audit, cross-browser testing beyond Chromium.
