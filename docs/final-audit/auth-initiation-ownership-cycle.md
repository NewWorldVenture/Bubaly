# Authentication initiation ownership

2026-09-19. This cycle starts from published main
`70789485cd5e8ad00d49c2834e5c2aebf6941679`. **AUTH-001, AUTH-002 and AUTH-003
remain IN PROGRESS.** Final source/test tree
`eaba35cb7be2eb73d45fb3384ec4fced3680bc72` contains 37 changed source files:
15 production and 22 test files. Application bytes remain identical to freeze
`bf22aca87274bf607c4c605180c62e21c89ecbb7`; two existing browser fixtures were
refined afterward. Both full unit runs, eleven ordering cases, the final 397-case
browser matrix, 252-page build, strict types, lint and localization/query checks
pass. New-source hosted acceptance has not run. Earlier checkpoints below are
retained as historical evidence, including superseded failed runs.

The separate [native credential-form repair](auth-native-form-cycle.md) passes
exact production checks and exact 707 hosted CI: 1,186/1,186 browser cases with
zero failures/flakes/skips. That closes only SEC-005. It does not cover this
initiation implementation. Full authentication and production readiness remain open.

## Original initiation sources and changes

| Surface | Actual source | Boundary addressed |
| --- | --- | --- |
| Email signup | `components/auth/signup-form.tsx` → `lib/auth/signup-client.ts` | Existing form ownership and honest receipts remain; shared initiation now persists the original decision through confirmation, while preserving guarded immediate signup adoption. |
| Google login/signup | `components/auth/oauth-buttons.tsx` | An isolated SDK suppresses automatic navigation. Synchronous click/component ownership and explicit final navigation checks replace the previous shared-client automatic redirect. |
| Self-service reset | `components/auth/recovery-form.tsx` | The shared initiation adapter owns verifier/record publication and dispatch. Reset retains its distinction between rejection and uncertain delivery. |
| Administrator reset | `app/(app)/admin/actions.ts` | Existing direct implicit recovery remains separately verified using a recent bearer session and signed grant. It is not converted into recipient-browser PKCE initiation proof. |
| Phone login/signup | `components/auth/phone-auth.tsx` | Direct OTP request/verification is outside this PKCE cycle and remains a separate workflow obligation. |

The first three are the browser PKCE initiation sources identified across app,
components and lib. Callback GET and completion page carry an exact opaque
attempt; the browser and isolated server exchange both compare its original
proof. Neither route generates replacement initiation metadata.

## Implemented comparison contract

One configured-project cookie, `${projectKey}-pkce-initiation`, holds the pending
operation. Before the first await, initiation captures the original session,
logout generation, verifier and previous record, then synchronously writes and
reads back `pending-v1-${nonce}`. This unfinished reservation is deliberately
rejected as exchange proof. A later initiation replaces that reservation, so
older held work loses ownership even before either operation writes a verifier.

Only after original-owner checks and hashing does the adapter publish the exact
verifier plus a complete canonical record and verify readback. The record is at
most 1,024 characters: version, random 32-lowercase-hex nonce, kind (`signup`,
`oauth`, `recovery`) and four SHA-256 comparisons of project, original logout
generation, stable session owner (or exact identity-less cookie state), and exact
new verifier. These are comparison metadata; the provider remains authentication
authority. A pending marker, malformed/duplicate record, nonce mismatch, wrong
purpose or any changed hash cannot authorize exchange.

The nonce travels through the callback URL, completion page and action. Query
parsing requires one exact nonce and does not repair missing or ambiguous values.
Only that opaque value is transported; raw verifier, tokens, email and session
identifiers are excluded. Existing request-admission evidence remains unchanged
and is checked before initiation evidence. The server reads duplicate-preserving
raw cookies and checks all four hashes before constructing its isolated SDK.

SDK initialization, digest awaits, final cookie writes, dispatch, OAuth navigation,
token adoption and proof consumption retain ownership checks. Refused or partial
storage stops work without restoring old bytes. Current logout and stale logout
intent comparisons include the record; new session/logout decisions invalidate
old records even when deletion fails. Same-user/same-session token rotation stays
valid. Browser cookie comparison and writes are **not an atomic transaction
across processes**; the reservation fixes the reproduced interleaving, not every
possible simultaneous browser cookie race.

In-progress initiation has a 35-second deadline. Provider code/token expiry is
authoritative after dispatch; there is no separate record TTL that shortens
configured email-link validity, and no deadline changes login lifetime. Missing
or unsupported legacy proof rejects code exchange with a fresh-link/sign-in path
while preserving the current session. A code rejected by the provider no longer
uses an ambient login as success. A no-code visit may continue an existing
session only through the original request witness and guarded browser fallback;
it does not adopt a new session.

