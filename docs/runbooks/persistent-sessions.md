# Persistent sessions

Users should remain signed in across navigation, browser/app restarts, and temporary network or storage failures. Explicit local sign-out, a revoked refresh token, or another definitive authentication rejection must still end that session. An outage must not grant access to protected data or be represented as a signed-out account.

## Application behavior

- Browser and server clients use the same persistent cookie scope and automatic token refresh. Session cookies retain the existing 400-day browser maximum; access-token expiry is not extended.
- The shared fetch boundary classifies HTTP 408, 429 and 5xx responses as retryable only for a POST to the configured project's refresh-token endpoint. This happens before the installed SDK can remove saved credentials. Password grants, logout, other hosts and definitive token rejections retain their original responses.
- Middleware preserves refreshed cookies on both the current server request and browser response, including the SDK's cache-prevention headers on redirects. Required account reads fail as unavailable during a temporary auth failure.
- The authenticated web layout reconciles its rendered identity with a successful stored-session read after foreground, online and native-resume events. Failed or stale reads cannot override newer auth events.
- Mobile secure storage writes a new chunk generation before committing its header. Reads support legacy sessions. Interrupted writes retain the previously committed session; cleanup failures do not invalidate a successful write. Explicit sign-out removes the readable header first. Storage failures carry a retryable error instead of becoming an absent session.
- Mobile retries unavailable bootstrap reads every 30 seconds and on foreground, including when the saved access token has not expired. Newer auth events and disposal take precedence over a pending read.

## Verification and limits

The root runtime suites cover the installed AuthClient and browser/server SDKs with synthetic sessions and controlled transport failures, plus actual middleware and component lifecycle callbacks. Secure-storage tests cover interruption before and after the header commit, legacy migration, Unicode byte bounds, cleanup failure, concurrent refresh/read/sign-out and recovery after storage unlock. These are controlled tests, not a production Supabase or real-device session test.

Production session configuration has not been inspected: this workspace has no Supabase management credentials or linked project. Before release, verify that the project's session timebox, inactivity timeout and single-session restriction match the indefinite-session requirement. Supabase defaults to indefinite sessions, but hosted overrides can terminate them on refresh. See [Supabase session configuration](https://supabase.com/docs/guides/auth/sessions).

The native SDK's implicit initial subscription previously produced an unhandled rejection if the Keychain read itself rejected. A tracked install-time correction now moves its existing initial-session error handler around that read. Both shipped runtime formats are tested with real SupabaseClient instances under strict unhandled-rejection handling; explicit getSession errors remain visible and credentials survive recovery. The patch verifies the exact locked SDK version and file hashes, fails on unknown contents, and runs through mobile installation and CI. SDK upgrades require an explicit review of this correction; see [patch maintenance and tests](../../mobile/scripts/auth-storage-errors.md). Physical-device cold-start acceptance remains outstanding.

For real browser/GoTrue coverage, run `tests/e2e/durable-session.spec.ts` with `E2E_DURABLE_SESSION=1`, an isolated local Supabase, and dedicated `E2E_AUTH_EMAIL` / `E2E_AUTH_PASSWORD` credentials. It exercises browser-context restart, token expiry, parallel refresh and explicit sign-out. No real session credentials should appear in logs or test fixtures.
