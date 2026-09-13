# Signup browser boundary cycle

2026-09-12. Root recorded the 14-case characterization and nine failing desired cases in `AUTH-001` before authorizing the bounded form repair. This is not a passing complete signup workflow or an explanation of a previous hosted CI failure.

Permanent inventory references: signup route `UI-ROUTE-0354`; `SignupForm` component `COMPONENT-FF9788DC39FD`; submit form `CONTROL-6A16625C3448`; submit button `CONTROL-0B2F397BA1FE`. These IDs retain their historical discovery identities even when source lines move.

## Executed boundary

`tests/e2e/signup-boundaries.spec.ts` executes the actual `SignupForm`, shared inputs/button, legal consent, validation with installed Zod, redirect/plan/referral helpers, real LocaleProvider and ToastProvider, production `lib/supabase/client.ts`, installed `@supabase/ssr` cookie adapter, and installed Supabase auth SDK in Chromium. Synthetic HTTP responses terminate at intercepted `.invalid` origins. Navigation and the two server actions are explicit controlled boundaries. OAuth and phone children are isolated; their provider workflows are outside this test.

The SDK writes actual browser cookies. PKCE assertions decode the SDK storage JSON and independently hash the verifier using SHA-256 against the outgoing signup challenge. Submitted data and session identities are synthetic. No real account, email delivery, live database, SMTP, or deployed provider was used.

Existing adjacent evidence includes `tests/auth-review-selection-forms.test.ts`, `tests/billing-review-selection.test.ts`, `tests/referral-signup-capture.test.ts`, and `tests/e2e/browser-session-storage.spec.ts`. These did not previously execute these SignupForm lifetime and uncertainty cases.

## Before-repair evidence

The corrected 12-case run produced **4 control passes and 8 desired-behavior failures** in 3.5 seconds. Two additional cases produced **1 control pass and 1 desired-behavior failure** in 1.5 seconds. Total: **14 cases, 5 passing controls, 9 failing regressions**. These are ordinary desired assertions left red, not expected-failure annotations.

| Desired protection | Observed execution before repair |
|---|---|
| One signup per synchronous submit intent | Calling the actual retained React submit handler twice sends two signup POSTs. Their challenges differ; stored PKCE verifier matches the second request, not the first. |
| Retire a completed submit | Invoking its retained handler after the check-email screen sends another POST. |
| Retire an unmounted opening | A callback captured before unmount sends a POST after a new form mounts. |
| Suppress stale successful completion | Release an accepted session response after unmount: old form invokes identity stitching, pushes `/onboarding`, and refreshes. The SDK has already persisted the returned session; a UI lifetime guard cannot undo that accepted auth operation. |
| Suppress stale failed completion | Release a definitive rejection after unmount: its toast appears on the next route. The assertion checks immediately after the committed response, before automatic toast dismissal. |
| Preserve uncertain signup recovery | Model provider acceptance followed by a 502 response: SDK removes the verifier that matched the sent challenge; the retained submit can send another signup POST. No check-email success is shown, but a deliberate recovery boundary is missing. |
| Require a meaningful signup receipt | An HTTP 200 empty object is interpreted as no-session success and renders “Check your email” without a returned user. |
| Contain best-effort identity attribution | A rejected `stitchIdentityAction` becomes an unhandled browser rejection after confirmed signup. |
| Contain best-effort referral capture | A rejected `rememberReferralCodeAction` becomes an unhandled browser rejection when a valid referral is observed. |

The two requests above do not prove two deployed accounts or two delivered messages: uniqueness, anti-enumeration, throttling, SMTP, and callback exchange are separate provider boundaries. They do prove duplicated browser requests and loss or replacement of the local PKCE half-transaction under controlled responses.

Passing controls cover normalized email/name and referral metadata, remembered referral, selected-plan continuation, safe invite precedence, real PKCE challenge storage, disabled submit while a response is held, confirmation-required versus auto-confirmed presentation, persisted confirmed session, validation without a request, a definitive rejection preserving input for deliberate retry, existing-session preservation on a confirmation-required response, and French confirmation copy under the real provider/catalogue.

## Repair and focused retest

Only `components/auth/signup-form.tsx` changed in this production lane. A synchronous phase guard admits one valid submit. Mounted lifetime and committed destination/referral identity fence retained callbacks and late UI/navigation effects. Completion retires the submit; a changed destination during a dispatched request settles into review. Pending inputs and alternative auth buttons are disabled by the surrounding fieldset. Best-effort referral and identity action rejections are contained. A definitive, non-transient 4xx response keeps the draft available for a deliberate retry; uncertain or unreadable results lock the submit and offer the safe sign-in link. Check-email/confirmed success requires a valid UUID user receipt and a matching session user when a session is present.

