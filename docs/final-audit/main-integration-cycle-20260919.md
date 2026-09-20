# Current main and production-audit integration

Date: 2026-09-19. Status: **IN PROGRESS**. Production readiness: **NO**.

The merge combines audit head `dcbccaa1382aa8b712a358722d8a50724f3359fe`
with upstream `57f22c0b61e25afa471eb9e997e3480592a22248`. The SMS ingress
implementation from `faa5172ad910ba3ceed15498723779fb05fb8d81` is reconciled
with both parents. Final verification uses the frozen staged tree
`4ac44596e1f91234ee9822b9ca2027d0fd62fdb2`, captured before these final evidence
updates. Additional auth and rewards repairs are included in that source.
Application code remains unchanged. A subsequent test-only correction makes the
medication UTC assertion explicit and separately checks the intended browser-local
wall time; the passing DST-zone rerun includes that correction. No application
source changed after the frozen build and strict type check.
Local acceptance gates are complete. The final committed identifier and integrated
hosted execution remain pending.

Permanent records: AUDIT-INTEGRATION-001, AUTH-001, AUTH-002, AUTH-003,
SMS-001, API-387E2B30BCD7, CALLBACK-24807E48E6E6, MEAL-001, DATA-004, TEST-001 and
DEPLOY-001. This cycle does not close their remaining full workflows.

## What the integration preserves

The weekly planner retains seven household-local dinners, saved meal and recipe
selection, custom ingredients, exact slot replacement/removal, family/user/week
ownership, committed readback and pantry-aware grocery additions. The upstream
vote-clear error check is retained. Medication updates/deletes and reward
catalogue writes retain zero-row refusal checks together with the audit branch's
readback and stale-work protection. The shared widget error boundary keeps the
kiosk fallback and recovery behavior. Voice history remains best-effort while
reporting failed writes. Privacy settings keep explicit guarded logout.

The merge retains upstream application and migration changes. No new SQL was
authored or applied by this integration, and no shared dependencies were
installed or modified. CI, `.nvmrc`, package engines and the lockfile agree on
Node 24.21.0. CI keeps the disposable database and authenticated browser gates,
and adopts the localization gate and the second unit run in a DST-observing zone.

## Rewards server-action lifecycle regression

The server-action hardening already present in audit head `dcbccaa1` had routed
redemptions away from the earlier client mutation guard. Executing the current
server actions exposed eight browser failures: retained callbacks could act
after failed reads, duplicate callbacks were not fenced, readback did not refresh
balances, and unmounted or superseded work was not retired. The combined UI
run passed 248 of 256 cases before this repair; it was not a passing gate.

Requests and decisions now resolve the latest reward, balance and redemption
state, then call the real server actions through the existing synchronous pending
guard and confirmed ledger refresh. Success remains deferred until usable reads
commit, and unmounted work does not refresh or toast. Catalogue edits/deletes use
family-scoped returning queries with `.single()` so zero affected rows are a
refusal. Server-derived role, family, reward price and decision fields remain in
the server actions; the client does not regain authority over them.

Independent comparison against `f482fc47` and the current server actions found
the earlier client lifecycle guarantees restored without dropping server
authority. **32/32 rewards Chromium checks now pass** in 4.3 seconds, including
the eight formerly failing behaviors and the existing form/readback review.
Logs: `Temp/bubaly-integrated-ui-retest-20260919.log` (248 pass, 8 fail) and
`Temp/bubaly-integrated-rewards-fixed-20260919.log` (32 pass).
These are separate, overlapping runs, not a single combined 256/256 result.
Both new catalogue refusal checks failed as expected under the negative-control
mutation; the original source hash was restored before final verification.

DATA-004 remains IN PROGRESS. Server/database affordability, atomic reservation,
expected-status concurrency and deployed policy remain separate open obligations.
This UI restoration does not establish those properties.

## Pending signup and explicit logout

A delayed signup could install its returned session after application logout
when only a pending PKCE verifier existed. Five executing browser cases first
failed. Logout now explicitly snapshots and retires pending project auth
cookies; signup ownership includes the logout generation. Refused cookie deletion
does not authorize late signup adoption, and an older logout intent cannot
consume a newer handoff. Normal session snapshots retain their prior semantics.

A further review reproduced a stale session logout intent consuming a newer
pending signup verifier beside an existing session. Session intents now capture
the exact pending verifier cookies when present. An older intent preserves a newer
handoff; a fresh logout retires both the session and handoff, and the delayed
signup response cannot adopt. Ordinary token rotation remains accepted.

Final focused evidence: **138/138 controlled Chromium checks across six suites**
pass in 11.0 seconds, including the added stale-session and ordinary-rotation
cases. The latest logout and bridge unit run passes **36/36 checks across two
suites**; the earlier related seven-suite run passed 150/150 before the additional
ownership repair. The final frozen full unit run below includes that repair.
The browser cases use the installed SDK and intercepted synthetic provider
responses. Exact scope and logs are in
[the pending-signup cycle](auth-pending-signup-logout-cycle.md).

**Still open:** an ordinary successful session refresh deletes a pending standard
PKCE verifier in both the installed browser SDK and the SSR adapter. The SSR
probe retained user A while emitting deletion of the pending verifier. This is
a signup/handoff failure, distinct from losing the already-authenticated user.
The current logout repair does not solve it. A complete repair must isolate
attempt-owned handoff state across browser creation, middleware/server renewal,
matched callbacks and explicit logout without restoring retired cookies. Hosted
email confirmation, session policy configuration and physical-device reopening
also remain unverified.

## SMS intake before optional reply preparation

