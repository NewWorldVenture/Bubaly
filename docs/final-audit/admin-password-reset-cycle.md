# AUTH-003 admin password-reset outcome boundary

## Recorded before production edits — 2026-09-12

Initial scope: only `adminSendPasswordResetAction` in `app/(app)/admin/actions.ts`, `components/admin/user-security-actions.tsx`, new focused action/browser tests, and this report. The master AUTH-003 record preceded this lane. Root subsequently assigned the exact recovery branch in `app/auth/callback/route.ts` and its executing tests. Root owns the recovery page/actions and seven locale catalogues; the sibling owns the server recovery verifier. No live emails, accounts, database, schema or navigation changes are authorized in this lane.

Actual action + installed Supabase Auth/PostgREST reproduction: a synthetic HTTP 200 from `/auth/v1/recover` is followed by a rejected audit actor lookup. The action rejects with `Synthetic actor read outage` despite one accepted provider request. The baseline shared `logAudit` also ignores returned database errors and catches thrown ones, so awaiting it cannot establish a recorded audit receipt.

Actual Chromium/React control reproduction: two calls to the same retained submit handler before a render dispatch two reset requests; a rejected action leaves both reset and ban controls disabled; a held request remains busy after 15 seconds; a retained callback still dispatches after unmount; and a prior target's completion displays a success toast after target props change. These are executing failures, not source-text assertions.

Before source changes, the new action contract suite reports 24 failures. Many are expected missing additive-result fields; the primary accepted-provider/audit-read case is an actual thrown-after-acceptance failure. The browser suite reports eight failures and one pass; the missing-recipient control already passes. Some proposed outcome/translation checks fail because their new contract/locale keys do not yet exist, so those are not counted as additional preexisting defects. No provider was contacted.

An implementation review added an executing target A → B → A case: a pending A request must remain locked when A returns. Clearing all local outcome state on each target change reopened that request. This was reproduced before strengthening the control to retain per-target accepted/uncertain decisions for its mounted lifetime; late callback identity fencing alone is insufficient.

Baseline evidence lives outside the repository in `C:/Users/Daniel/AppData/Local/Temp/bubaly-admin-reset-red-20260912.json` and `C:/Users/Daniel/AppData/Local/Temp/bubaly-admin-reset-red-browser-20260912`.

## Agreed repair contract

- Confirmed request acceptance returns `ok: true`, `outcome: 'accepted'`, and `audit: 'recorded' | 'unconfirmed'`; an unconfirmed audit carries a safe translated warning. Acceptance is not inbox delivery or proof that an email address belongs to an account.
- Pre-dispatch failures and definitive non-408 4xx rejection return `ok: false`, `outcome: 'failed'`, with an error. Transport failure, 408/5xx or an unusable response after dispatch returns `outcome: 'uncertain'` and forbids a blind resend.
- A direct checked audit insert is confined to this action; shared best-effort logging behavior remains outside scope. The action retains its superadmin guard and recipient validation. After root established the recovery page contract, the requested redirect changed to `/auth/recovery`.
- The actual control uses a synchronous attempt guard, contains rejection, ends visible busy state, and holds accepted/uncertain requests across menu close/reopen. Retired target/unmounted callbacks cannot dispatch or surface stale completion. A UI waiting deadline ends in uncertainty; it does not claim to cancel an already dispatched server action.

The coordinated recovery callback addition was recorded in the master before this extension. Before editing that route, its executing handler suite reports 18 failures and two passing ordinary-callback controls: explicit recovery destinations used the generic session-routing path, produced no verified grant/cookie, and failed or missing recovery codes could use an ambient signed-in account. The fixture combines the actual callback with the actual recovery-grant helper and installed SDK verification against synthetic signed JWT/JWKS responses; only the exchange factory/session response is controlled. Evidence: `C:/Users/Daniel/AppData/Local/Temp/bubaly-recovery-callback-red-20260912.json`.

## Implementation and focused verification — frozen

The action confirms exactly one valid audit UUID receipt through the installed PostgREST SDK, with a five-second request abort. Accepted provider requests survive missing actor, thrown/returned audit failure, malformed receipt and audit timeout as accepted with an unconfirmed-audit warning. Reset rejection is contained. The control prevents synchronous duplicate invocation, ignores retired target/unmounted callbacks, retains accepted/uncertain decisions for each target during its mounted lifetime, and releases unrelated controls after its 15-second waiting deadline. It does not reinterpret a late response as permission to resend.

The exact `next=/auth/recovery` callback branch validates only the access token returned by the explicit exchange, then uses the shared verifier to issue a grant. A `bubaly-recovery-handoff` cookie is HttpOnly, SameSite=Lax, scoped to `/auth`, Secure in production, and expires after at most five minutes or the grant's shorter remaining lifetime. The redirect carries only its SHA256 hash; responses use `no-store` and `no-referrer`. Missing/conflicting code, explicit provider error, exchange exception, invalid signed claims, tampered signature, expiry and verification outage clear the handoff and return `/auth/recovery?error=invalid`. Ordinary callback routing remains covered by the existing executing suites.

- Eight focused unit files: **103 PASS**, including 25 actual admin action/installed SDK cases and 23 actual callback/helper/installed verification SDK cases.
- Actual React/Chromium control: **12 PASS**, including French copy, held and lost responses, duplicate invocation, A → B → A, unmount, corrected retry and unchanged normal ban behavior.
- ESLint over the six owned code/test paths: **PASS**. Scoped strict TypeScript check includes those paths and their imported dependencies; this is not the root full-repository gate.
- No live Auth-server request, email, account, provider or database operation occurred. Root owns full build, full units and integrated recovery browser verification.

Limits: acceptance proves a successful reset request response, not email delivery or account existence. Local outcome retention does not deduplicate independent tabs, reloads or server requests. The Auth SDK reset request and later audit actor `getUser()` are not cancellable/bounded by this action; the control's deadline moves to review and does not claim cancellation. A checked audit failure may have committed remotely, and no automatic duplicate audit or reset is attempted. The ordinary callback's legacy exchange transport behavior is unchanged. The callback fixture controls the PKCE exchange response; the cryptographic grant verification and synthetic provider reads execute real helper/SDK code. Provider URL allowlists, email templates, deployment cookies and real PKCE delivery still require deployment verification.

## Executing harnesses

`tests/admin-password-reset-execution.test.ts` loads the actual server action and installed Supabase SDK against synthetic auth/audit HTTP transport. Guard identity and translation are controlled seams. `tests/e2e/admin-password-reset-control.spec.ts` mounts the actual component with real React in Chromium and controlled server-action results; all browser requests are intercepted. These two layers do not prove deployed email delivery, real Auth-server acceptance semantics, real database policies, or durable deduplication across independent requests/reloads.

```powershell
$env:PATH = 'C:/Users/Daniel/AppData/Local/Temp/bubaly-node24-perf002-20260912-v24.21.0;' + $env:PATH
node node_modules/vitest/vitest.mjs run tests/admin-password-reset-execution.test.ts --reporter=json --outputFile=C:/Users/Daniel/AppData/Local/Temp/bubaly-admin-reset-red-20260912.json --maxWorkers=1
$env:PLAYWRIGHT_EXTERNAL_SERVER = '1'
node node_modules/@playwright/test/cli.js test tests/e2e/admin-password-reset-control.spec.ts --project=chromium --workers=1 --reporter=line --output=C:/Users/Daniel/AppData/Local/Temp/bubaly-admin-reset-browser-20260912
```
