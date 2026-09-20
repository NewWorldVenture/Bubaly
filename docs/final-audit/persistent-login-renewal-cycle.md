# Persistent login renewal — 2026-09-12

The user explicitly prioritized staying signed in through refresh, navigation, browser restart and app reopening until they choose to sign out. AUTH-002 remains in progress because production Supabase policy and physical mobile storage behavior have not been inspected.

## Reproduction and repair

On source `a02e82fb`, an expired stored session followed by an HTTP 200 refresh response containing `{}` or an empty refresh token causes the installed SDK to emit `AuthSessionMissingError` and delete its stored session. Six execution cases reproduce this across the browser cookie adapter, request-scoped server adapter and native-style asynchronous storage. The transport is synthetic; the SDK and storage adapters execute normally. The failing log is `C:/Users/Daniel/AppData/Local/Temp/bubaly-persistent-login-malformed-before-20260912.log`.

The shared refresh transport now inspects successful refresh responses before the SDK processes them. An incomplete token pair or unusable expiry becomes a sanitized retryable 503. Valid response bytes and headers remain unchanged. This applies only to POST refresh-token requests at the configured auth endpoint. Definitive rejection responses, explicit sign-out, password sign-in and unrelated requests retain their existing behavior. No token is restored after sign-out and no failed response grants an identity or protected access. Browser, middleware, server and Expo already use this shared transport.

AbortError and TimeoutError fetch rejections were also investigated. The installed SDK already classifies them as retryable; additional execution cases confirm saved bytes survive and a later refresh succeeds. They required no production change.

The prior password-recovery commit intentionally constructs an isolated installer with automatic refresh disabled, empty ambient storage during bootstrap and guarded explicit writes. Its lifecycle is covered by real SDK browser tests. The older static singleton test now recognizes this existing exception while continuing to reject additional ordinary browser clients.

## Focused verification

- Six auth/session unit suites: **179 tests pass**. This includes the previously failing incomplete-response cases, exact storage retention, successful later rotation, cancellation/timeouts, middleware cookie preservation, definitive rejection, explicit sign-out and native storage/sign-out races.
- Five controlled Chromium suites: **82 tests pass**. They cover session cookies, auth lifecycle, password recovery, signup and admin reset controls. The new browser case opens an expired saved session, returns incomplete renewal data, verifies the exact cookie survives, reopens successfully after provider recovery, and explicitly signs out.
- A new persistent Chromium profile test closes and relaunches the actual browser process, verifies the signed-in identity returns without another token request, then signs out and relaunches again to verify the signed-out state. Only synthetic credentials are used in the test-owned profile. This proves browser-process restart on this host, not OS restart or physical iOS/Android behavior.
- Whitespace check passes. Combined verification of the committed source is recorded below.

Logs use `C:/Users/Daniel/AppData/Local/Temp/bubaly-persistent-login-*-20260912.log`. No live accounts, SQL, installs, provider writes or global navigation changes were used.

## Deployment dependency

Supabase controls session lifetime separately from access-token expiry. Its documented defaults allow indefinite sessions and multiple devices. For the requested behavior, the production project's Authentication session configuration must have no time-box or inactivity timeout and single-session enforcement must be disabled. Refresh rotation and revocation controls remain enabled; extending the JWT lifetime is not the persistence mechanism. [Supabase session configuration](https://supabase.com/docs/guides/auth/sessions).

This session has no Supabase management connection or management token available in the project environment. The existing Vercel token was previously established to belong to other projects; it does not establish access to Bubaly's auth settings. The current production settings have therefore not been asserted or changed. Deployed policy, real provider rotation/revocation, host configuration and physical mobile reopen behavior remain separate verification work.

The previous SMS checkpoint's hosted workflow `34705687249` completed successfully for quality/build, database, mobile and E2E, finance workflow `34705687247` passed, and its Vercel preview succeeded. Those checks concern published source `8b09f1ad`, not this local auth repair or preceding local recovery commit.

## Combined source checkpoint

Exact source `bc22dbc9ca7bb16535dbb7d2df788cf0eb3e1bcf` includes both the preceding recovery/signup commit and the renewal repair. Its Git archive was expanded into the existing private clean installation without changing dependencies. The package SHA256 remains `B250169455D554EB0CF2603F0E158ED3D33D22327B630319E7DAB3A034A10764`; lockfile SHA256 remains `58EB5FA3A0EA179B52B37CA5B457778A330A38FBFFE859EB8CA767941EAA4569`.

| Check | Result |
| --- | --- |
| Full Vitest suite | **1,162 files / 13,537 tests pass**, 122.55 seconds |
| Production build | **Pass**, 247 generated pages; 103 kB shared JS; 92.6 kB middleware; compile 56 seconds |
| Strict types after build | **Pass**, no incremental cache |
| Full lint | **Pass**, four existing warnings |
| Localization and static query gates | **Pass**; 484 tables, 77 functions, 139 API routes resolve |
| Five focused Chromium suites in the private install | **82 pass**, 13.3 seconds |
| Build provenance | Compiled `/api/build-info` artifact contains the exact source revision |

Private logs are `C:/Users/Daniel/AppData/Local/Temp/bubaly-persistent-login-private-*-20260912.log`. The archive SHA256 is `95720E4E7C8B7ABF871F7EABAB90AAED6647765DEB4454021D6C24762406F621`. The build uses reserved invalid provider configuration and synthetic keys. Expected unavailable-data fallback logs and the SDK Edge-runtime warning do not establish live service behavior.

Automatic approval review rejected starting a local production preview on port 3187, returning only `blocked by policy`. No preview process was started and no alternative launch was attempted. The local application-startup/browser journey is therefore unverified for this checkpoint. Existing controlled-browser evidence is distinct from that blocked startup action. Hosted checks for the newly published checkpoint must be recorded separately after they finish.

The frozen `discovery/auth-session-inventory.json` covers 29 changed non-audit files between the prior SMS source and this auth source: 11 production files, 11 test files and seven locale files, including 11 new files and 10 added exported functions. It adds the `/auth/recovery` page and related support/function records to the master without renumbering existing IDs. All 13,517 prior entries, values and ordering remain intact in each of the seven locale catalogs; 39 entries were appended. Discovery and passing module checks do not close the full authentication workflows or the whole-application audit. **PRODUCTION READY: NO.**
