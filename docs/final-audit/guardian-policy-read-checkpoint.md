# Guardian policy and retained SMS checkpoint

Implementation: `237933c1e17e0db43732557254aeaf3c9cb2016f`. The independently prepared source `eee4ec06d74788ee7def7db11be3a8ea28bab6fc` was integrated without changing its application or unit-test files. Outside audit documentation, the only difference between these commits is the previously verified meal E2E receipt locator from `14935e33`.

## Reproduced failures and changes

Three actual installed-SDK policy-read probes reproduced contact, member-profile and routing-rule errors becoming ordinary `ai_handle_first` decisions. Required reads now share a five-second deadline, cancel transport, validate complete scoped representations and reject unavailable or late results with a bounded stage error. Verified absence retains healthy defaults. Existing routing precedence is preserved.

Three signed SMS route regressions reproduced classification before retention, lost inbound content after policy/scam failures, and classification despite failed storage. The route now saves and reads back an owned neutral `screening` communication before required policy or AI work. Pending receipts resume classification; complete existing decisions follow the replay path. Conditional pending-state writes and exact decision readback precede notification and completion. Lost insert or decision responses are reconciled through the existing unique provider SID.

The SMS body stays out of update URLs. A 4,096-character Unicode case verifies the exact retained and classified body with request URLs below 2,000 characters. Exact body checks before classification and after the decision write suppress notification if another writer changes the payload. Fresh callback-lease reads before the decision write and after the awaited notification-scope lookup reject workers whose lease has already been replaced. The shared lease helper remains unchanged.

Voice and WhatsApp handlers return 503 on required-policy failure before downstream routing or notification. Their existing destination-read and callback-claim behavior remains a separate workflow obligation.

## Verification

- Pipeline/rules and signed voice/WhatsApp caller group: 84 PASS. This includes 60 actual SDK policy cases and healthy/invalid-signature controls. Baseline and focused output was returned directly by the agent; no separate log file is claimed.
- Signed SMS execution, existing lease and callback-security group: 176 PASS, including four signed SMS cases forwarding into the actual pipeline and installed PostgREST client. Each required-read outage retains pending intake; healthy retry preserves its ID, writes one decision and completes. Verified empty contact/rule reads use the actual profile default.
- Full frozen unit gate: 1,180 files / 14,151 tests PASS in 42.35 seconds, with eight workers under Node 24.21.0.
- Production build PASS: 249 pages, 66-second compile, 103 kB shared first-load JavaScript. Strict post-build types, lint, localization and query audits PASS. Four baseline lint warnings remain; the query audit resolves 486 tables, 77 functions and 140 routes. The build-info artifact contains the exact `eee4ec06` source revision.

Captured full-gate logs are `Temp/bubaly-guardian-policy-final-private-<gate>-20260912.log`. SMS logs are `Temp/bubaly-guardian-policy-sms-baseline-20260912.log`, `Temp/bubaly-guardian-policy-sms-current-20260912.log` and `Temp/bubaly-guardian-policy-sms-integration-20260912.log`. Build-time external reads use deliberately invalid fixture configuration; build success does not verify live provider data. No provider operation, new dependency installation or local preview startup occurred.

## Remaining verification

Conditional communication writes, payload checks and callback-lease checks are separate operations, not a database transaction. They reject detected conflicts but cannot make cross-table ownership or body versions atomic. Callback replay does not guarantee provider redelivery, and no autonomous recovery worker is implemented in this cycle.

Voice and WhatsApp still acknowledge unclaimed callbacks, with the shared callback helper reclaiming errors only after ten minutes. Their durable intake and destination-read failures remain open. More than 1,000 routing rules produces an unavailable result instead of incomplete evaluation. Family timezone, existing regex/time matching and emergency-versus-block precedence also require separate verification.

The communication table permits authenticated family-member inserts. Existing signed-route replay can accept a matching preinserted decided row without establishing its decision authorship. The actor needs advance knowledge of the real SID and exact signed payload, destination family/member, permission to insert there, an unoccupied SID and a genuine claimable callback. Unique SID and the absence of authenticated UPDATE/DELETE permissions prevent replacing an existing legitimate row; the generated intake ID rejects an immediate insertion race, but does not bind authorship on a later retry. Source analysis confirms this pre-existing gap; no live exploitation was attempted. It neither proves cross-family access nor permits forged Twilio signatures.

Replay and a future recovery worker need a service-owned receipt binding the communication ID, SID, family/member, payload and verified decision. Existing `ai_tool_calls` receipts can support that boundary without new SQL. Missing legacy proof must remain unverified or undergo explicitly fresh screening; copying an existing classification into a trusted marker would preserve the gap. An autonomous worker must not promote arbitrary stored communications into authenticated intake. See `AUTHZ-004` in the master audit.

The cc-triggered hosted run now passes on generated merge40eb05d4 with14,312 unit passes and1,055 browser passes plus one child PIN flake that passes on retry. See hosted-merge-evidence.md for exact source provenance. Replay authorship is subsequently repaired in90e59c7d/1aa4d6fb, with private gates passing and new signed HTTP/database tests pending hosted execution; see guardian-replay-checkpoint.md. The broader audit and second full regression remain unfinished; production readiness is NO.
