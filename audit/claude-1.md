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
