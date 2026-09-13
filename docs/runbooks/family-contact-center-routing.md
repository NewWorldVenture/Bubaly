# Runbook — routing a family's @bubaly.com address to the Contact Center

The Family Contact Center's code is complete: an address is provisioned at
onboarding for Family+ households, the inbound webhook resolves the family from
the recipient local-part, files the message into the unified inbox, runs the AI
concierge, files attachments as paperwork, routes to the planner, and replies as
the family. None of it can run until mail is actually delivered to the webhook.

This is that configuration. It is **owner-gated** — it needs Vercel environment
access and DNS control, which no agent has.

Verified against production on 2026-09-13: `POST /api/contact-center/email`
answers **401**, which is the correct fail-closed state for "secret not set".

---

## 1. Set the shared secret

Vercel → Project → **Settings → Environment Variables**, Production scope:

| Name | Value |
|---|---|
| `CONTACT_CENTER_INBOUND_SECRET` | a long random string you generate |

Generate one with `openssl rand -hex 32`. Never commit it, and never put it in a
runbook, an issue, or a log line.

**Redeploy after setting it.** Vercel does not apply a new environment variable
to a running deployment.

### What the value controls, exactly

`app/api/contact-center/email/route.ts` authorises like this:

```
secret unset   →  authorised === (NODE_ENV !== 'production')
secret set     →  authorised === (provided === secret)
```

So in production an unset secret **fails closed** (401), while locally it stays
open so the route can be exercised without one. `docs/architecture/environment-registry.md`
previously recorded this behaviour as `conditional-unverified`; it is now read
from the route and confirmed against the live 401.

The secret may be presented either way — pick whichever your provider supports:

- query string: `?key=<secret>`
- header: `x-inbound-secret: <secret>`

## 2. Point MX at an inbound-parse provider

`@bubaly.com` needs a provider that accepts mail and POSTs it to the webhook as
multipart or form-encoded fields. The route reads the usual aliases, so most
providers work without a custom mapping:

| Field | Accepted names |
|---|---|
| recipient | `to`, `To`, `recipient`, `envelope_to` |
| sender | `from`, `From`, `sender` |
| subject | `subject`, `Subject` |
| body | `text`, `body-plain`, `stripped-text`, `plain`, then `html`, `body-html` |
| id | `Message-Id`, `message-id`, `messageId` |

Point the provider's inbound route at:

```
https://www.bubaly.com/api/contact-center/email?key=<secret>
```

Then set the `bubaly.com` MX records to that provider's inbound hosts, at
whatever priorities they specify.

**Do not remove or repoint existing MX records without checking what else uses
them.** Outbound sending is a separate concern: Resend sends from this domain
and relies on its own SPF/DKIM records, which MX changes do not affect. Changing
MX redirects *incoming* mail for the whole domain.

## 3. Check it end to end

```bash
# Before: 401, because the secret does not match.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://www.bubaly.com/api/contact-center/email \
  -H 'content-type: application/x-www-form-urlencoded' -d 'to=x@bubaly.com'

# After: send a real email to a provisioned family address and confirm it
# appears in that family's Contact Center inbox.
```

A 401 after setting the secret means the provider is not presenting it — check
whether it forwards the query string, and fall back to the header if not.

### Expected non-error responses

These are acknowledgements, not failures. The route answers 200 so the provider
does not retry something a retry cannot fix:

| Body | Meaning |
|---|---|
| `{"ok":true,"skipped":"no bubaly recipient"}` | The `to` field is not an `@bubaly.com` address |
| `{"ok":true,"skipped":"unknown address"}` | No family holds that local-part |
| `{"ok":true,"skipped":"plan"}` | The family is below Family+ (see `FAMILY_EMAIL_MIN_PLAN_LEVEL`) |

A **503** is the opposite: a read failed and the message was *not* handled. The
provider should retry, and it will be delivered once the read recovers. This
distinction is deliberate — answering 200 on a failed read would discard a
teacher's email because a database call blipped.

## 4. The other three webhooks

The same middleware entry exposes all four inbound routes. The other three are
Twilio's and authenticate differently — they verify `x-twilio-signature` and
answer 401 when it does not validate, so they need no shared secret:

| Route | Provider config |
|---|---|
| `/api/contact-center/sms` | Twilio number → Messaging webhook |
| `/api/contact-center/voice` | Twilio number → Voice webhook |
| `/api/contact-center/voice/transcription` | Twilio transcription callback |

They need `TWILIO_AUTH_TOKEN` set for signature validation to succeed.

---

## Why this document exists

The inbound side of the Contact Center could not have worked in production for
a different reason first: `/api/contact-center` was missing from the middleware
`PUBLIC` list, so all four webhooks answered a provider's POST with a 307 to the
HTML login page. The route — and its own authentication — never ran. That is
fixed, and guarded by `tests/middleware-public-api-boundary.test.ts`.

The failure presented as a provider problem rather than a routing one, which is
why it sat unnoticed. The same shape recurred four more times in this codebase
(the assistant bridge, the social preview images, the Pay-ID resolver, eight
marketing page families), so if mail is not arriving, check the boundary before
suspecting the provider:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://www.bubaly.com/api/contact-center/email
# 401 = the route ran and refused.  307 = it never ran.
```
