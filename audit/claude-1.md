# Claude-1 — Coordinator · Architecture · Integrations

Findings only. Format and rules: `audit/README.md`.
This file is written by Claude-1 and by nobody else.

---
## Sweep 1 — one concept, two implementations

The question for this sweep: this codebase repeatedly builds a shared helper
*specifically* to stop two call sites drifting apart, and says so in the
helper's own comment. Did the call sites adopt it?

Census of the anti-drift helpers (files referencing each, across `app/`, `lib/`,
`components/`, `shared/`):

| helper | purpose | adopters |
|---|---|---|
| `settleAll` | a `Promise.all` that does not discard errors | 155 |
| `notify` | one notification path instead of raw inserts | 70 |
| `readAll` | reads past PostgREST's row ceiling | 27 |
| `logAudit` | one audit-trail write | 13 |
| `authenticateAI` | one AI-edge authenticator | 10 |
| `resolveFeatureEntitlement` | one entitlement answer for page **and** pipeline | 7 |
| `familyMediaPath` | one unguessable storage path | 7 |

Adoption is good. One of them was not adopted at the very place it was written
for, and that is finding 1.

---

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The AI edge has two authenticators, and nine routes depend on the untranslated one

- **File:** `app/api/ai/route.ts:45` (private `authenticate`) vs `lib/server/ai-access.ts:180` (`authenticateAI`)
- **Problem:** `lib/server/ai-access.ts` says in its own header that `authenticateAI`
  *"resolves both to the same `UserContext` and an RLS-bound client, **mirroring
  `app/api/ai/route.ts` so the two AI edges cannot drift in what they accept**."*
  The shared helper was written by mirroring that route — and that route never
  adopted it. It still has its own private `authenticate()`.
- **Evidence:** the two functions were read side by side. Every branch, code and
  status matches exactly: bearer → `invalid_token` 401 / `needs_family` 403 /
  `unavailable` 503; cookie → `signed_out` 401, then `ensureActiveFamily` and a
  re-resolve. **The authorization logic has not drifted.** What has drifted is
  the copy:

  | | `/api/ai/route.ts` | `lib/server/ai-access.ts` |
  |---|---|---|
  | needs-family | `tr('ai.finishSettingUpYourFamily')` | `'Finish setting up your family in Bubaly first.'` |
  | unavailable | `tr('ai.accountContextIsTemporarilyUnavailable')` | `'Account context is temporarily unavailable.'` |

  Six user-facing strings are hardcoded English in `ai-access.ts`
  (lines 122, 144, 150, 184, 186, 197), and they are served by **ten** route
  handlers: `/api/ai`, `/api/ai/requests`, `/api/ai/voice/transcribe`,
  `/api/ai/voice/speak`, and the six `/api/ai/runs/[id]/*` controls.
- **Impact:** every non-English user of those ten endpoints gets English on the
  failure path. It lands hardest on the mobile client, which is the caller these
  routes were built for: it sends a bearer token and **no cookie**, so
  `Accept-Language` is the only locale signal it has — and
  `getAIRequestTranslations(req)` already reads exactly that. The route that
  *does* translate is the one that does not use the shared helper.
- **Fix:** thread a `Translator` through `authenticateAI` and `assertAIAccess`
  (both already take an options object), defaulting to `getTranslations()`; lift
  the six strings into the catalogues; then delete `/api/ai`'s private
  `authenticate()` and call `authenticateAI` — which is what the comment claims
  is already true.
- **Status:** OPEN
- **Correction, mine:** **I made this marginally worse earlier today.** Pass L
  added the allowance message at line 150 and rewrote the `plan_required` copy at
  the same time, both as hardcoded English, matching the file's existing style
  rather than fixing it. Recording it here rather than quietly folding it into
  the fix.

---

### [CLAUDE-1][MEDIUM][ARCHITECTURE] The i18n gate cannot see the surface that answers the mobile app

- **File:** `scripts/i18n-scan.mjs:26` (`GATED_SURFACES`)
- **Problem:** the gate that fails CI when a translated surface regains a
  hardcoded string covers `app-shell`, `marketing-header`, `marketing-pages`,
  `marketing-components`, `marketing-display-catalogs`,
  `marketing-public-pages`, `marketing-lib-copy`. **No entry covers `app/api` or
  `lib/server`.**
- **Evidence:** that key list is the whole of `GATED_SURFACES`. Finding 1's six
  strings sit in `lib/server/ai-access.ts` and the gate is structurally incapable
  of reporting them — this is not a rule that was broken, it is a surface the
  rule was never pointed at.
- **Impact:** the API layer is precisely where locale is hardest and matters
  most: a browser carries a cookie the server can read, and the Expo client
  carries neither cookie nor session — only `Accept-Language`. So the one surface
  with no fallback signal is the one with no gate.
