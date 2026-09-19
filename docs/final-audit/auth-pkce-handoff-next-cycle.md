# AUTH-001 PKCE handoff: next-cycle design

2026-09-19. **Design only; unimplemented and unverified.** This document prepares the next bounded cycle for the existing AUTH-001 record in [the permanent audit](../../finalaudit.md). It changes no application source, closes no record, and makes no hosted-authentication claim. The current integration's application source remains frozen.

## Executed evidence motivating the design

The [pending-signup/logout cycle](auth-pending-signup-logout-cycle.md#remaining-boundaries) records two separate executed reproductions using installed SDKs and synthetic intercepted responses:

- `tests/e2e/signup-boundaries.spec.ts`, “known separate SDK limitation: a later singleton refresh still consumes a pending signup verifier,” confirms that an ordinary browser refresh preserves the existing user but removes the pending verifier.
- `Temp/bubaly-ssr-pkce-refresh-probe-20260919.log` records the same SSR behavior: `hadVerifier: true`, `hasVerifierAfter: false`, `userRetained: true`, with a verifier deletion and session write. Middleware and the generic server factory use this cookie contract.

These are actual local reproductions, not proposed tests or provider-delivery evidence. The [earlier signup verifier cycle](signup-verifier-cycle.md) and [AUTH-001 coverage inventory](auth-recovery-test-inventory.md) provide preceding context. The completed explicit-logout fixes do not repair ordinary-refresh verifier loss.

## Proposed ownership contract

Keep the canonical pending handoff outside the SDK's `-code-verifier` namespace. A bounded, project-scoped record should contain an opaque attempt nonce, purpose, exact verifier, expiry, logout generation, and starting browser-session ownership. Session identity and cookie metadata establish freshness only; the provider remains authentication authority.

Persist and read back the record before dispatch. Bind the callback URL to its nonce. Prefer an immutable attempt-specific record plus a current-attempt pointer: an older completion may retire its own record without deleting a newer attempt's data. Bound record count, size and lifetime; choose expiry consistently with supported provider flows rather than reusing the session cookie's 400-day lifetime.

An isolated SDK operation receives only its captured verifier. SDK cleanup affects that operation's private storage, never the canonical handoff. Explicit application transitions retire the matching handoff after confirmed adoption or appropriate definitive initiation rejection. Lost or ambiguous responses retain evidence without an automatic repeat. Never restore retired cookie bytes.

Before browser adoption, require the exact current attempt, unchanged logout generation, live UI intent, and matching starting owner. A stable user/session identity should permit ordinary token rotation; absent, malformed or identity-less storage needs a defined conservative comparison. Check again at the actual synchronous cookie-write boundary, verify persistence, then compare-consume only the matching handoff. Cookie comparisons must not be described as a cross-tab transaction: prove interleavings, including partial writes, explicitly.

## Source responsibilities

| Source seam | Proposed responsibility |
| --- | --- |
| New `lib/auth/pkce-handoff.ts` and `lib/auth/pkce-client.ts` | Bounded record parsing, persistence/readback, attempt selection and retirement; isolated initiation/exchange storage and ownership. Names are proposals, not existing implementations. |
| `lib/auth/signup-client.ts`; `components/auth/signup-form.tsx` | Retain confirmation/uncertainty behavior and duplicate-submit protection while using the shared handoff contract. |
| `components/auth/oauth-buttons.tsx`; `components/auth/recovery-form.tsx` | Move shared-singleton OAuth and self-service reset initiation into owned operations; carry the nonce to the callback; gate provider navigation and late results. |
| `lib/auth/password-client.ts` | Reuse/extract token-receipt validation, provider user/session binding, empty bootstrap, deadline, final write guard, chunk cleanup and notification for PKCE adoption; retain existing password/child-login exports and guarantees. |
| `lib/auth/browser-session-storage.ts`; `lib/auth/browser-signout.ts` | Include pending app-owned attempts in explicit logout and intent comparison, while keeping ordinary session snapshots session-only. Preserve newer handoffs and generation fencing when deletion fails. |
| `lib/supabase/client.ts`; `lib/supabase/server.ts`; `middleware.ts`; `lib/auth/session.ts` | Prevent ordinary renewal from owning handoff state; disable automatic browser code exchange; recognize validated pending handoffs for misplaced-code routing without capturing unrelated `/api/` codes. Make all completion requests exempt from ambient refresh. |
| `app/auth/callback/route.ts`; proposed completion page/action | Make callback admission cookie-neutral. Exchange against isolated captured state and deliver an explicit checked receipt for guarded browser adoption, following the existing child-login pattern. Preserve plan selection, safe destinations, onboarding/admin/guest routing, and failed-link session fallback. |
| `lib/auth/recovery-cookies.ts`; `app/(auth)/auth/recovery/actions.ts`; recovery form | Replace direct `exchange.applyTo(response)` authentication-cookie publication with owned adoption. Reuse `createRecoveryGrant` and exact-token verification in `lib/auth/recovery-server.ts`. The form's duplicated installer currently omits logout generation from `authCookies()`; treat that source-level gap as a required test, not an executed new defect claim. |

Server responses cannot compare browser state changed after a request began. Therefore, neither ordinary nor recovery exchange may directly publish authentication `Set-Cookie` headers. Callback routing, grant preparation and error handling must also avoid creating a publishing ambient server client indirectly.

## Compatibility and SDK constraints

- Installed auth-js 2.108.2 `_saveSession` deletes the verifier on ordinary session saves; `_exchangeCodeForSession` removes it on both success and failure. Recovery stores a `/recovery` suffix that must survive unchanged.
- Installed SSR 0.12.0 factories override `auth.storage`. Core auth-js ignores supplied storage with `persistSession: false`. A public custom-storage operation therefore needs `persistSession: true`, private storage, a unique non-app storage key, no auto-refresh or URL detection, and empty bootstrap. The unique key prevents premature `SIGNED_IN` broadcasts reaching the app singleton. Dispose clients and bound the work.
- A sticky last-fetch flag cannot reliably identify the storage operation: verifier generation and cleanup can interleave with renewal. No private SDK patches, dependency edits, fake provider success, or guessed verifier recovery.
- Existing browser cookies and already-issued links need an explicit legacy policy. Ordinary browser and SSR refresh must preserve them until matched migration/consumption or explicit retirement. Do not require a nonce on an existing link and silently strand it.
- Preserve the admin sender's implicit flow in `app/(app)/admin/actions.ts`; a recipient cannot possess the administrator's PKCE verifier. Preserve verified implicit recovery and reject ambient-session fallback as recovery authority. Cross-device confirmation/recovery remains a separately verified product boundary.

## Required next-cycle evidence

1. Replace the known-loss browser characterization with a desired test: the pending signup verifier survives real singleton refresh, then exchanges successfully. Repeat for OAuth and self-service recovery, including reload and ordinary same-session rotation.
2. Promote the SSR probe into an installed-SDK regression covering both `createServer()` and middleware. Assert intact handoff state and correct refreshed session propagation to request and response. Update `tests/middleware-recovery-session.test.ts`, which currently expects ordinary `/auth/callback?next=/home` to refresh.
3. Extend `tests/e2e/password-session-ownership.spec.ts` or a dedicated completion suite with held exchange headers/body, token verification and final writes. Logout, newer session, newer handoff, unmount or deadline must prevent adoption; same-session renewal must remain usable. Include duplicate callbacks and late failures that must not consume the winner's handoff.
4. Extend `tests/e2e/logout-refresh-storage.spec.ts` and signup boundaries for pending-record-only logout, stale empty/session intents, refused deletion, partial cookie writes, malformed/expired records, unrelated project cookies and exact attempt consumption.
5. Update recovery callback/cookie/action execution suites to prove zero authentication `Set-Cookie` publication, verified token/user/session/grant binding and unchanged implicit recovery. Extend `tests/e2e/auth-recovery-ui.spec.ts` for logout-generation and newer-handoff races; retain ordinary failed-link fallback and safe destination tests.
6. Exercise legacy links/cookies, uncertain initiation and exchange, blocked persistence, concurrent tabs, and singleton auth-event reconciliation with the real installed SDKs. Preserve existing password, child-login, logout, recovery and persistence matrices. Use sanitized synthetic intercepted fixtures, no application server/provider, and `--cache=false` for Vitest.

No new tests were executed for this design. Implementation must first produce failing desired cases, then demonstrate the bounded repair without converting broader AUTH-001 or AUTH-002 status to PASS.
