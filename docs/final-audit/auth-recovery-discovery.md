# AUTH-001 registration, confirmation and recovery discovery

Read-only source discovery on 2026-09-12, initially against `910cd271bc273e68c286c3b10aaf1f27f6b933c2`. Final inspection at `ea3d6e40284e403a5ec986e993886420785f4162` found no intervening changes in the examined auth components, callback, admin action, Supabase factories or native recovery link. This lane adds only this document. No application, test, SQL, navigation or dependency files were changed; no real account, email, credential or provider operation was performed.

**The application has no implemented password-replacement continuation. Its existing admin reset sender also uses an implicit-flow client while the receiving browser uses PKCE.** The native “Forgot password?” link reaches an ordinary login form. These are actionable repository failures; live SMTP, mail templates and hosted redirect configuration remain separate, unverified dependencies. Root owns the permanent finding records, including the proposed AUTH-003 recovery record.

## Actual entry points and permanent inventory mapping

| Surface | Current chain | Existing inventory IDs |
| --- | --- | --- |
| Signup | `app/(auth)/signup/page.tsx` → `components/auth/signup-form.tsx:47` → production browser SDK `signUp` → immediate session or check-email state | UI-ROUTE-0354; COMPONENT-FF9788DC39FD |
| Confirmation callback | Signup sends `emailRedirectTo` to `/auth/callback?next=…`; `app/auth/callback/route.ts:15` consumes a query `code`, exchanges it, checks the user and resolves a safe internal destination | API-9A739F355ACF; ROLE-7394A5416880 |
| Login | `app/(auth)/login/page.tsx` → `components/auth/login-form.tsx:35` → `signInWithPassword` | UI-ROUTE-0353; COMPONENT-041133211BF5 |
| Admin recovery sender | `components/admin/user-security-actions.tsx:28` → `app/(app)/admin/actions.ts:446` → superadmin authorization, normalized email, service SDK `resetPasswordForEmail`, redirect `/login`, audit | COMPONENT-CF50929C616A; CONTROL-53FEF886BC16; ACTION-00F500AE8E65 |
| Native recovery entry | `mobile/app/(auth)/sign-in.tsx:66` opens `webUrl('/login?reset=1')`; the web LoginForm does not consume `reset` | MOBILE-ROUTE-001; CONTROL-EA2A71985DB3 |
| Session/client boundaries | Browser factory explicitly uses PKCE; service factory is regular Supabase `createClient` with `persistSession:false`; callback uses the SSR server factory | LIBRARY-E7335A071B71; LIBRARY-9A6B39502E62; LIBRARY-0CA6F9848493; LIBRARY-478BBDEF113D |
| Auth configuration and profile bootstrap | `supabase/config.toml:19`; `supabase/migrations/0003_functions_triggers.sql:50` `handle_new_user` inserts profile/preferences after Auth user creation | SUPPORT-63468A3CE4F2; DB-RPC-020 |

These are existing IDs, not new statuses or a full inventory regeneration.

## Findings and evidence strength

### High: recovery email has no password-setting destination

Searches of `app`, `components` and `lib` found no application `auth.updateUser` password mutation, `PASSWORD_RECOVERY` consumer, recovery form, or `token_hash` verification handler. The sole `resetPasswordForEmail` call is the admin action. LoginForm reads selection parameters and `error=auth`, then performs password sign-in; it has no recovery mode. The native `reset=1` link therefore does not offer a reset request or a new-password form.

The callback only exchanges `code`; it discards the exchange result's recovery discriminator and routes through ordinary login destinations. Even a successful recovery exchange would have no password-update screen. This is established by application source, independently of SMTP delivery. Supabase's documented recovery flow requires both a request step and a password-update step after recovery authentication. [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords), [resetPasswordForEmail reference](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail).

### High: the existing admin sender and browser receiver use incompatible default flows

`lib/supabase/server.ts:57` creates the service client without a `flowType`. The installed Auth SDK defaults to `implicit`; `resetPasswordForEmail` only sends a PKCE challenge for a PKCE client. The action directs this request to `${APP_URL}/login`. Conversely, `lib/supabase/client.ts:45` and the installed SSR browser factory select PKCE. The installed Auth SDK rejects an implicit token-fragment callback when initialized in PKCE mode.

An inline, read-only probe executed the installed SDK with synthetic `.invalid` URLs, a synthetic token fragment, in-memory cookies and intercepted fetch. No live request was possible. It observed:

| Actual SDK operation | Observed result |
| --- | --- |
| Service-style `resetPasswordForEmail` | `/auth/v1/recover` request; redirect `https://app.invalid/login`; no PKCE challenge |
| Production-style `createBrowserClient` initialization on an implicit `type=recovery` token fragment | `AuthPKCEGrantCodeExchangeError: Not a valid PKCE flow url.`; zero provider requests; zero cookie writes; fragment still present |

This executes the installed client behavior, not a complete Next page or real mailed-link journey. LoginForm creates the client on submission, so initialization timing depends on the rendered client tree. Hosted templates may customize the link format; their actual settings were not inspected. A `token_hash` template also needs a consumer that the current application does not implement. This does not justify changing the global browser client away from PKCE.

### Medium: accepted admin reset request can become a thrown action with a stuck busy control

`adminSendPasswordResetAction` awaits `adminAuditLog` after the reset provider has returned success (`app/(app)/admin/actions.ts:455–461`). `adminAuditLog` performs `await getUser()` before calling the best-effort logging helper (`:38–47`). `lib/supabase/auth.ts:59–68` throws on a retryable required auth lookup failure. Although `lib/server/audit.ts` catches its own insert errors, it does not cover that preceding lookup.

Consequently, provider acceptance followed by an audit actor lookup failure can reject the action after the email request has already been accepted. `UserSecurityActions.sendReset` has no catch/finally; its `setBusy(false)` occurs only after the awaited action resolves. A rejected action can leave the button disabled and produce no useful outcome. This is a concrete source-backed throw chain, **not yet an executed actual-action/DOM reproduction**. A lost provider response also cannot be interpreted as proof that no email request was accepted. The repair should distinguish confirmed request acceptance from an auxiliary audit failure and avoid automatic resend on uncertainty.

### Confirmation remains incompletely verified, with no resend/recovery affordance

Signup validates the shared schema, preserves a validated internal destination, sends profile/referral metadata and displays check-email when the SDK returns no session (`components/auth/signup-form.tsx:47–92`). That view offers a return to login; it has no resend or email-token entry action. Source inspection did not establish how a person recovers from an expired link, missing initiating-browser verifier, or accepted signup with a lost response.