- **Fix:** add an `api-errors` surface covering `app/api/**/route.ts` and the
  `lib/server/*` modules that return user-facing `error:` strings. The gate's own
  README says adding a surface is a promise — so lift the strings first, then
  add the surface, in that order.
- **Status:** OPEN

---

### [CLAUDE-1][HIGH][INTEGRATIONS] Guardian scam screening cannot say that it did not run

- **File:** `lib/guardian/scam-ai.ts:67` (`detectScamWithAI`), consumed by
  `app/api/guardian/inbound/sms/route.ts:79` and
  `app/api/guardian/inbound/whatsapp/route.ts:86`
- **Problem:** three separate paths return a **pattern-only** verdict, and the
  return type has no field that says so:

  ```ts
  const patternResult = detectScamFromText(transcript, callerNumber ?? undefined);
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return patternResult;                 // 1. AI unconfigured
  …
  return validateResult(parsed, patternResult);      // 2. model reply unparseable
  } catch { return patternResult; }                  // 3. provider threw
  ```

  `ScamDetectionResult` is `{ isScam, scamType, confidence, signals, recommendation }`
  — no `source`, no `degraded`, no `analyzedBy`. A regex verdict and a model
  verdict are the same object, **including `confidence`**.
- **Impact:** this is the surface that tells a family whether a message reaching
  their child is a scam. With no API key set — which is the state of any
  deployment that has not configured one — every inbound SMS and WhatsApp message
  is screened by pattern matching alone, and reported with a confidence number
  that reads as analysis. A family acts on `recommendation: 'safe'` believing the
  message was read; it was matched against a word list.
- **Evidence that this class is already understood here:**
  `app/api/behavior/insight/route.ts` carries a comment calling the same shape
  *"the sharpest silence on this list… it answers 200 with a warm sentence that is
  indistinguishable from coaching. Nothing recorded any of the three."* The
  recognition exists; it did not reach this file.
- **Fix:** add `source: 'ai' | 'patterns'` (and a `degradedReason`) to
  `ScamDetectionResult`; set it at each of the three fallbacks; record it on the
  stored screening row; and surface it to the family as *"screened by pattern
  matching — AI screening is unavailable"* rather than as a confidence. Log the
  provider failure, which today is swallowed by a bare `catch {}`.
- **Status:** OPEN

---

### [CLAUDE-1][INFO][ARCHITECTURE] Module layering is clean

- **Evidence:** `grep -rn "from '@/app/" lib shared` returns **0**. Nothing in
  `lib/` or `shared/` imports from `app/`, so the dependency direction is
  one-way and the `'use server'` RPC boundary reasoning in Pass N holds without
  exception.
- **Status:** VERIFIED

---
## Sweep 2 — integration failure modes

For each provider: when it is unconfigured or down, does the feature fail open,
fail closed, or fail *silently while claiming success*? The third is the shape
Pass C was built around, and the interesting place to look for it is at an
integration boundary rather than a database one.

**Mostly clean, and worth stating.** `twilioFetch` throws on any non-2xx and on
an unconfigured account (the SID interpolates to `undefined`, the URL 404s), so
Twilio fails loud rather than no-op. Three of the four `sendSms` call sites catch
and `console.error`. `hasEncryptionKey()` is checked before both sync OAuth
callbacks and redirects to `error=no_encryption_key` rather than storing an
unencrypted token. `isAIConfigured()` gates the assistant with a 503 and a code.

One path is not clean, and it is the emergency one.

---

### [CLAUDE-1][MEDIUM][INTEGRATIONS] An emergency escalation records parents as notified who were not

- **File:** `app/api/guardian/escalate/route.ts:112` (`notifiedIds.push`) vs `:115-120` (the send)
- **Problem:** the member id is pushed onto `notifiedIds` **before** anything is
  attempted, and the row is written with `notified_member_ids: notifiedIds`:

  ```ts
  const phone = m.user_id ? phoneMap.get(m.user_id) : null;
  if (!phone) continue;
  notifiedIds.push(m.id);          // ← recorded as notified here

  try {
    await sendSms(phone, smsText);
    smsSent = true;                // ← honest: only on success
  } catch { /* non-fatal */ }      // ← and no log at all
  ```

  `smsSent` is correct — it is set only after `sendSms` resolves, which is
  **C-02**'s fix applied properly. `notifiedIds` is the same defect one level
  down, and C-02 did not reach it.
- **Evidence:** `pushSent` comes from a single family-wide `notifications` row
  (`user_id: null`), inserted once outside the loop — so it is a family-level
  fact and cannot stand in for any individual member. `smsSent` is one boolean
  for the whole loop, so if the first parent's SMS succeeds and the second's
  throws, the row reads `sms_sent: true` with **both** parents in
  `notified_member_ids`. Nothing distinguishes them.
