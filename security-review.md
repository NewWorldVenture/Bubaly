# Security Review

Living record of adversarial passes + fixes. Newest first; details in `todo.md`.

## 2026-07-12/13 stone-turn pass (fixed, commit 3b078ce)
- `guardian/screen` + `guardian/status/voicemail`: Twilio callbacks accepted unsigned requests
  → `x-twilio-signature` validated in production (full-URL-with-query form).
- `guardian/escalate`: **failed open** when `GUARDIAN_INTERNAL_SECRET` unset (unauthenticated
  emergency SMS/call blast) → fails closed (secret or CRON_SECRET required).
- `guardian/escalate/twiml`: open text-to-TwiML reflector → signature-gated.
- `mkt/track`: public service-role ingest had no rate limit → 60/min/IP.

## Earlier rounds (all fixed)
- AUTH-1: OAuth state CSRF binding. PAY-1: atomic card-auth reserve (no double-spend race).
  PAY-2: replay-safe webhook idempotency ledger. PAY-3: checkout admin gate.
  PAY-4/5 + AI-2: rate limits on model-backed public endpoints.
  AI-1: guardian prompt-injection hardening. Marketplace authz sweep.

## Standing controls
- RLS on every table (0118 universal enable + family-scoped policies; PG16-tested with
  `request.jwt.claim.sub` role switching). Client family-scoping audit: all `.from()` chains
  verified family- or parent-id-scoped with RLS backstop.
- API-route auth audit (95 routes): every route carries `requireUserContext` / admin guard /
  CRON_SECRET / webhook signature / internal secret / rate-limited-public classification.
- Secrets: none committed (`.env.example` documents names only); service-role key server-only.
- Offline cache wiped on sign-out (family data never persists on shared devices).

## Known residual risks / owner items
- GPG commit signing unavailable in the build sandbox (commits show "Unverified" on GitHub —
  cosmetic; committer identity is correct).
- Prod RLS depends on applying pending migrations (`docs/PENDING_PROD_MIGRATIONS.md`) — 0118
  first. CRON_SECRET + GUARDIAN_INTERNAL_SECRET must be set in prod env.
