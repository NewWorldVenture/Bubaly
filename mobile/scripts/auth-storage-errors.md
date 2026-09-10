The native SDK patch keeps a locked or unavailable Keychain from causing an
unhandled promise rejection during SupabaseClient's initial auth subscription.
It moves the existing `_emitInitialSession` error handler around the awaited
storage read. That handler still emits `INITIAL_SESSION` with a null session and
reports its diagnostic. Explicit `auth.getSession()` calls still reject, allowing
the app to retain its restoring state. No saved session is cleared by this patch.

The patch covers the CommonJS and ES module builds of `@supabase/auth-js@2.115.0`.
Their original SHA-256 hashes were checked against the official npm tarball.
The installer verifies both installed SDK package versions, the lockfile,
runtime entry points and complete before/after file hashes before writing.
Unknown versions or contents fail installation. Already-patched files are
accepted so an interrupted application can be completed safely.

`npm ci` applies the patch through `postinstall`. `npm run typecheck` first checks
the patch and runs the regression suite, so the existing mobile CI job covers
both runtime formats. `npm run start`, `android` and `ios` also verify it. Running
with npm install scripts disabled requires explicitly applying the patch before
building. Linked dependency directories are rejected; use an owned install.

Run `npm run test:auth-storage` to exercise private copies of the real installed
SDK. The unpatched control must reproduce the original rejection; patched child
processes run with strict unhandled-rejection handling and must recover after
storage unlock while preserving explicit sign-out. No global rejection handler
or SDK runtime override is used. The test-only ESM loader selects the same module
entry a bundler may use, without changing its source.

Maintenance: a dependency update must explicitly re-evaluate this patch. The
[2.116.0 release](https://github.com/supabase/supabase-js/releases/tag/v2.116.0)
and its [auth source](https://github.com/supabase/supabase-js/blob/v2.116.0/packages/core/auth-js/src/GoTrueClient.ts)
still leave the storage read outside the handler. Remove this patch only when an
official release passes the locked-storage regression without it. The installed
source maps remain upstream originals; locations inside this small changed
method can differ from the map.
