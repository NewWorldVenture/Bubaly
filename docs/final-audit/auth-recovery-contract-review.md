# AUTH-003 recovery authority contract review

Read-only review on 2026-09-12 after source checkpoint `ea3d6e40284e403a5ec986e993886420785f4162`. This lane changes only this document. Three installed-SDK characterization probes ran inline under isolated Node 24.21.0 with synthetic tokens, memory storage and intercepted `.invalid` HTTP requests; no production/test edits, SQL, real accounts or emails.

**Recommendation: keep global PKCE, use a dedicated public `/auth/recovery` handoff, bind every mutation to the verified candidate's user and session, and explicitly distinguish PKCE recovery proof from legacy implicit bearer-session compatibility. Requiring `amr=recovery` for every admin email is incorrect for the provider source examined.**

## What actually proves what

| Input/result | Authority and limitation |
| --- | --- |
| `type=recovery`, `reset=1`, recovery destination | Untrusted routing/UI hints. They do not authenticate a user or establish a recovery session. |
| SDK `PASSWORD_RECOVERY` event / exchange `redirectType` | SDK signaling. `GoTrueClient.ts:1941` reads redirectType from the local verifier's `/recovery` suffix. Implicit URL handling returns `params.type` at `:3870`. A success event is not a signed recovery-purpose claim. |
| `getSession()` / decoded JWT alone | Locally stored data. Not current provider verification and not sufficient authorization. |
| `getClaims(candidateAccessToken)` | Verifies that exact JWT's signature/expiration using JWKS or provider lookup. Application still validates project issuer, audience, role, subject, session ID and required claim shape. With asymmetric signatures, this alone does not establish current session/account validity. |
| `getUser(candidateAccessToken)` | An explicit-token provider user lookup. Require success and `user.id === verifiedClaims.sub`; never substitute parameterless `getUser()` on a failed candidate. |
| PKCE returned JWT `amr.method=recovery` | Signed purpose evidence after token verification. The provider takes the authentication method from its verified flow state. The SDK's local redirectType is only a routing aid. |
| Implicit recovery / `verifyOtp({token_hash,type:'recovery'})` JWT | Current official provider source issues the generic `otp` method. This proves an authenticated OTP session after JWT/provider verification, not a uniquely distinguishable recovery event. |
| `setSession({access_token,refresh_token})` | Installs a session; it does not validate recovery purpose. For nonexpired access it checks `/user` and stores the refresh token without checking their mutual binding. For expired access it refreshes and may return a different supplied refresh token's identity. |

