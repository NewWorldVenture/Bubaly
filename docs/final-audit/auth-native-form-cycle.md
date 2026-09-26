# Native authentication form submission

2026-09-19. **SEC-005 is FIXED + PASS; AUTH-002 remains IN PROGRESS.** This cycle follows a
hosted sign-in navigation whose path included `/login?email=...` before a correct
retry. The remaining query was masked; this observation alone does not prove
which other fields were transmitted. Controlled actual SSR/browser reproduction
separately confirms default native GET serialized synthetic credential fields
into the URL. No real credential values belong in this record.

The source inventory covers all six forms in `components/auth`: five credential
forms and the sign-out form. These are initial-render facts, not six reproduced
exposures. The shared Input forwards native attributes; Button only disables for
an explicit disabled prop or loading state. Neither supplies hydration readiness
or a form method.

| Form at discovery | Native method/action | Initial-render readiness and implication |
| --- | --- | --- |
| `login-form.tsx:168` | Neither supplied; native default GET to current URL | Named email/password inputs and submit are enabled because loading starts false. The mounted ref protects the React handler only. This was reproduced in actual SSR/browser execution. |
| `signup-form.tsx:222` | Neither supplied | Email form is absent initially because showEmail starts false. It appears only after a handled UI choice. No equivalent initial-render leak has been established. |
| `recovery-form.tsx:306` request | Neither supplied | Initial phase is checking, so the named email form is absent until client initialization. |
| `recovery-form.tsx:313` password save | Neither supplied | Password/confirmation form is absent initially and requires verified recovery initialization to reach ready. |
| `kid-login-form.tsx:87` | Neither supplied | Username/PIN controls and submit render disabled while ready is false; the layout effect enables them. Existing readiness must be preserved. |
| `sign-out-form.tsx:70` | Explicit POST to `/auth/signout` | Existing native compatibility path; no password/PIN/email controls. No change proposed. |

OAuth uses an explicit button, while PhoneAuth and StepUpForm have no credential
form owner in their authentication layouts. Their SDK/lifecycle boundaries remain
separate obligations. The login page's Suspense boundary does not itself add a
native form method or disable controls in delivered login markup.

LoginForm now initializes readiness to false, enables it in the layout effect,
disables the fieldset until readiness and declares POST. SignupForm,
RecoveryForm's two forms and KidLoginForm receive only explicit POST additions,
preserving their existing conditional rendering/readiness and handlers.
A mounted ref cannot prevent a native submission
before React handles it. POST is a defensive native transport choice; it does not
implement a working password sign-in without hydration or prove the authenticated
workflow. Existing sessions and session ownership guards must remain unchanged.

Executed evidence (all logs under `C:/Users/Daniel/AppData/Local/Temp/`):

- `bubaly-login-readiness-red-20260919.log`: **two desired RED and one control
  PASS**. Actual React SSR and Chromium show enabled initial controls; synthetic
  DOM population plus native `requestSubmit()` serializes credential fields via
  GET. Post-hydration rejection/retry already works.
- `bubaly-login-readiness-green-20260919.log`: **34/34 PASS** in 4.0 seconds:
  three new readiness/native/retry cases and 31 existing password-login boundary
  cases. The new fixture executes the actual LoginForm, Input and Button with
  delayed hydration; its auth transport and surrounding UI seams are synthetic.
  The separate password-boundary fixture uses the installed SDK. These are not
  live-provider sign-ins.
- `bubaly-native-form-adjacent-20260919.log`: **96/96 PASS** in 12.4 seconds across
  signup boundaries, recovery UI and child readiness after the adjacent POST
  additions. Login fixture scoped strict types and lint also pass in
  `bubaly-login-readiness-{types,lint}-20260919.log`.
- `bubaly-native-form-unit-20260919.log`: **122/122 PASS across six suites**;
  `bubaly-native-form-lint-20260919.log`: all six shipping app/test files pass
  scoped lint. The two selected browser runs contain 130 distinct cases.