## Executed evidence

All paths below are under `C:/Users/Daniel/AppData/Local/Temp/`. Controlled browser
fixtures execute production components/adapters and the installed SDK with
synthetic transport; they do not establish live provider delivery. The scoped
groups overlap, and checkpoints are not summed into a fabricated aggregate.

| Evidence | Result and scope |
| --- | --- |
| `bubaly-oauth-initiation-red-20260919.log` | Original component/SDK behavior: seven desired failures and one control pass. Held writes/digests outlive logout, newer login or unmount; a same-turn duplicate dispatches twice. |
| `bubaly-initiation-reservation-red-20260919.log` | Additional actual two-tab race: A starts, B starts, releasing old A first still publishes/navigates A and blocks B. This justified the synchronous reservation. |
| `bubaly-initiation-reservation-green-20260919.log` | 163/163 after reservation: OAuth 11, signup 56 and callback ownership 96. B's reservation retires held A before its verifier write; releasing A first causes no publication/navigation. |
| `bubaly-recovery-initiation-reservation-20260919.log` | 48/48: 38 compatibility cases and ten new reset cases covering held write/metadata digest across logout, newer login and unmount, same-session rotation, refused verifier/record storage and deadline. |
| `bubaly-initiation-completion-ui-final-20260919.log` | 61/61 completion UI checks: original 44 plus 17 nonce/record/hash/purpose, provider rejection, fresh-request-after-logout/new-login and rotation cases. Real proof parsing and SDK adoption execute; these preceded the final reservation refinement. |
| `bubaly-initiation-admission-final-20260919.log` | 119/119 route/page/routing checks; original route/page nonce expectations produced 12 desired failures before propagation. Routing executes actual proof parsing/factory with synthetic provider results. |
| `bubaly-initiation-server-red-20260919.log` | First 29 direct server cases: 24 desired failures, five positive controls on baseline factory. |
| `bubaly-initiation-server-final-matrix-20260919.log` | 193/193 across seven server/recovery suites, including 33 new direct proof/action cases. Installed server SDK and real factory enforce nonce, purpose, exact verifier and original owner before exchange. |
| `bubaly-pkce-initiation-units-20260919.log` | 117/117 pure record/witness checks. |
| `bubaly-owned-initiation-compat-20260919.log` | 57/57 form/selection compatibility checks. |
| Root focused compatibility gates | 26 persistent-login and nine configured-fetch guard checks pass. The moved initiation transport is recognized precisely; origin/path/redirect guard mutations remain rejected. |
| `bubaly-initiation-full-types-first-20260919.log` | Full strict TypeScript passes on the latest application source; eight root-owned source files pass scoped lint. Other owned fixture/server lanes also pass scoped types/lint. |
| `bubaly-initiation-full-unit-UTC-20260919.log` | Frozen 453d source: 16,694/16,694 tests across 1,305 files, zero failures/skips, 29.85 seconds. |
| `bubaly-initiation-full-unit-DST-20260919.log` | Same frozen source in the DST-observing timezone: 16,694/16,694 tests across 1,305 files, zero failures/skips, 30.22 seconds. |
| `bubaly-auth-matrix-453d5a23-20260919.log` | Exact frozen 453d archive: 397/397 browser checks across 14 files, four workers, 28.7 seconds, zero failures/skips. The companion `bubaly-auth-matrix-453d5a23-evidence-20260919.json` confirms 22 matching frozen blobs. This supersedes overlapping focused browser checkpoints for that source; the six real HTTP cases are excluded. |
| `bubaly-initiation-production-build-20260919.log` | 252-page production build passes on 453d; synthetic optional-provider timeout diagnostics are not live-workflow proof. |
| `bubaly-initiation-full-lint-20260919.log`, `bubaly-initiation-i18n-20260919.log`, `bubaly-initiation-query-audit-20260919.log` | Lint passes with three existing warnings; localization and query checks pass (491 tables, 86 functions, 146 API routes). |
| `bubaly-initiation-full-types-final-20260919.log` | Final strict TypeScript exits zero on predecessor 453d. It does not cover the following password-reservation repair. |

The first combined unit run passed 16,691/16,693; its two failures exposed the
fetch scanner's unrecognized moved adapter. The test guard now follows that
adapter and tests its restrictions. No production transport was weakened. The
final full UTC and DST runs above supersede that failed checkpoint. The combined
397-case browser matrix, production build and final strict types also pass for
453d. These are predecessor evidence for the
cross-flow repair, not a final source or hosted acceptance claim for that repair.

