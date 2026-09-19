# Social schedule presentation and stored-link review

This bounded review owns `tests/social-scheduling-presentation.test.ts` and this document. Root owns all application changes, master findings, translations and integration. No application source was edited by this lane.

## Permanent references and boundaries

| Reference | Actual server page |
| --- | --- |
| UI-ROUTE-0243 | `app/(app)/dashboard/social/calendar/page.tsx` |
| UI-ROUTE-0244 | `app/(app)/dashboard/social/content-studio/new/page.tsx` |
| UI-ROUTE-0251 | `app/(app)/dashboard/social/posts/[id]/page.tsx` |

The fixture invokes actual async server pages, renders them with real React SSR, and executes current `schedule-time.ts`, `safeSocialLink`, RetryPublishButton, shared presentation primitives, LocaleProvider, `localeOrDefault`, the actual merged/raw catalogues and translation function. It supplies complete typed `Tables<...>` social rows at explicitly mocked auth/query request boundaries. No query failures are converted into successful empty results by the fixture.

The New page's Studio client boundary is isolated with a typed sentinel. Its React key, selected account props, and stored/absent timezone are inspected from the actual server page tree and rendered sentinel. Actual Studio lifecycle/timezone behavior is separately exercised by `tests/e2e/social-scheduling-ui.spec.ts`; these server tests do not duplicate or inflate that browser evidence. Next links render as anchors, while missing-post behavior is an explicit not-found boundary. No server publishing action is invoked during rendering.

## Initial execution and findings

The initial **26 actual server-rendering checks passed** in 46 ms (1.30 seconds including runner/import time). They cover:

- One absolute instant grouped separately by each row's saved zone, including New York's previous calendar day/year versus UTC and Paris; exact displayed times and detail links.
- Legacy rows displayed explicitly in UTC with unverified authorization copy.
- Approval-required, unknown, dispatching, failed and unarmed public projections, allowed error translations, discarded arbitrary/private metadata strings, and completed rows without stale queue warnings.
- French schedule dates and copy through the real locale contract.
- Scheduled `Publish now` versus ordinary failed-post `Retry publish`, no retry while a target remains publishing, and completed-post affordances.
- Legitimate empty calendar versus required read failure, missing versus unavailable detail, settings read failure versus legitimate settings absence, invalid stored zones, and authentication before request-boundary reads.
- NewContentPage's authenticated `familyId:userId` React key and verified stored timezone.

Two additional desired assertions then failed before any corrective application edit by this lane. A scheduled post with pending target rows and public `schedule_phase: unknown` or `dispatching` displayed an awaiting-confirmation warning **and an active Publish now button**. PostDetail's `canRetry` considered only ordinary post/target status. The current producer `reconcileScheduledPost` projects public metadata while writing ordinary post status only on completion; stale ordinary fields are therefore a meaningful supported projection case. The private worker/action fence remains separate and no provider resend was demonstrated. This is a misleading recovery affordance, not an established authorization bypass. Root received the exact two failing server-rendering cases before owning the narrow detail gate.

## SEC-004 stored-link extension

Root separately recorded SEC-004 from the API lane's actual action/React evidence before adding HTTP(S) URL validation to actions and stored href boundaries. This lane then added **9 actual server-rendering checks**, all passing in 34 ms (1.39 seconds total for that focused run):

- Unsafe legacy javascript/data URLs, credential-bearing URLs, whitespace and overlength URLs do not become links in actual detail post/target, feed or inbox rendering.
- Visible text containing synthetic HTML remains escaped and present. No script element or javascript/data href is emitted, and the actual React renderer produces no warnings in these cases.
- Valid HTTP and HTTPS post/target/feed/inbox links remain usable, including query/hash preservation and target/rel attributes.
- Feed uses a safe profile fallback when its stored permalink is unsafe, and retains a safe permalink when the profile fallback is unsafe.

Inbox comments use resolved status so this test isolates stored-link rendering and does not claim to execute the unrelated resolve-comment server action. The fixture never runs a malicious URL. No actual script execution, exploit delivery, external provider, OAuth, SDK transport, live RLS, or database authorization claim is made by these rendering tests.

## Verification status

Final owned presentation total: **37/37 cases pass**, with 65 ms of tests and 1.44 seconds including runner/import time. Root added the uncertainty-aware detail gate and made unknown/dispatching phase take precedence over inconsistent public error copy. Both prior red cases now pass, including an inconsistent allowlisted error that previously could obscure uncertainty. Scoped test lint passes. The first lint run caught a test-only React children-prop style issue; the typed provider props construction was corrected without changing the actual locale/runtime contract or adding a suppression.

No full suite, production build, dependency change, SQL/migration operation, private-clean workspace change, global navigation edit, commit or push was performed. Root controls combined gates and source integration. This review does not establish production readiness.


## Final companion browser verification and fixture correction

Root added a typed `reviewRequired` result for ambiguous initial insert responses that may lack a post ID. The separately owned actual Studio browser fixture now has **23/23 cases passing in 3.7 seconds**. The two added cases verify that a returned ambiguous result (without throwing) preserves and locks the draft, offers Review posts, additionally links the known post when an ID exists, and refuses retained duplicate callbacks. This remains an explicitly controlled typed action boundary, not provider/SDK execution evidence.

The first final presentation rerun had four test-only failures because an earlier Windows-default Python read had corrupted hard-coded French and middle-dot expectation literals during test editing. Application rendering was correct in the failure output. Explicit UTF-8 decoding restored the owned literals and the complete 37-case run passed. The same review corrected a French input literal in the existing capture fixture and historical discovery punctuation; its actual French browser case was rerun and passed. No application source changed for this fixture correction, and the prior 39-case capture source gate remains separately recorded.

## Frozen owned artifacts

- `tests/social-scheduling-presentation.test.ts`: SHA-256 `85949aba35d0d60e27edf69bb1fe70b92004ed01dc0d078804e3bd9f8292ef63`.
- `tests/e2e/social-scheduling-ui.spec.ts`: SHA-256 `64cfeced0b84385cd9dac752da31b2f36b85e6b9912c8f38b79bdd03a328c437`.
