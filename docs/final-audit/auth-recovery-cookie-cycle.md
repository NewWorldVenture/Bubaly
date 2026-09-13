# Recovery cookie ownership repair

This bounded cycle repairs two response-cookie side effects found after checkpoint `4915cc6395bddb5b95de6248add150c6225fd998`. It changes recovery action cookie reads, the recovery-only callback branch, a dedicated cookie helper and focused tests. It does not change the global Supabase server factory, the recovery form, SQL, dependencies or provider settings. Root owns the necessary narrow middleware exclusions and combined gates.

## Reproduced failures

Two inline synthetic probes preceded the repairs. Both used the installed Supabase SDK; all provider transport was intercepted, and the verification fixtures used locally generated ES256 signatures.

1. The actual `saveRecoveryAction` and server factory read account A's access token with 20 seconds remaining. SDK `getSession()` refreshed it and queued an A auth cookie. While the password PUT was held, the simulated browser signed in as B. Applying the delayed action's queued cookies replaced B with A. The PUT correctly used A, with exactly one refresh and one password write; B's password was never changed. The form's browser precheck reduces the common near-expiry case but cannot prevent crossing the SDK refresh margin during transit.
2. The actual recovery callback exchanged a PKCE code for A while the incoming browser session was B. The required subsequent `/user` verification returned 503. The route redirected to `?error=invalid` and issued no grant, but the installed SSR adapter had already published A's auth cookie. A replayed-code 400 control preserved B and wrote no auth cookie.

The 121 existing server/action/callback tests passed before repair. The action tests mocked `getSession`, and the callback tests mocked the exchange factory; neither executed these session-cookie effects.

## Implemented behavior

`readRecoveryCookieToken()` derives the exact configured-project storage key using the same hostname rule as the SDK. It reads Next request cookies directly, without constructing a session client, refreshing, persisting or deleting cookies. SDK `combineChunks` and base64 helpers preserve the installed cookie format; legacy raw JSON remains supported. Parsing rejects duplicate names, base/chunk mixtures, gaps, noncanonical indices or encoding, unrelated suffixes, nonobject session data, and absent/oversized token strings. It allows at most 24 chunks and 65,536 encoded characters, with a 16,384-character access-token limit. Other projects and PKCE verifier cookies cannot supply a candidate.

Cookie parsing establishes no authority. The unchanged server verifier checks the exact extracted JWT, current provider user, signed grant, subject/session and original authentication window. Expired JWTs fail as `authRecovery.expiredLink` without refresh or cookie deletion. Unreadable/missing candidates report `authRecovery.sessionChanged`; invalid project configuration reports `authRecovery.setupRequired`. The form already refreshes the browser session before password submission.

`createRecoveryCookieExchange()` uses an isolated SSR client and stages its cookie changes in memory. Its cookie view retains the request's verifier and existing auth-cookie names for correct old-chunk deletion, while hiding ambient session values. This prevents constructor `INITIAL_SESSION` reads from refreshing the ambient account even though the installed SDK disables automatic refresh for server clients. The actual installed SDK performs the PKCE exchange. Only after the exact returned token passes `createRecoveryGrant` does the route copy staged cookies onto its successful redirect. A rejected exchange or post-exchange verification failure discards all candidate session changes and clears only the recovery handoff cookie. The client is disposed in `finally`.

Successful publication retains the global server factory's durable cookie options and actual SDK chunk cleanup. Failed exchange attempts keep the incoming verifier cookie, preserving existing SSR retry behavior. Retaining a verifier does not undo provider consumption of an accepted code; an accepted exchange followed by verification failure or lost response may require a new recovery link. No real code single-use, expiry, SMTP or delivery guarantee is inferred from the synthetic retry fixture.

Ordinary callback logic remains unchanged. Root's middleware exclusions remain necessary: a public recovery request must not acquire delayed ambient session cookies from middleware before reaching these repaired boundaries.

## Executed checks

Node 24.21.0 ran the following focused suites successfully:

- **207 tests** across `auth-recovery-server`, `auth-recovery-actions`, `auth-recovery-callback-execution`, `auth-recovery-cookie-execution` and `auth-recovery-cookies`.
- The **11 new action/callback execution cases** use actual production actions/routes/helper, the installed SSR exchange/cookie adapter and real synthetic JWT signatures. They cover the held near-expiry A write with a later browser B, zero refresh/write headers, chunked inspect/handoff, expired and wrong-user refusal, post-exchange verification outage, expired ambient constructor isolation, successful durable cookie publication and stale-chunk cleanup, failed-exchange verifier retention/retry, and rejected signed purpose evidence.
- The **75 parser/cookie cases** include cookies actually written by installed SSR `setSession` against intercepted transport, near-expiry and expired reads with no network or writes, exact project selection, raw JSON compatibility, strict encoding/structure, and chunk/body/token boundary values.
- **47 ordinary callback and review-routing controls** passed across `auth-callback-boundary`, `auth-callback-failed-signin-keeps-session` and `auth-review-selection-routes`.
- Scoped ESLint passed for all seven changed/new TypeScript files. A TypeScript API program using repository compiler options and those seven roots reported **zero diagnostics** with `noEmit:true` and `incremental:false`.

These are controlled server/SDK tests with synthetic cookie stores and transport. They do not launch Next, exercise browser application of real HTTP action responses, verify root's middleware changes, establish live provider policy or constitute full regression/build/deployment verification. No preview server, account operation, email, SQL, install, commit or push ran in this lane.