Supabase documents both `otp` and `recovery` as possible AMR methods, and describes `getClaims` verification behavior. Those lists do not guarantee every recovery transport emits the same method. [JWT claims reference](https://supabase.com/docs/guides/auth/jwt-fields), [getClaims reference](https://supabase.com/docs/reference/javascript/auth-getclaims).

The decisive provider source is `internal/api/verify.go:174–181,268`: implicit verification and POST OTP verification call `issueRefreshToken(...models.OTP...)`; the PKCE branch saves the parsed method. `internal/api/token.go:229–255` verifies the code/verifier and issues tokens using that saved method. These are upstream source observations, not inspection of the deployed project's Auth version. [Verification implementation](https://github.com/supabase/auth/blob/master/internal/api/verify.go), [PKCE token implementation](https://github.com/supabase/auth/blob/master/internal/api/token.go).

Therefore the initial provisional suggestion of a universal `amr=recovery` gate was withdrawn before implementation. Ordinary OTP and implicit recovery tokens cannot be distinguished cryptographically from these returned fields. Do not call a generic OTP claim uniquely verified recovery purpose.

## Minimal two-path handoff

**Self-service:** request a recovery email through the existing browser PKCE singleton, with a fixed internal recovery destination. Exchange its code using the actual SSR cookie adapter. Validate the exact returned token and fresh user, including recovery AMR and matching `sub`/`session_id`, before establishing the form's authority. An exchange error produces an explicit recovery error; it must not turn the callback's preserved unrelated session into recovery authority. Keep ordinary callback/session preservation unchanged. The existing server adapter retains the verifier after a transient failed exchange, as documented in the discovery; browser direct exchange has different removal behavior.

**Existing admin implicit emails:** consume the old `/login#...&type=recovery` destination as well as any newly selected recovery destination. Capture bounded, unambiguous candidate fields in memory and immediately replace the URL with a clean internal path before client creation/awaits. Do not put credentials in router state, query strings, logs or additional persistent storage. Keep the global factory in PKCE mode.

Validate the candidate token explicitly before overwriting the singleton's existing session. Reject malformed/duplicate fields, provider error fragments, invalid/expired access, wrong issuer/audience/role, mismatched `user.id` and missing/malformed session ID. A valid recent `otp` or `recovery` token can support this legacy compatibility route under the provider's existing authenticated password-change policy. This deliberately accepts a verified bearer session, not the fragment's asserted purpose. Other password/OAuth sessions do not become recovery authority just because somebody adds `type=recovery` to a URL. Any stronger rule that uniquely identifies every existing implicit recovery email needs extra provider/server correlation that the existing fragment does not supply.

For strict access/refresh-pair agreement, use a short-lived nonpersistent client with no auto-refresh to refresh the supplied candidate pair once in isolation. Verify the returned exact token/user and require the original `sub` and `session_id` before installing the returned pair into the existing singleton. This prevents an access-A/refresh-B mixture from being persisted. A failed or ambiguous handoff refresh does not authorize fallback to B or an automatic repeated refresh. Dispose the temporary client without signout, which would revoke the intended session. Recheck the final installed identity; retirement/unmount must fence late handoff completion. The extra refresh is a bounded tradeoff, not proof that SDK `setSession` checks pair agreement itself.

The form should hold a verified expected `{userId, sessionId}` and fixed handoff freshness timestamp; normal refresh with the same identity must not clear user input or extend the original authority window. Root's proposed 15-minute window is an application choice, not a provider guarantee. Its expiration disables password replacement and explains recovery, while retaining the ordinary session. If persistence across a reload requires a server-owned short-lived grant, bind it to these identities and the verified method/time; it must not derive authority from a client flag or become a new long-lived token store. A grant is not required merely to revalidate a signed recent PKCE claim, and adding one cannot invent missing implicit-purpose evidence.

## Pin the password mutation to the checked token

A server action can accept the new password and expected user/session identifiers, read the request's cookie session, validate its **exact token T**, and require fresh `getUser(T)` plus the selected verified method/time policy. It must operate before family onboarding and must not need family context or service-role password mutation.

Send the password update using exactly T. `GoTrueClient.ts:3314–3360` shows that ordinary SDK `updateUser()` loads the session again through `_useSession`, uses that token for PUT, and writes the loaded session back on success. A browser precheck followed by a separate shared-client call can therefore race with another sign-in. Use a request-scoped token-pinned operation: an explicit fixed-provider `PUT /auth/v1/user` with T, or an isolated memory client/transport whose mutation cannot refresh or substitute the previously checked identity. A general global Authorization header is insufficient if the SDK still reads a different stored session and overrides the header. Keep provider payload limited to the validated password, use a deadline and no automatic mutation retries, and verify the returned user matches the expected subject.

For an expired/failed link A while B is signed in: no handoff grant, no password PUT, no installation of a fallback session and no forced signout of B. During a held A mutation, a new B session must neither receive A's password nor be overwritten by a late A response. A confirmed provider success retires that form opening; a lost/thrown response is uncertain and must not trigger automatic repeat. Client locks prevent repeated retained handlers in that opening; they do not prove distributed exactly-once provider execution across tabs or requests.

The provider enforces MFA/current-password/reauthentication settings itself. Preserve those errors instead of bypassing them with the admin API. Current upstream `user.go:98–100,138–170` enforces such constraints. `models/user.go:408–433` updates the password while preserving the current session and revoking other sessions when a current session is supplied. The application should not add signout after success; existing durable-cookie/refresh behavior continues. This is provider-source evidence, not a promise about unknown hosted settings. [Password update policy](https://github.com/supabase/auth/blob/master/internal/api/user.go), [Session preservation on update](https://github.com/supabase/auth/blob/master/internal/models/user.go).

## Executed SDK characterization

The inline probes imported installed `@supabase/supabase-js` / Auth SDK 2.108.2 under `C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0/node.exe`. Tokens and responses were synthetic; the transport explicitly returned fixture users. This tests SDK control flow, not real JWT validity or real recovery issuance.

| Probe | Result |
| --- | --- |
| Seed a verifier ending `/recovery`; return a fixture JWT with `amr=password` from PKCE exchange | `redirectType=recovery`; `PASSWORD_RECOVERY` emitted; one HTTP request. Demonstrates that these SDK signals are not verified purpose. |
| Call `setSession` on a PKCE client with a nonexpired password-session candidate A | Accepted after one `/auth/v1/user` request; returned A. No recovery-purpose check or refresh-pair validation. |
| Call `setSession` with expired access-A and refresh-B; fixture refresh returns B | Returned B after one refresh-token request. Demonstrates why expired/mismatched candidates cannot be installed before identity validation. |

No files were created for the probes, no real token was used, and no provider operation occurred. Authoritative local seams are `node_modules/@supabase/auth-js/src/GoTrueClient.ts:1941,2372,3314,3509,6274` and `lib/supabase/client.ts:27–47`.

## Required focused regressions for implementation

Use actual production recovery helpers/components and installed browser/SSR clients with fully intercepted provider traffic. Retain separate signature-verification fixtures using synthetic locally signed JWTs and a fixture JWKS; a permissive mocked `/user` alone is not a cryptographic verification test.

- PKCE recovery code succeeds only with correct verifier and verified returned purpose; edited verifier suffix/URL labels cannot authorize password/OAuth JWTs. Test 503 then fresh SSR request retry without changing global callback retention.
- Old admin `/login` implicit link with provider-compatible `otp` AMR succeeds; ordinary password token plus recovery label is rejected; missing/invalid candidate preserves B and sends no password update. Include duplicate parameters and error fragments with otherwise valid B cookies.
- Wrong access/refresh pairs, expired A plus refresh-B, held verification followed by B sign-in, and handoff completion after unmount never install or mutate the wrong identity.
- Capture T at the server boundary, switch stored session during required reads, and assert the password PUT uses T or is refused; never B. Also test returned/thrown provider failure and an accepted-but-lost response without automatic retry.
- Confirmed success keeps the same durable session through refresh/restart and retires retained form handlers; explicit signout still clears it. Authority-window expiry disables this form without signing the user out.
- Provider MFA/current-password/reauthentication refusals remain visible and do not fall back to service-role mutation. SMTP/link templates, real single-use verification, actual mail receipt and hosted password policies remain external checks.

The existing token-hash API can verify a supplied recovery hash at the provider, but default already-sent implicit emails return tokens after provider verification, not that unused hash. Adding a token-hash route alone does not fix those emails and is not required for the proposed legacy adapter. No new SMTP/template infrastructure or SQL is needed for the bounded application repair.