- `bubaly-native-form-build-20260919.log`: production build passes, 252 pages.
  Independent review of the focused source finds no blockers; hosted timing and
  successful-login acceptance remain separate.
- `bubaly-native-form-types-20260919.log`: full strict TypeScript exits zero.
  All six shipping files independently match the tested private copy's hashes.

The existing callback HTTP fixture also receives a test-only response-capture
repair after navigation made the old response body unavailable. Its provider,
server-action and session assertions remain; exact-source hosted acceptance now passes.
Unfinished initiation design/OAuth regressions are excluded from this patch.
Six shipping source/test files are frozen at
`1536752b12c9c87e4dfd63a748228810e33879b6`: four component files, the existing
callback HTTP fixture and the new readiness fixture. Their exact Git-blob hashes
and unchanged export/route inventory are in
[the compact inventory](discovery/auth-native-form-inventory.json).
Exact deployed native-form acceptance and new hosted successful-login
acceptance now pass on 70789485. This cycle ran the focused
122-unit compatibility gate; the earlier full-suite proof remains historical.

The master gains SEC-005 for the specific credential-URL obligation and one new
SUPPORT record for `tests/e2e/login-readiness.spec.ts`: 14,020 total, with all prior
14,018 IDs/statuses preserved. Existing SEC-001 remains the separate Critical FAIL
for private family media; broad SEC-002 is also unchanged. No complete workflow
PASS is claimed.

SEC-005 closes after exact deployed native-submission checks and the new hosted
run prove normal hydrated successful login/navigation on the repaired source.
That narrow closure does not complete AUTH-002 or initiation ownership. SUPPORT-6C0575881A8C is the new
test-file obligation and remains NOT STARTED.

## Exact production acceptance

Main `70789485cd5e8ad00d49c2834e5c2aebf6941679` is live on deployment
`dpl_4e2X1mo4taDXyYNnd38F36DP7M4r`, successful at 20:20:47 UTC; GitHub Production
record `6545293519`. Its immutable address is
[the verified deployment](https://bubaly-gqgndu7rm-newworldventure.vercel.app).

`Temp/bubaly-native-form-production-70789485.log` verifies the exact deployment
identifier in three HTML responses. With JavaScript disabled, login email,
password and submit are disabled and the form declares POST. An intercepted
native submission is POST with no credential fields in its query or body. With
JavaScript enabled, all three controls become ready. Zero page errors occurred;
the interceptor prevented the actual POST and no provider operation ran.

`Temp/bubaly-production-render-70789485.{json,log}` separately verifies login,
signup, reset and denied callback render correctly: four checks pass, zero Server
Action posts and zero page errors. Six `ERR_ABORTED` script/prefetch requests
occurred during navigation; they do not establish an application exception.

Earlier exact `a70d27c4` CI `35466125080` completed all four jobs successfully;
E2E passed 1,183/1,183 with zero failures/skips, including all four HTTP callback
cases and the genuine emailed recovery journey. It predates this native-form
repair and later response-capture fixture change.

Exact `70789485cd5e8ad00d49c2834e5c2aebf6941679` CI `35466913827` now completes
all four jobs successfully. E2E job `105960830821` passes **1,186/1,186** in 8.1
minutes with zero failures, flakes or skips. Authenticated and durable-session
flags are enabled. The exact source/discovery contains the three new readiness
cases and four actual HTTP callback cases, including genuine emailed recovery,
password save, logout and successful new-password sign-in. The github/dot reporter
does not print individual successful names; this coverage follows from the
complete scheduled matrix passing without skips. Log:
`Temp/bubaly-707-e2e-105960830821.log`.

Web job `105960830743` passes both UTC/DST runs of 16,543 checks across 1,303
files, the 252-page build, lint and strict types. Log:
`Temp/bubaly-707-web-105960830743.log`. Database and Mobile also pass.
**Only SEC-005 becomes FIXED + PASS.** All 14,020 IDs remain; every other status
is unchanged. This is disposable hosted successful-login proof alongside exact
production native-form checks, not production email/provider delivery or full
authentication workflow completion.
