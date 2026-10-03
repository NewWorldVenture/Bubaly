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

**Status on 2026-10-03** (blocked-rows eligibility review, MAIN-F6 / MAIN-F-E06):
step 1 is done — production's `/api/health` does not list
`CONTACT_CENTER_INBOUND_SECRET` among its missing feature secrets. Step 2 is
not: public DNS still answers `bubaly.com MX 10 mx1.improvmx.com / 20
mx2.improvmx.com` (SPF `include:spf.improvmx.com`), a forwarding service, not an
inbound-parse provider aimed at the webhook. Step 3 cannot run until it is.

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

The secret may be presented three ways. Pick the first your provider supports:

1. header: `x-inbound-secret: <secret>` — for providers that can set a custom
   header (Cloudflare Email Workers, your own relay).
2. HTTP Basic credentials in the webhook URL:
   `https://inbound:<secret>@www.bubaly.com/api/contact-center/email` — for
   providers that cannot set a header but accept `user:password@` in the URL.
   Postmark documents this for its webhooks; for any other provider, confirm
   with the §3 check that it sends `Authorization: Basic` for such a URL before
   moving MX. The username is ignored; the secret is the password. The provider
   sends it as an `Authorization: Basic` header, so it never appears in the
   request line that access logs record.
3. query string: `?key=<secret>` — last resort. It works, and the route warns
   on every request that uses it, because a secret in a URL is written to every
   access log and proxy log along the path (MAIN-F-E06). With 2 available, a
   provider that cannot set a header no longer has to use this form; whether to
   remove it is the owner's decision, recorded under SEC-011.

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

Point the provider's inbound route at (see §1 for which form):

```
https://inbound:<secret>@www.bubaly.com/api/contact-center/email
```

or, where the provider can set headers, at the bare URL with
`x-inbound-secret: <secret>`. Use `?key=<secret>` only if it can do neither.

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
that it sends the credentials you configured (Basic credentials arrive as an
`Authorization` header; some providers drop a query string on redirect).

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