PKCE binds the code exchange to the initiating browser's verifier. A link opened elsewhere can therefore fail the application's exchange, but email confirmation may already have occurred at the provider and password login may still work. This discovery does **not** claim every cross-browser signup permanently locks out the user. The missing end-to-end execution and recovery copy need targeted tests. [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

## Transient exchange correction: server verifier retention is not a reproduced defect

An initial raw Auth SDK/in-memory-storage probe returned `AuthRetryableFetchError` for a synthetic 503 exchange, removed its verifier, and failed the second attempt locally with `AuthPKCECodeVerifierMissingError`. Applying that result directly to the production server callback would be incorrect.

The follow-up probe used the actual installed `@supabase/ssr` browser and server factories with cookie adapters. After the same intercepted 503:

| Adapter | Verifier cookie retained | Cookie write calls | Fresh client's second exchange | Total HTTP attempts |
| --- | --- | ---: | --- | ---: |
| SSR server | Yes | 0 | `AuthRetryableFetchError` | 2 |
| SSR browser | No | 1 | `AuthPKCECodeVerifierMissingError` | 1 |

The server adapter records pending removal but applies it on relevant successful auth/signout events (`node_modules/@supabase/ssr/src/cookies.ts:449`; `createServerClient.ts:170`). A failed exchange alone does not flush it. The current callback also creates a fresh server client for its fallback lookup. These SDK probes were executed inline on Node 22.23.1 with Auth SDK 2.108.2; they are characterization evidence, not retained regression tests or a complete execution of the application callback. No production callback change should be based on the raw-memory result.

The callback deliberately preserves an existing valid session when another login exchange fails. That existing behavior is not a recovery defect. A future recovery consumer must not mistake unrelated preserved session B, following a failed recovery link for A, for authorization to change B's password. Test this before introducing password mutation; do not force-signout valid sessions merely because a recovery link fails.

## Existing executable coverage and limits

The independent inventory lane ran **200/200 existing unit checks across 13 files** and **34/34 synthetic Chromium checks across two files** under isolated Node 24.21.0. Exact files, counts, command lines and Temp report paths are recorded in [auth-recovery-test-inventory.md](auth-recovery-test-inventory.md).

The passing total includes static admin gate checks, mocked SDK callback seams, mocked React-hook form execution and supporting persistence tests. It contains no executing reset sender, recovery consumer or password-update case, and no complete browser signup → PKCE storage → actual SSR callback exchange chain. The 22 actual-SDK cache browser cases and 12 mocked-transport lifecycle cases preserve valuable session evidence without proving recovery. Existing account-creating E2E fixtures use `email_confirm:true` and bypass mail confirmation; they were not executed in this lane. No full workflow is marked passed by this discovery.

## Smallest next implementation and actual-module tests

1. **Establish a compatible recovery contract before adding mutation.** Add an unauthenticated request entry and an authenticated password-setting destination, available before family onboarding. Support the native `reset=1` entry explicitly. Keep destination validation and global PKCE semantics. Use same-browser PKCE for self-service; choose explicitly how admin-sent implicit links are supported, or pair a `token_hash`/`verifyOtp` consumer with a separately verified mail-template change. A query or fragment saying `type=recovery` alone is not verified authority. Bind the mutation to the user/session produced by successful recovery verification and reject expired, absent or mismatched recovery evidence.
2. **Execute the real signup/confirmation handoff.** Mount actual SignupForm with the production browser client and intercepted Auth transport. Capture the verifier/challenge and pass synthetic provider results to the actual callback with the installed SSR client/cookie jar. Assert successful and failed exchange, persisted cookies, missing/wrong verifier, transient retry, unsafe destination rejection, and unrelated existing session retention. Intercepted provider fixtures cannot establish real server single-use or expiration rules.
3. **Execute recovery end to end with synthetic transport.** Cover self-service request and admin request formats; successful verified recovery followed by exactly one password update; invalid/replayed/expired links; wrong current user; no-code/no-token entry; provider returned/thrown errors; accepted update with lost response; refresh/restart behavior and explicit signout. Verify secret fragments are removed after consumption and never logged or copied into redirects. Keep revoked-session enforcement and ordinary warm-session preservation.
4. **Execute the admin lost-response boundary.** Run the actual action with verified/denied admin contexts, invalid email, returned/thrown provider failures and provider success followed by audit actor lookup failure. Mount the actual control to prove busy/error cleanup and prevent unintended duplicate sends. This is a bounded addition to the existing form/action fixtures; the current regex authorization tests do not substitute for it.

No SQL migration is needed to implement these application seams. New top-level public recovery routes would require explicit middleware public-route treatment; an `/auth/...` destination already fits the existing public auth subtree. Exact file ownership and production edits remain for root dispatch after findings are recorded.

## Database and deployment boundary

Supabase Auth owns user creation, confirmation/recovery tokens, token expiration/single use, password changes and mail delivery. The application trigger `handle_new_user` creates public profile/preferences rows; it does not implement recovery tokens. The existing admin service client remains server-only and protected by the superadmin guard. Recovery must not create service-role authority in a browser or bypass current account revocation.

`supabase/config.toml` specifies signup enabled, a localhost site URL and a localhost callback allowlist; it does not prove hosted email-confirmation, SMTP, rate-limit or template configuration. `APP_URL` uses environment names `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_SITE_URL` with a production fallback. Application Resend setup is not evidence that Supabase Auth SMTP is configured. No environment values, live provider settings or real inboxes were inspected. Hosted redirect allowlists, actual template format, mail arrival and real expired/replayed-link behavior remain deployment-dependent verification.

## Source snapshot

SHA-256 values of the inspected working files; auth source was unchanged between the initial and final commits noted above:

| Path | SHA-256 |
| --- | --- |
| `components/auth/signup-form.tsx` | `b20803f069180dc8094ec01bd03c03c390b7a1d5e8c9ca453662a7d609452447` |
| `components/auth/login-form.tsx` | `ade106698dd93abf092ce0535fdaa5b6b3bd428bcbbef001038c403c7f949969` |
| `app/auth/callback/route.ts` | `841f79abb76fe09713fb82e058559066efcfc66009e8a7e5a50fa6a623f45c76` |
| `app/(app)/admin/actions.ts` | `d5acb2c61d2c0d653d4ac20e9022ad16682595d1cf90b4ebc9989f684ca3278f` |
| `components/admin/user-security-actions.tsx` | `aa70f91c2f0033ff73e73dec81d96b732bd2a2b1b19560660e3164cb6538513b` |
| `lib/supabase/client.ts` | `de4169506c349bff441856947f509b7d3ed829576ec9bbf11d39e6cd2c779085` |
| `lib/supabase/server.ts` | `61492f44649c26603235f237c2a7b191eb5d4302787f5a905d56b060bba21d06` |
| `mobile/app/(auth)/sign-in.tsx` | `fa23c92c913da6e708875a49fc81a945eddb93b094af32fcf9bb731d9b5c8cdb` |
| `supabase/config.toml` | `f0b7bc24ada4896a6c9e1cf666779e25899a14bab8c2dcbedd1b037a9ec90d91` |
