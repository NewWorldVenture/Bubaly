# AI Call Guardian™ — setup & activation

Ported onto `main` fresh (the feature originated on the long-diverged
`claude/continuation-an1mam` branch, which forked 300+ commits back and can't be
merged). All code is live and the UI is reachable at **`/guardian`** (nav: AI Call
Guardian, plan level 1), but the feature ships **dormant** and degrades
gracefully until the steps below are done — the dashboard shows an empty state,
scam screening falls back to pure pattern heuristics, and the Twilio webhooks are
never hit because no number points at them.

## What it is
Intelligent screening & routing for calls / SMS / WhatsApp: a per-family **Trust
Graph** (immediate family → blocked), a **rules engine**, an **AI receptionist**
that screens unknown callers, **scam detection**, a full **communications log**,
**emergency escalation**, and a nightly **adaptive-learning** pass that proposes
parent-approvable trust/quiet-hours suggestions.

## Owner steps to activate

1. **Apply the migration** — `supabase/migrations/0137_ai_call_guardian.sql`
   (`supabase db push`). Creates the Guardian enums + family-scoped, RLS-guarded
   tables. Idempotent. Until applied, the dashboard reads return empty in prod.

2. **Set environment variables** (Vercel project settings):
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` — telephony
     (inbound voice/SMS/WhatsApp, escalation calls, number lookup). Without these,
     `isTwilioConfigured()` is false and the UI shows a setup prompt.
   - `ANTHROPIC_API_KEY` (preferred) or `OPENAI_API_KEY` — AI screening + scam
     analysis + call summaries. **Optional:** absent → deterministic pattern-based
     scam detection still runs; the AI just doesn't add a second opinion.
   - `GUARDIAN_INTERNAL_SECRET` — shared secret for internal route-to-route calls.
   - `CRON_SECRET` — authorizes the nightly `/api/cron/guardian-learning` pass
     (already required by the other crons).
   - `NEXT_PUBLIC_APP_URL` — base URL used to build Twilio callback URLs.

3. **Point a Twilio number's webhooks** at:
   - Voice → `POST /api/guardian/inbound/voice`
   - SMS → `POST /api/guardian/inbound/sms`
   - WhatsApp → `POST /api/guardian/inbound/whatsapp`
   - Status callbacks / voicemail → `/api/guardian/status/voicemail`

   Requests are verified with `validateTwilioSignature` (uses `TWILIO_AUTH_TOKEN`).

## Cron
`/api/cron/guardian-learning` runs nightly (`0 2 * * *`, see `vercel.json`):
auto-dismisses expired suggestions and generates new ones from the last 60 days
of activity for families that have Guardian data. The AI only proposes — parents
approve in the dashboard.

## Verification (at port time)
`tsc` clean · `eslint` clean · full suite **1925/1925** (incl. 20 Guardian tests:
seasonal + learning) · `npm run build` ✓ (all 5 pages + 8 API routes + cron
compiled). Client bundle safe — `formatPhone` was split into the pure
`lib/guardian/phone.ts` so no client component pulls in `lib/guardian/twilio.ts`
(node crypto + Twilio REST).
