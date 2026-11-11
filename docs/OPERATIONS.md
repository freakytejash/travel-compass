# Operations

## Deployment
- Any container host (Cloud Run, Azure Container Apps, Fly, ECS, Kubernetes). Build with the `Dockerfile`; run two services from one image: web (`node src/server/main.ts`) and worker (`node src/server/jobs/worker-main.ts`). Migrations run on web start under an advisory lock (`MIGRATE_ON_START`), or explicitly with `npm run db:migrate` in the release step.
- Health: `GET /api/health` (liveness), `GET /api/ready` (database). Admin: `GET /api/admin/health` (job backlog, dead jobs).
- Graceful shutdown on SIGTERM: stops taking jobs, waits up to 15 s for running ones. Jobs abandoned by a crashed worker are re-queued after 10 minutes; interrupted WhatsApp sends are marked failed (never re-sent blindly).

## Security controls
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax`, `Secure` (prod) cookie; only its SHA-256 is stored. Rotated at login; all sessions revoked on password reset.
- CSRF: per-session token header on every state-changing request + Origin check. Webhooks are exempt but HMAC-verified.
- Authorisation: every query is scoped by `user_id` on the server; other users' objects return 404.
- Passwords: scrypt (N=2^15). OAuth tokens, PKCE verifiers, phone codes in job payloads and traveller details: AES-256-GCM with `TOKEN_ENCRYPTION_KEY`.
- No payment card data is ever collected. Traveller details are purged after handoff/cancellation or after 2 days.
- External content (web pages, menus, emails) is fetched only over https to public IPs (SSRF guard), size-limited, stripped of markup, fenced as untrusted for the AI, and rendered with `textContent` only. AI output may reference only provided candidate IDs and fetched URLs.
- CSP `default-src 'self'`, no inline scripts; HSTS in production; strict security headers.
- Logs are JSON, with keys matching tokens/passwords/emails/phones redacted; request logs replace IDs with `:id`.
- Rate limits are shared across instances via PostgreSQL. AI spend is capped per day globally and per customer.

## Backups and restore
- Use the managed database's point-in-time recovery (≥ 7 days) plus a daily logical dump kept off-site:
  `pg_dump --format=custom --no-owner "$DATABASE_URL" > tc-$(date +%F).dump`
- Restore test (monthly): `createdb tc_restore && pg_restore --no-owner -d tc_restore tc-YYYY-MM-DD.dump`, then point a staging instance at it and log in.
- Keep `TOKEN_ENCRYPTION_KEY` backed up separately; without it encrypted columns cannot be read (customers would need to reconnect Gmail).

## Retention (housekeeping job, hourly)
| Data | Retention |
|---|---|
| Expired sessions, OAuth states, email tokens | deleted after expiry (+7 days for tokens) |
| Provider cache | until expiry (10 min for flex flight quotes) |
| Provider usage metrics | `RETENTION_PROVIDER_USAGE_DAYS` (90) |
| Error events | `RETENTION_ERROR_EVENTS_DAYS` (30) |
| Finished jobs | `RETENTION_JOBS_DAYS` (30) |
| Webhook dedupe records | 30 days |
| Traveller details for booking | removed after handoff/cancel or 2 days |
| Customer data | until the customer deletes it or their account (`/account`) |

## Monitoring & support
- Watch `/admin`: integration errors (24 h), AI cost vs budget, notification failures, dead jobs, recent errors.
- Alert on: `/api/ready` failing, dead jobs > 0 in 24 h, overdue jobs > 50, AI spend > 80% of budget.
- Support playbook: "plan incomplete" → check the day's missing list and provider errors; "reminder not received" → admin notification failures (status sent vs delivered); "Gmail import empty" → customer reconnects (token revoked) or messages outside the 18-month search window.
