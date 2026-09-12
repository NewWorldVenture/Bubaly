# Guardian SMS replay authorship — active verification cycle

Baseline: cc91568425c9a3f42765b9230a39f3b3d3748428. Primary audit ID: AUTHZ-004 (High, IN PROGRESS).

## Issue and expected behavior

An authenticated member may insert an own-family communication. If the member knows a real provider SID and its exact payload before legitimate capture, a structurally valid decided row can currently skip screening on a genuine signed callback. Signature validation authenticates the callback, not the database decision. No cross-family access, signature forgery or live exploitation is claimed.

Only a server-owned receipt may authorize replay of a stored decision. It must bind the exact signed input, family, member, communication identity and complete decision. Existing classifications without that proof must never be copied into a trusted receipt as evidence of authorship.

## Repair plan recorded before application changes

1. Reproduce the bypass using the signed SMS route and installed database client transport fixture.
2. Reuse the existing service-written ai_tool_calls ledger, whose existing schema gives authenticated users no write policy. Add no SQL. Validate deterministic identity, system actor, payload, revision, resource pointer and decision before reuse.
3. Capture input separately from decision authority. For a matching legacy communication without a receipt, perform fresh screening from the verified callback, and bind only that newly computed decision. Preserve pending intake, lease checks, bounded reads, conditional updates and notification idempotency.
4. Exercise forged blocked and permitted rows, valid replay, mismatched/tampered receipts, missing receipt, lost writes, policy failure, concurrent changes and expired ownership. Verify the helper through real installed query transport, and run relevant regressions. Add a disposable GoTrue/PostgREST test demonstrating the existing communication INSERT permission while rejecting member INSERT/UPDATE/DELETE of service receipts and other-family/anonymous receipt access.
5. Extend disposable verification through the real HTTP SMS endpoint with a synthetic callback signing token. Verify fresh decisions replace forged blocked/permitted classifications, trusted replay survives a changed profile without duplicate notification, and invalid signatures are rejected. Scope all records to owned fixtures, remove owned callback events explicitly, and keep external provider credentials absent. These requests authenticate synthetic local callbacks; they do not verify provider delivery.
6. Independently review the repair, run the full applicable source gates, then publish and await hosted checks. Hosted tests and production provider verification remain separate evidence.

## Boundaries and follow-up

The active repair adds trusted input and decision receipts. Autonomous recovery is a following cycle and must start only from trusted receipts; existing unverified rows cannot be promoted by database-only backfill. Production scheduling, real provider delivery, voice/WhatsApp retention, family timezone behavior and cross-table atomicity remain unverified. No shared navigation, SQL, pricing or dependency installation changes are planned.

## Results

The two signed-route baseline cases fail at cc915684: forged blocked and permitted communications each return 200 with no deterministic or deep scam screening. Both invoke the actual pipeline entry through the installed PostgREST transport fixture. Evidence: `Temp/bubaly-guardian-sms-authorship-baseline-20260912.log`. This is controlled execution, not a live provider exploit.

The initial disposable receipt-authority test is authored and passes lint, strict types and Playwright discovery (one Chromium case). Independent review found no blocking defect in its database-authority proof or fixture ownership. Signed local HTTP cases are being added under the preceding plan. Real database execution is pending hosted CI. The prior policy-read repair has a deployed preview and its hosted CI is running independently at cc915684.
