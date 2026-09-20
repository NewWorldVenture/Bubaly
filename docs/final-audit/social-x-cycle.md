# SOCIAL-001 — X connection and manual text/link publishing

Date: 2026-09-12. Repository implementation and synthetic execution verified; live provider authorization/publication remains unverified. The master record was IN PROGRESS before source edits. No provider credentials, codes, token values, or live responses are included here.

## Reproduced boundary

The baseline `lib/social/connectors.ts` registry was empty. Configured app credentials therefore still produced `not_implemented`, while `connectAccountAction` only inserted pending account intent. There was no X OAuth callback or private social-token reader/writer. App credentials could not authorize publishing as a family member's X account.

## Implementation

- The existing X connect control now redirects to the fixed X authorization endpoint. The server action creates a pending account and a service-only authorization receipt before returning a redirect URL. Other platforms retain their existing unavailable behavior.
- OAuth uses PKCE S256 and an encrypted, HttpOnly, SameSite=Lax cookie restricted to the callback path. State binds the current user, active family, pending account, nonce, verifier, exact canonical callback URI, and ten-minute deadline. Callback receipt acquisition is conditional and precedes token exchange; concurrent or replayed callbacks cannot both exchange.
- The callback checks current account/family/permission, required granted scopes, bearer token type and expiry, and provider identity from the authenticated users/me endpoint. A fresh permission check and flow deadline check precede final connected state. Revocation/disconnect during the exchange prevents finalization. Failure renders an escaped translated HTML page with a fixed accounts recovery link; no callback values or provider diagnostics are reflected.
- Existing `SYNC_TOKEN_KEY` AES-256-GCM encrypts access and refresh tokens separately. New X connections require the documented 32-byte hex/base64 key. The legacy sync helper is unchanged. Each ciphertext envelope includes its purpose, account, family, platform, provider identity, scope and expiry; copying ciphertext to a different account cannot authorize a send.
- `social_account_tokens.account_id` is not unique. New private rows use the existing primary key canonically (`id = account.id`). Reads request exact counts and reject duplicates, noncanonical rows, missing counts, incomplete count/data agreement and mismatched bindings, including under a synthetic API cap of one row. Reconnecting an existing provider identity claims its canonical private row before replacement and reuses the account identity.
- Disconnect clears private token authority before the public account update. Private revocation time prevents an older OAuth attempt from undoing revocation when the public write fails. New explicit authorization after disconnect is allowed. Failed intermediate writes leave credentials unavailable; no unchecked write reports connected.
- The X publisher requires family/account/actor/kind context and rechecks current family permissions and private credentials. It accepts text/link kinds without attachments. Only the per-account access token reaches `POST https://api.x.com/2/tweets`; app client credentials are confined to OAuth exchange. Responses retain only validated provider post ID and constructed permalink.
- Provider calls use fixed HTTPS endpoints, disable redirects, carry a 15-second deadline through body consumption, and bound JSON to 64 KiB. Unused/oversized response streams are cancelled. Confirmed HTTP 201 plus a valid post ID yields published. Confirmed 4xx yields failed. Timeouts, transport errors, redirects, 5xx and malformed/ambiguous success yield `publishing / confirmation_unknown`, without retry. Root's separate SOCIAL-002 pipeline preserves this uncertainty and owns claim/receipt/rollup behavior.
- Ten new X messages are translated in seven base locales by root. The callback recovery label reuses `dashboardSocialAccountsConnect.backToAccounts`.

## Execution evidence

`tests/social-x-execution.test.ts` executes actual production actions, OAuth callback, access resolver, crypto, token storage, registry, X provider, and publish pipeline against the stateful in-memory Supabase fixture and synthetic fetch responses. Its 80 cases cover:

- PKCE, encrypted cookie flags and binding, replay, concurrent callbacks, state tampering, expiry before/during exchange, wrong origin/user/family, revoked membership/permission and required-read failures.
- Missing/weak configuration, loopback-only HTTP configuration, insufficient scope, wrong identity, redirects, network failures, oversized payloads, checked receipt/account/token writes, canonical reconnect and stale authorization after private revocation.
- Encrypted envelope transplant, duplicate rows hidden by API cap, missing exact counts, disconnected/expired/refreshing credentials, invalid kinds/media/link/content and unsupported provider honesty.
- Confirmed rejection versus uncertain acceptance, bounded stream cancellation and abort during response-body consumption, plus safe HTML recovery without reflected OAuth values.
- Full connection → actual create-post action → actual SOCIAL-002 pipeline → actual X connector → persisted receipt/target/post → retry for both confirmed and uncertain results, proving a single provider dispatch and retained post identity.

Commands:

```powershell
node node_modules/vitest/vitest.mjs run tests/social-x-execution.test.ts tests/social-action-persistence.test.ts tests/social-publish-persistence.test.ts tests/social-capabilities.test.ts tests/social-access-execution.test.ts
```

Result: **5 files / 133 tests PASS**. Scoped Next lint for the nine owned source/test files: **PASS**, no warnings/errors. `git diff --check`: **PASS**. Root owns combined typecheck, full tests, build and publication. No full suite or build was run in this lane.

Related regression command additionally included `social-publish-execution`, `social-content`, `social-roles`, `social-feed`, `social-feed-fetch-security` and `social-unfurl`: **11 files / 220 tests PASS**.

Independent ops review reproduced the private-revocation/public-write race before the fence and verified the repaired real-module behavior; see `social-security-review.md`. Root and ops also independently reviewed permission and pipeline boundaries.

## Operational limits and follow-up

- Live proof still needs configured X confidential-client credentials, an approved exact callback URI at the existing `NEXT_PUBLIC_APP_URL` origin, a valid encryption key, service database access and an authorized X account. No live OAuth exchange, provider publish or SQL/schema change occurred. Synthetic database tests do not prove deployed grants, RLS or provider entitlement/configuration.
- Automatic refresh is deliberately absent. Access tokens expire; the sender then requires reconnect and never silently rotates or reuses uncertain refresh tokens. Refresh ciphertext is stored for a separately audited implementation. This is not a claim of persistent background connectivity.
- If callback persistence is interrupted, a pending account/private lease can remain. Disconnect and begin a new authorization to recover; abandoned authorization rows have no new cleanup job in this scope. Provider-issued tokens from an interrupted callback may be orphaned; no provider revocation request was sent.
- Family authorization and provider writes are separate systems. Revocation after the last successful authority read cannot retract an already in-flight provider request. An uncertain post requires review on X before another post is created. No exactly-once provider guarantee is claimed.
- Existing local X character estimation is used; provider validation remains authoritative for weighted Unicode and platform-specific content rules. Media, threads, polls, other platforms, scheduled dispatch, feeds and analytics are not implemented or verified by this change. Existing SQL permission restrictions, including the separately recorded AUTHZ-003 issue, are outside this no-SQL lane.

Primary contracts checked: [X OAuth authorization code/PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code) and [X create posts](https://docs.x.com/x-api/posts/create-post). These support endpoint, confidential-client, scope and response contracts; they are not evidence of this deployment's live provider access.