## Subsequent cross-flow ordering discovery

`bubaly-initiation-cross-flow-red-20260919.log` records four desired failures
using the actual SDK. A held older password login for B can replace ambient A
after a newer OAuth or signup begins; the newer PKCE operation then loses its
original session owner and fails before dispatch. In the opposite ordering,
older OAuth/signup work still dispatches or navigates after the new password
login begins. That reverse reproduction did not show replacement of an already
adopted B session. Four separate positive controls pass in 2.0 seconds in
`bubaly-initiation-cross-flow-controls-20260919.log`; they are not four passes in
the RED log.

The bf22 repair shares the pending decision slot with explicit password/child
initiation using a synchronous, nonexchangeable `session-v1-${nonce}` reservation
and exact readback. It preserves the prior verifier; callback token adoption
retains its already validated original initiation record. Refused, duplicate or
chunked record storage rejects the new decision before provider work.
`bubaly-initiation-order-final-20260919.log` records 11/11 actual-SDK cases passing
in 6.1 seconds: the four prior failures, password/password ordering, ordinary
password/child login, verifier preservation, refused/ambiguous storage and retired
callers. Scoped types/lint pass in the companion logs.

Both full bf22 unit runs pass 16,694/16,694 across 1,305 files with zero
failures/skips: UTC 31.71 seconds and DST 37.84 seconds, in
`bubaly-initiation-order-full-unit-{UTC,DST}-20260919.log`.
The new-source 252-page build and full lint with three existing warnings also pass
in `bubaly-initiation-order-production-build-20260919.log` and
`bubaly-initiation-order-full-lint-20260919.log`. An intermediate
397-case browser matrix had **383 passes and 14 failures**. Thirteen exact-cookie
fixture expectations did not account for the intentional session reservation;
one child fixture constructed a logout snapshot without pending metadata and was
correctly refused as stale. The two fixture corrections retain exact prior
session/verifier/generation assertions, check the canonical `session-v1` marker
separately and invoke production child logout. Application source is unchanged.

The final combined matrix now passes **397/397** in 29.5 seconds with zero
failures/skips, in `bubaly-auth-matrix-password-reservation-20260919.log`.
Its exact password-client blob is `9ada298210a0747718357b68c465b8421d1f9c4c`;
the corrected password/child fixture blobs are
`f028ab9e0dd523b39705ec185665b76e49d27748` and
`0fd2b45be804f6d34d0345ca410496cf1ea44207`. All are included in final tree eaba.
This supersedes the 383/14 result; the eleven targeted ordering cases remain a
separate run. Full strict types also pass on these final files in
`bubaly-initiation-order-full-types-final-20260919.log`; fixture scoped types/lint
pass in `bubaly-auth-reservation-fixtures-{types,lint}-20260919.log`.
AUTH-001/002/003 remain IN PROGRESS throughout.

## Hosted acceptance and compatibility limits

The new six-case `tests/e2e/callback-admission.spec.ts` is discovered, typechecked
and linted only. Four prior real HTTP/Mailpit cases now use legitimate original
proof; two new missing nonce/record cases require no action. Runtime acceptance
on this new source is pending. Evidence:
`bubaly-initiation-http-{discovery,types,lint}-20260919.log`.
Exact bf22 release discovery lists 1,252 tests across 52 files, including all six
HTTP cases and eleven ordering cases, with authenticated/durable flags enabled.
`bubaly-initiation-release-discovery-bf22-20260919.log` is discovery only.

Existing sessions must remain intact through deployment. Already issued PKCE
links without the new record intentionally require a fresh link; accepting them
without original proof would reopen the reproduced gap. Phone flows, real
Google/provider delivery, production mail/redirect/session settings, physical
device reopening, admin implicit recovery and broader workflow authorization
remain separate acceptance obligations. No SQL, dependency, product config or
CI workflow changes belong to this cycle.

The [exact inventory](discovery/auth-initiation-ownership-inventory.json) adds
15 structural records: two libraries, nine exported runtime functions and four
test files. Three type declarations are mapped under the pure library record;
there are no new routes or controls. All 14,020 prior IDs/statuses are retained,
including SEC-005 FIXED + PASS. The prior fourteen additions also retain their
IDs/statuses. The master now has 14,035 items: 13,845 NOT STARTED,
186 IN PROGRESS, one FIXED + PASS and three FAIL (0.01% audit completion). New
structural records remain NOT STARTED; no whole AUTH record is promoted.