The final focused run is **21 Chromium checks PASS in 3.3 seconds**. The original local regressions now pass. Additional execution covers invalid UUID receipts with and without a session, unreadable HTTP 400 responses, idle and pending destination changes, disabled pending inputs, and French uncertainty copy with selected-plan sign-in continuation. The actual LocaleProvider uses the two new keys appended by root to all seven base catalogues. Source/spec lint passes with no warnings; scoped diff whitespace checks pass.

One of the 21 passing checks deliberately characterizes an unresolved SDK limitation: a lost signup response still deletes the dispatched PKCE verifier. The original red assertion is retained in the history above; it was separated from the repaired no-repeat UI regression, not reclassified as repaired. No guessed or old verifier is restored, and neither global browser client nor SDK storage behavior changed. A safe future storage repair needs request/attempt identity and compare-and-set behavior so a failed older request cannot overwrite a newer auth flow.

The review lock belongs to the current form instance. It is not a persisted browser-restart transaction record. UI retirement also cannot undo an already accepted auth operation or the SDK's session persistence. Email delivery/link exchange after an uncertain result, other-browser confirmation, phone/OAuth signup, server attribution, and actual hosted provider configuration remain unverified here. The complete `AUTH-001` workflow remains open.

## Provenance and fixture corrections

Discovery ran at HEAD `387e4d9e85d79c2a5fc01c4be610f6ddde08287e`, using Node `24.19.0` and installed Chromium. Before repair, `SignupForm` SHA-256 was `b20803f069180dc8094ec01bd03c03c390b7a1d5e8c9ca453662a7d609452447`; production browser factory SHA-256 was `de4169506c349bff441856947f509b7d3ed829576ec9bbf11d39e6cd2c779085`. The 14-case characterization spec SHA-256 was `b384c18059de2620883d42dc27846b94fc00073666052521cae2eec6a7a4a7d1`.

Final 21-case evidence fingerprints: `components/auth/signup-form.tsx` SHA-256 `e4bf5c85d19d4dc8e0da68d57341a1b509dc78f212dd785a7cbc0b63c3b6e5b7`; `tests/e2e/signup-boundaries.spec.ts` SHA-256 `6bb82d636fcd58022c70562136453025848176f3ce05de2781adfdd4c07bb759`.

The first harness run hashed the JSON-encoded storage string instead of the decoded verifier, causing a false failure in the PKCE control; this was fixed before the reported evidence. Its toast assertion also waited until the stale toast expired, masking the real stale-completion defect; it now checks the committed immediate state. No production change was involved in either correction. An intermediate repaired run passed 14 of 15 checks while awaiting root's locale additions; the remaining assertion saw untranslated key names. After the actual catalogues arrived and the six additional cases were added, all 21 passed.

A focused adjacent run of `tests/auth-review-selection-forms.test.ts` exposed its obsolete direct-function hook fixture: 22 failures and eight passes out of 30. It crashed on real `useMemo` before signup behavior; its signup receipts also omitted `data.user` or used a non-UUID placeholder. Root then assigned that fixture repair. Stable memo/layout-effect slots, proper asynchronous action results, UUID user/session receipts, and a definitive HTTP 400 error replaced those incomplete contracts. All **30 existing cases pass** (65 ms test time; 1.22 seconds total), preserving the signup/login/OAuth/phone/selection/locale matrix. It remains a simulated-hook suite; the 21 Chromium checks provide actual signup component/SDK execution. No full suite, build, private installation, dependency, SQL, global navigation, or global auth-client change was made.

Run the bounded fixture with `PLAYWRIGHT_EXTERNAL_SERVER=1`, Node 24, and `node_modules/@playwright/test/cli.js test tests/e2e/signup-boundaries.spec.ts --project=chromium --workers=4 --timeout=10000`. No local application server is needed because every request is intercepted.

After the separate recovery UI was integrated into LoginForm, the focused signup browser rerun again passed **21 cases in 3.4 seconds** with the source/spec fingerprints above unchanged. The legacy selection fixture explicitly isolates the new RecoveryForm import at its component boundary; all 30 original cases still pass. Together with the actual catalogue integrity suite, the adjacent Vitest run passed 85 cases across two files. The final legacy fixture SHA-256 is `0944bf5fd3ca6a91ab766b81ca08cc635ccbb73932cb65160358278c12c4cb3d`. Recovery UI evidence and its separate limits are recorded in `auth-recovery-ui-cycle.md`.
