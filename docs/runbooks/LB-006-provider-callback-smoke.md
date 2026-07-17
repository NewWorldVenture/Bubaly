# LB-006 runbook — third-party callback / webhook smoke tests

**P1. Owner + provider-sandbox credentials.** Verify each inbound provider callback fires end-to-end:
signature-verified, idempotent (no double-processing on retry), and fail-closed on a bad signature.
All the verification code is already in place (audited in PLA-0615); this proves it against real
provider events.

## The callbacks (grounded in the routes)

| Endpoint | Provider | Verifies with | Secret env | Idempotency |
|----------|----------|---------------|------------|-------------|
| `/api/webhooks/stripe` | Stripe (billing/subscriptions) | `stripe.webhooks.constructEvent` (`stripe-signature`) | `STRIPE_WEBHOOK_SECRET` | dedup on event id |
| `/api/webhooks/money` | Stripe **Issuing** (wallet cards) | `constructEvent` (`stripe-signature`) | `STRIPE_MONEY_WEBHOOK_SECRET` | dedup |
| `/api/webhooks/resend` | Resend (email delivery) | **Svix** `verify` | `RESEND_WEBHOOK_SECRET` | — |
| `/api/guardian/inbound/{voice,sms,whatsapp}` | Twilio | `validateTwilioSignature` (HMAC-SHA1) | `TWILIO_AUTH_TOKEN` | claim-ledger dedup |

Also "partial" in the service matrix: **Google** (calendar OAuth round-trip, A-18) and **web push**
(VAPID) — covered at the end.

All these routes are in middleware's public allowlist **by design** — the signature/secret IS the auth
boundary (verified fail-closed in PLA-0615). Smoking them proves that boundary against real events.

## Prereqs

Set the webhook secrets in the target env (test-mode values), and register each endpoint URL in the
provider dashboard (or use the provider CLI to forward). Use a **non-prod** Supabase/deploy so test
events don't mutate real data.

## Stripe billing — `/api/webhooks/stripe`

```bash
stripe login
stripe listen --forward-to https://<preview-host>/api/webhooks/stripe   # prints a whsec_… → set STRIPE_WEBHOOK_SECRET
# in another shell — drive the real events the route handles:
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
```
**Verify:** each returns 200; the family's `subscriptions` row moves plan/status; **replay the same
event** (`stripe events resend <id>`) → still 200 but **no double-apply** (dedup). Send a request with a
**bad/missing `stripe-signature`** → **400/401** (fail closed).

## Stripe Issuing (wallet) — `/api/webhooks/money`

Same pattern with `STRIPE_MONEY_WEBHOOK_SECRET`; trigger the issuing events the wallet relies on
(`issuing_authorization.request`, `.created`, `issuing_transaction.created`). **Verify:** an
authorization reserves/holds against the child's SPEND balance exactly once; capture reconciles the
hold; a replayed authorization does **not** double-reserve (this is the money-integrity path — pairs
with migrations 0155/0217).

## Resend (email) — `/api/webhooks/resend`

Resend signs via **Svix**. In the Resend dashboard add the endpoint, copy the signing secret →
`RESEND_WEBHOOK_SECRET`, then **Send test event** (delivered/bounced/complained). **Verify:** 200 and
the delivery state is recorded; a tampered `svix-signature` → rejected.

## Twilio guardian inbound — `/api/guardian/inbound/{voice,sms,whatsapp}`

From the Twilio console, point the number's voice/messaging webhook at each endpoint and place a real
test call/SMS/WhatsApp. **Verify:** a correctly Twilio-signed request is processed; a **forged**
`x-twilio-signature` → **401** (fail closed — `validateTwilioSignature` rejects when `TWILIO_AUTH_TOKEN`
is unset too). Confirm inbound de-dupes via the guardian callback claim ledger.

## Google (calendar OAuth) + web push

- **Google:** run the OAuth round-trip (A-18): connect a Google account, confirm the CSRF `state`
  round-trips, tokens are stored AES-256-GCM encrypted (`sync_tokens`, deny-all to clients), and a
  calendar sync pulls events. Refresh-expiry: force a token refresh and confirm re-auth works.
- **Web push:** subscribe a browser (VAPID), trigger a notification (e.g. a due reminder via the
  `notifications` cron with `CRON_SECRET` set), confirm delivery; unsubscribe and confirm no further
  sends.

## Exit criteria

For every callback above: valid signed event → processed (200); replay → idempotent (no double
effect); forged/missing signature → rejected (4xx); provider outage/timeout → the route degrades
without corrupting state. Capture the results and flip LB-006 → Resolved. (Cron-backed pieces also need
`CRON_SECRET`; see `docs/PENDING_PROD_MIGRATIONS.md`.)
