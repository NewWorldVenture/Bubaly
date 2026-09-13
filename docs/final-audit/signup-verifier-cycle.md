# Signup verifier ownership cycle

2026-09-12. This continues `AUTH-001` and the lost-verifier defect recorded in `signup-boundaries-cycle.md`; it does not close the complete signup workflow. Starting published HEAD was `4915cc63` on `codex/final-production-audit-20260912`.

## Repair

`lib/auth/signup-client.ts` runs one email signup through the installed SDK and SSR cookie adapter in a disposable client. It uses the established recovery installer boundary: automatic initialization, URL detection, and refresh are disabled; the constructor's separate `INITIAL_SESSION` subscription sees an empty cookie view; only after that event may the SDK see the actual cookie names and values. The regular browser singleton remains available for ordinary authentication and receives the isolated client's normal `SIGNED_IN` broadcast.

The helper captures the exact encoded verifier during the SDK's write, before challenge hashing and dispatch. It verifies actual cookie persistence before sending. It defers this isolated signup's PKCE deletions until the result is known. Definitive non-transient 4xx rejection and successfully persisted confirmed signup clear only the verifier still equal to this attempt's value. Network/502/408/429/500, unreadable responses, and other uncertain outcomes leave the original cookie untouched. No backup cookie, guessed verifier, fake success response, automatic retry, or restore is used.

Actual cookie writes use a synchronous fresh comparison against the attempt's project-auth-cookie snapshot. The form supplies current mounted attempt/destination ownership. A cloned HTTP response must contain a valid UUID user and usable session fields before session writes are admitted. Cookie write readback must match the intended state before the SDK can publish `SIGNED_IN`. Newer signup, recovery, OAuth, signout, exchange, unmount, or destination changes fence stale session adoption. Full real cookie names remain visible during valid adoption, allowing the SSR adapter to remove old session chunks. Confirmation-required signup leaves existing session bytes unchanged.

Production changes are limited to the new helper and its `SignupForm` call. Global browser factory, server callback, recovery UI, SDK packages, SQL, and locales were not changed in this lane.

## Executed evidence

`tests/e2e/signup-boundaries.spec.ts` continues to execute actual React, SignupForm, providers, validation, and the installed Supabase browser SDK/SSR cookie adapter in Chromium. It now imports the SSR public index so its actual cookie parser/serializer/chunk helpers execute too. All HTTP is intercepted at synthetic `.invalid` origins; account identities, sessions, signup acceptance, and code exchanges are fixture data. Server actions and navigation remain controlled boundaries.

Final focused run: **46 Chromium checks PASS in 5.4 seconds**, Node **24.21.0**, four workers, 10-second case timeout. Scoped helper/form/spec lint and diff whitespace checks pass. The prior 21-case matrix remains covered; additional cases verify:

- Exact outgoing SHA-256 challenge/verifier agreement retained after 502, network loss, 408, 429, 500, and unreadable HTTP 400; no extra signup request.
- A later SDK PKCE exchange sends that retained verifier, receives the fixture session, and consumes the verifier.
- Older uncertain, definitively rejected, and session-returning signup responses cannot replace/delete newer signup, recovery, or OAuth verifiers.
- Signout and code exchange during a pending request are not undone. Unmounted/destination-retired requests cannot adopt a returned session or navigate; uncertain unmounted requests preserve their remaining verifier.
- Invalid UUID/session-token receipts cannot persist a session. Blocked verifier cookies prevent dispatch; blocked session writes cannot publish `SIGNED_IN` or claim confirmed signup.
- Expired ambient cookies are not initialized, repaired, or refreshed by the isolated client; confirmation-required signup preserves their bytes.
- Valid confirmed signup removes all previous large-session chunks, persists the new session, clears its own verifier, and delivers `SIGNED_IN` to the ordinary singleton in Chromium.

The first expanded run was 42/43 because a browser evaluate closure referenced a Node-side constant. Passing it as an explicit evaluate argument corrected that fixture error. Subsequent coverage additions produced the final 46-case result; no production behavior was weakened for that fixture correction.

Run using `PLAYWRIGHT_EXTERNAL_SERVER=1` and Node 24:

```text
node node_modules/@playwright/test/cli.js test tests/e2e/signup-boundaries.spec.ts --project=chromium --workers=4 --timeout=10000 --reporter=line
```

## Remaining boundaries

One of the 46 checks deliberately characterizes an unresolved separate SDK behavior: a later successful refresh through the ordinary singleton still removes a pending signup verifier in `_saveSession`. This repair prevents the failed signup's own cleanup from deleting it; it does not establish indefinite recovery of a pending verifier during every other session operation.

The callback evidence is an installed browser SDK exchange against a synthetic provider, not execution of the Next server callback, delivery of a real confirmation email, or deployed provider configuration. Other-browser confirmation, browser restart timing, phone signup, and actual OAuth/recovery provider workflows remain outside this fixture. Singleton notification was observed with Chromium's BroadcastChannel; environments without that facility have not been verified and have no new manual event-replay fallback.

Fresh comparison and cookie write occur without an intervening await in the same browser realm. This is not an atomic cross-process cookie transaction, nor does it coordinate server Set-Cookie responses or all other tabs. The helper never restores absent cookies and leaves later ordinary auth operations authoritative. Full source/build checks and publication belong to root; this lane performed no commit, push, install, or live provider action.

Final SHA-256 fingerprints:

| File | SHA-256 |
|---|---|
| `lib/auth/signup-client.ts` | `caf4c440616a6d9f41578b37afe56cd42b1f14a09f9d69832c954f817bd40c3a` |
| `components/auth/signup-form.tsx` | `cb5b7c9759e30e3bff7a734729b0d40725973482f8d2ab4f26b2ff4677b83561` |
| `tests/e2e/signup-boundaries.spec.ts` | `978524658502d5f883c9166755df1b20f40283a548829d864c3207cb604a8644` |