For canonical signed SMS callbacks, the route retains the original ingress
before optional family context and reply-candidate work. The existing normalized
inbox projection and immutable reply receipt remain separate. Timeout or locale
failure still takes the deterministic summary/classification path so intake and
planner work can continue without an automatic reply. A late candidate that
ignored cancellation cannot publish a reply. Legacy reply and urgent receipts
retain their original ownership/suppression behavior; a reassigned number cannot
adopt the original family's callback.

**875/875 focused checks across 32 suites pass** on Node 24.21.0, covering
Contact Center ingress, signed callbacks/status, text bounds, reply reservation,
urgent persistence, marketing push outcomes and concurrent social publication.
The route cases check one retained inbound row, unchanged ingress, no emission
after candidate failure, and legacy suppression on replay. Log:
`Temp/bubaly-sep19-contact-social-push-regression.log` (6.57 seconds).

The new hosted fixture covers two disposable families, an original-body digest
collision, number reassignment and legacy reply/urgent recovery. **Its hosted
execution is pending.** Private SDK tests and synthetic signed callbacks do not
establish live SMS delivery, production provider configuration or a safe
old-handler deployment cutover.

## Guard integration and audit integrity

The initial integrated run exposed portable-guard failures. The date guard's
eight read and five write hits were Windows separators failing to match existing
complete-path exemptions. Path normalization repairs the comparison; no exemption
was added. Negative sibling and unsafe-date cases still fail.

The SSRF scan encountered four configured auth transports. It now recognizes
the specific SDK/configured-origin fetch call through syntax-tree wiring, rather
than exempting an auth file. Mutations changing the configured origin to user
input, bypassing the transport input, adding a sibling fetch, removing recovery's
origin check or following redirects all fail recognition. These two repaired
guard suites pass **15/15 checks**, scoped lint and whitespace checks. Production
URL restrictions were not changed.

The master audit retains all **13,866** pre-merge IDs. Six previously uncounted
SEO/DATA records, 112 provenance-qualified upstream references and the integration
record bring the total to **13,985**. The complete upstream narrative is preserved
verbatim. Reused upstream F-J01/F-K01 labels are distinguished by provenance in
the master ledger. FLOW-FC0B97223986 again names the family email workflow.
Unsupported full-workflow PASS claims are withdrawn while their historical
evidence remains. Archived JSON discovery remains reference material; regenerating
from it would overwrite newer human edits and must not be done without a full
reconciliation.

All seven merged translation catalogues contain **13,630 keys**. Independent
language additions and existing translations survive. The sole removed key held
a CSS constant, which upstream moved into the consuming component. The
localization gate passes.

## Combined acceptance — local gates complete, hosted execution pending

| Gate | Current evidence |
|---|---|
| Frozen combined source identifier | Pre-final-evidence staged tree `4ac44596e1f91234ee9822b9ca2027d0fd62fdb2`; final source commit pending |
| Full unit suite in UTC | PASS: 16,360/16,360 tests across 1,294 files, zero failed/skipped, before the test-only timezone correction; `Temp/bubaly-integration-units-final-20260919.json` |
| Full unit suite in DST-observing timezone | PASS after test-only correction: 16,361/16,361 across 1,294 files, zero failed/skipped; `Temp/bubaly-integration-units-dst-final-20260919.json`. First run passed 16,359/16,360; its sole failure assumed omitted medication timezone meant UTC although the helper defaults to browser-local time |
| Corrected medication contract in UTC | PASS: 16/16; explicit UTC assertion plus separate browser-local wall-time check; `Temp/bubaly-integration-dose-zone-utc-20260919.log`. No production edit |
| Full production build | PASS: frozen source build exits 0 with 251 pages; `Temp/bubaly-integration-build-final-20260919.log` |
| Strict post-build types | PASS: frozen source exits 0; `Temp/bubaly-integration-types-frozen-20260919.log` |
| Lint | PASS: frozen source lint exits 0 with three existing warnings (document-capture generation ref and two messages-module toastError dependencies); `Temp/bubaly-integration-lint-final-20260919.log` |
| Localization and query audits | PASS on unchanged application source: localization and query audit (491 tables, 86 functions, 146 routes) |
| Controlled browser regression | Focused restoration verified: prior run 248 pass / 8 reward failures; repaired rewards 32/32 pass. Complete integrated hosted regression pending |
| Hosted browser discovery | PASS: 1,078 tests across 47 files, including the new SMS ingress fixture and five durable-login journeys; authenticated/durable flags retained. Discovery only; `Temp/bubaly-integrated-discovery-final-20260919.log` |
| Hosted database/authenticated/browser acceptance | Published `43df0881` run `35462526440`: browser gate failed with 1,072 pass / six fixture failures (four finance missing-module imports, two SMS setups refused by the last-manager guard). New SMS ingress case passed. Database replay: 330 migrations, 38/38 probes and 327 existing-schema reapplications pass. Fixture repair and fresh hosted execution required |
| Real providers, deployed session policy and physical devices | Unverified |
| Second complete feature regression | Not complete; individual audit obligations remain open |

The completed local gates above are tied to the frozen source and explicitly
identified subsequent test-only correction. Historical gates are preserved for
their named sources. The complete feature and hosted regression remains
**IN PROGRESS**, and the release gate remains **NO**.

Follow-up application work and its separate verification are recorded in the
[PKCE/recovery cycle](auth-pkce-refresh-preservation-cycle.md) and
[voicemail cycle](guardian-voicemail-intake-cycle.md). The hosted evidence here
belongs to published `43df0881`, not those later changes.