- **Impact:** `guardian_escalations` is the record of who was warned about a
  family emergency — read afterwards by the family, and by anyone asked why a
  parent did not respond. It can say a parent was notified when their SMS threw.
  And the bare `catch { /* non-fatal */ }` is the **only** send path in this
  codebase that discards the error without logging: the three Contact Center
  callers all `console.error`. So there is no way to reconstruct which parent
  was actually reached.
- **Fix:** track per-member outcomes rather than one boolean — push to
  `notifiedIds` only after a channel succeeds for that member, and log the
  failure the way the Contact Center paths do. If the column is meant to record
  *intent* rather than delivery, rename it; `notified_member_ids` on an emergency
  record cannot mean "we tried".
- **Status:** OPEN

---

### [CLAUDE-1][INFO][INTEGRATIONS] Provider degradation, checked

| provider | unconfigured | on failure | verdict |
|---|---|---|---|
| Twilio | `twilioFetch` throws (SID is `undefined`, URL 404s) | throws with status + bounded body | loud — good |
| Stripe | `effectiveSecretKey` falls back to env, then `null` | — | admin page shows `hasSecret` boolean only |
| Sync (Google/Microsoft/Apple) | `hasEncryptionKey()` guards both callbacks | redirects `error=no_encryption_key` | closed — never stores a plaintext token |
| AI (assistant) | `isAIConfigured()` → 503 `not_configured` | `describeAIError` | honest |
| **AI (scam screening)** | **silently degrades to pattern matching** | **silently degrades** | **see the HIGH finding above** |

- **Status:** VERIFIED
## Sweep 3 — the scheduler

### [CLAUDE-1][MEDIUM][ARCHITECTURE] Every cron route runs from two schedulers, on an idempotency claim nothing checks

- **Files:** `vercel.json` (24 `crons` entries) · `scripts/cron-dispatch.mjs`
  (`SCHEDULES`, 24 entries) · `.github/workflows/cron-dispatch.yml` (ticks `*/5`)
- **Evidence:** set-compared the three sources.

  ```
  routes on disk      : 24
  scheduled in vercel : 24
  in the dispatcher   : 24
  ROUTE WITH NO SCHEDULE ANYWHERE: none
  SCHEDULED BUT NO ROUTE        : none
  IN BOTH (would double-run)    : all 24
  ```

  No orphan route and no orphan schedule — that part is clean and worth
  recording. But **all 24 are scheduled twice**, and this is deliberate: Vercel's
  Hobby plan fails a deployment that schedules anything finer than daily, so
  `vercel.json` holds daily-safe schedules for the deploy and the real cadences
  live in the dispatcher.
- **Problem:** the design rests on one sentence in `scripts/cron-dispatch.mjs`:

  > *"The routes are idempotent and CRON_SECRET-gated, so a Vercel daily run and
  > a GitHub run of the same route never conflict."*

  That claim is load-bearing for all 24 routes, and **nothing verifies it.** It
  has already been false: Pass B's **F-014** found notification dedupe failing on
  every run, so every run re-notified — precisely the failure this sentence
  assumes away. F-014 was closed by running the notification cron **five times**
  and counting duplicate groups. That technique proves the claim for **1 of 24
  routes**. The other 23 have no such proof, and a route that quietly loses its
  dedupe tomorrow will send a family two digests, two reminders, or two
  allowances before anyone notices.
- **Impact:** bounded but real, and it varies by route. `wallet-allowance`
  carries a timestamp guard and a dedupe key, which is what you want on money.
  `weekly-digest` and `admin-digest` send email. `automations` and
  `autopilot-scan` take AI actions on a family's behalf.
- **Fix:** a harness test that runs each of the 24 routes **twice** against the
  replayed database and asserts the second run writes nothing new — the shape
  F-014's fix already used, generalised from one route to the table. The route
  list should come from `SCHEDULES` so a route added tomorrow is covered
  tomorrow, the way `run-probes.sh` globs.
- **Status:** OPEN

#### The count I did NOT report, and why

A first scan looked for an idempotency mechanism in each route file and reported
**11 of 24 with none** — including `notifications`, the one route F-014 already
proved idempotent. That number is wrong. `cron/notifications` dedupes inside
`generateFamilyNotifications` on `related_id` (with `0293` making it a key), and
the mechanism is simply not visible at the route's own level; the same is true
for others that delegate to a service.

**Eleven is not a finding, it is a scan that cannot see helpers.** That is the
tenth time in this audit a pattern-based count would have been wrong, and it is
recorded here so the number is not mistaken for a result. It is also the reason
the recommended fix is a *behavioural* test — run it twice and look — rather than
a static one: the property is not visible in the text.

---

### [CLAUDE-1][INFO][ARCHITECTURE] Scheduler coverage is complete

Every `/api/cron/*` route on disk has a schedule, and every schedule names a
route that exists — in both `vercel.json` and `scripts/cron-dispatch.mjs`. There
is no job that never runs and no schedule pointing at a 404. Verified by set
comparison of all three sources.

- **Status:** VERIFIED
