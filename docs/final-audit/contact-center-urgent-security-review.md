# Contact Center urgent receipt security review

Independent review for INT-002, 2026-09-12. Existing-schema inspection started against the source checkpoint `6094eb04045326fdd18a1a67785188cc805c2612`; root subsequently committed audit documentation as `8b3df5e16ebb6e22d7845849a6a7aa445fa43c5d`. The new delivery implementation is being authored in a separate lane. This note records design evidence and actual-module review as the implementation arrives; source remains evolving until its final freeze. No SQL, live provider requests, credentials, configuration, or production code changed by this reviewer.

## Existing-schema storage decision

`ai_tool_calls` can hold a service-owned, deterministic Contact Center receipt without a schema change. Migration `0250_ai_runtime_core.sql:289–323` supplies a UUID primary key, unique `(family_id,idempotency_key)`, `actor_kind='system'`, JSON `inputs`/`outputs`, attempt and lock fields, and nullable run/request/step/conversation/message references. Its `reserved|succeeded|failed` state can represent reservation and completion while a versioned JSON phase distinguishes queued, dispatching, and uncertain work.

Set `requested_by` and `requested_by_member_id` to null. The SELECT policy at `0250_ai_runtime_core.sql:408–413` then permits only `can_manage_family(family_id)`, which requires an active parent/adult in `0003_functions_triggers.sql:22–29`. There is no authenticated write policy. This is manager-readable storage, not a secret store. The original inbox and contact channel configuration are already family-member-readable under `0214_family_contact_center.sql:68–81`; a bounded copy of the same sender, recipient, body, summary and recovery identity does not introduce broader access. Do not store provider authorization headers, credentials, or raw exception responses.

Neither the inbox nor notifications is an equivalent receipt store. The inbox has no metadata/updated_at and uses a partial global unique `(channel,provider_ref)` index (`0214:36–58`). Notifications have a UUID primary key but no generic JSON data, status, or provider receipt (`0002_tables.sql:405–420`; pushed_at added by `0038_notification_pushed_at.sql`). `sent_at` is the email marker and `pushed_at` is the push marker. A deterministic notification ID with insert-ignore preserves those markers and `is_read`; an ordinary merging upsert can reset them.

## AI consumers and visibility

| Actual consumer | Consequence for a system receipt with null run references |
| --- | --- |
| `lib/ai/runs/store.ts:876`, `loadRecentToolCalls`; `lib/trust/activity.ts` | The Trust activity view selects metadata and `error`, not `inputs`/`outputs`. Keep error text generic. Null run_id gives no invented run link. RLS remains responsible for manager access. |
| `lib/ai/runs/evidence.ts:44–57` | Reads only explicitly supplied run IDs; a null run_id is excluded from completed-run evidence. |
| `lib/ai/runs/controls.ts:225–285` | A retry first opens a real run, validates a real plan step, then queries that step ID. It does not pick up an unlinked receipt. |
| `app/api/cron/ai-runs/route.ts`; `claim_ai_runs` in migration 0250 | Dispatches actual automation runs; there is no scan executing arbitrary reserved tool-call rows. |
| `lib/ai/tools/registry.ts`, `lib/ai/tools/execute.ts:586–597` | An unregistered `contact_center.urgent_delivery` name is denied before any database access. Keep it outside the tool registry. |
| `lib/metric/automatic-capture-server.ts:78–84` | Filters explicit capture tool names and matching resource IDs; the receipt is not proof of another feature's automatic capture. |
| `lib/autopilot/policy-scan.ts:63–66`, `policy-candidates.ts:192–257` | History includes receipt metadata, but policy candidates originate only from decided AI approval groups. A system receipt without such approvals creates no policy. Existing 2,000-call history truncation remains a broader limitation at high volume. |
| `lib/front-desk/school-approval.ts:49–57`; `lib/services/finances/index.ts:839–855` | School recovery uses an exact namespaced approval key; finance validates the exact finance tool and actor. The system receipt does not authorize either action. |

Use a literal `contact_center.urgent_delivery:` prefix for the idempotency key. The generic executor internally accepts a supplied key verbatim (`execute.ts:184–186`), so a bare hash alone is not a strong namespace boundary. Current public request intake hashes client keys (`runs/intake.ts:208`); run steps hash family/run/step/tool (`runs/executor.ts:176`); approval replay hashes its approval context. Validate a loaded receipt's family, tool, actor, null references, payload version and deterministic identity before acting.

Do not call generic `reserveCall`/`finalizeCall`: its stale reservation takeover (`execute.ts:248–264`) uses a state-only predicate for reserved-to-reserved updates, and its finalization (`execute.ts:278`) filters only by ID. Those contracts do not establish safe ownership for an external SMS whose response can be lost.

## Required implementation boundaries

- Persist the bounded recovery receipt before inbox capture. A crash after capture must leave enough durable state for a webhook replay or scheduled drain to finish notification work.
- On an inbox duplicate, validate family and inbound direction as well as channel/provider reference. The inbox unique key itself is global across families.
- An existing inbox row with no corresponding receipt is `legacy_unknown`: old code may already have sent an SMS. Do not automatically resend it. A race loser must load the winner's existing receipt instead of overwriting it with its own legacy classification.
- Claim a queued or confirmed-failure attempt with a unique revision/ownership token. Include that token and the expected phase in every subsequent conditional update after an await. A lost claim cannot commit completion or reset another attempt.
- Persist dispatching before the provider call. Never reclaim dispatching/unknown solely because its timestamp is old. A crash before the call and a crash after provider acceptance are indistinguishable in that state; the honest result is reconciliation required.
- Reread current family/channel configuration before a send. A saved forwarding phone is a recovery snapshot, not authority to keep sending after it is removed, changed or reassigned. Required read failures must remain visible and retryable without provider dispatch.
- Insert deterministic notifications without merging an existing row. Verify an ID collision belongs to the same family/purpose/message. Preserve read, push, and email markers on redelivery. Repair an in-app write failure independently of an already accepted/uncertain SMS.
- Bound scheduled work by an overall deadline and finite batch; exclude held phases from provider retry while allowing notification repair. Confirmed failures must not spin in a hot retry loop or starve newer work indefinitely.

Twilio's [Message resource](https://www.twilio.com/docs/messaging/api/message-resource) distinguishes a valid Message SID and provider acceptance from delivery to a handset. Its [REST API best practices](https://www.twilio.com/docs/usage/rest-api-best-practices) explicitly state that HTTP 429 requests were not processed and may be retried. A fixed-host, manual-redirect, bounded-body adapter should return an accepted receipt only after validating the returned identity. Network timeout, malformed success JSON, redirects and uncertain server errors must not become confirmed nonacceptance. A received rejection can be retried after backoff/configuration repair; a missing final database write after acceptance must retain the dispatching hold.

## Verification performed so far

`node node_modules/vitest/vitest.mjs run tests/tool-registry.test.ts tests/tool-execute.test.ts tests/autopilot-policy-candidates.test.ts --maxWorkers=1`: 3 files / 57 tests passed. `node node_modules/vitest/vitest.mjs run tests/trust-activity-read-boundary.test.ts --maxWorkers=1`: 1 file / 17 tests passed. These exercise the existing registry, unknown-tool denial, executor ordering, policy candidate rules and Trust read/privacy boundary. They do not execute the new receipt implementation, verify deployed RLS, or establish real SMS delivery.

Required next execution cases: concurrent webhook/drain claim; crash after capture; returned and thrown notification failures; accepted SID followed by failed finalization; timeout followed by webhook replay; stale dispatching; legacy inbox without receipt; foreign-family duplicate; revoked forwarding configuration; invalid stored payload; deterministic notification replay retaining read/push/email markers; bounded drain continuation. Live Twilio and deployed database behavior remain external verification dependencies.

## Implementation review and reproduced corrections

`lib/contact-center/urgent-delivery.ts` now uses strict bounded input/output schemas, deterministic receipt and notification IDs, system/null-reference identity validation, and revision-conditional transitions. The revision is included in a JSON containment predicate along with id/family/tool/state. Only a successful claim proceeds to `sendSmsWithReceipt`; ordinary notification repair leaves an in-flight dispatching revision untouched. An accepted result whose final persistence fails stays held. Queued 429 responses have bounded retries; a timeout, HTTP 408 or unverifiable successful response is unknown. Non-429 4xx rejection is terminal in the current bounded implementation.

The API lane repaired the partial-index upsert issue identified during this review: `findInboundMessage` checks exact count and family/channel/reference/inbound direction; `recordInboundMessage` uses plain insert and verifies only a 23505 collision. This source repair does not claim that the deployed schema has been checked.

Independent actual-module regression file: `tests/contact-center-urgent-review.test.ts`. It drives the production capture and delivery modules with synthetic storage and provider responses. The first run reproduced three failures, and the API lane corrected them:

| Trigger | Before | Corrected behavior |
| --- | --- | --- |
| Dispatching receipt plus a thrown required notification storage failure | Returned `unknown`, hiding failed notification repair | Returns `failed` without changing the provider claim revision or sending an SMS |
| Accepted SMS receipt with a missing in-app notification | Created the notification and removed the drain flag but left ledger state reserved | Marks the completed receipt succeeded without repeating the SMS |
| In-app-only receipt with missing notification | Same stale reserved ledger state after repair | Completes the ledger after the notification persists |

A fourth regression verifies that changing an email identity from `notfoo` to `foo` does not authorize sending an older receipt addressed to `notfoo@bubaly.com`. The original substring comparison was replaced with exact parsed-recipient comparison before this case ran; it passed at first execution.

`node node_modules/vitest/vitest.mjs run tests/contact-center-urgent-review.test.ts --maxWorkers=1`: 4/4 pass after the changes, versus 3 failures/1 pass initially. Scoped ESLint and diff check pass. These tests are retained as independent review regressions at the API lane's request.

The final handler review confirms the approved acknowledgment policy: SMS, voice transcription and email retain the urgent attempt outcome, finish independent planner/attachment recovery, then return 503 for failed required storage/routing work. Durable pending/unknown work may be acknowledged as intake; urgent SMS/email auto-replies use translated saved-inbox language and do not claim provider delivery. Receipt errors are now sanitized translated text before persistence, matching the Trust tab's plain-text renderer. The receipt insert also has a five-second deadline.

Final independent integration checks:

- `node node_modules/vitest/vitest.mjs run tests/contact-center-urgent-review.test.ts tests/contact-center-urgent-durability-repro.test.ts tests/contact-center-intake-query-contract.test.ts tests/contact-center-callback-boundary.test.ts tests/cron-dispatch.test.ts tests/cron-dispatch-execution.test.ts --maxWorkers=1`: 6 files / 92 tests pass.
- `node node_modules/vitest/vitest.mjs run tests/contact-center-urgent-execution.test.ts --maxWorkers=1`: 1 file / 16 tests pass. Reviewed its actual worker/cron cases for concurrent in-flight ownership, accepted-but-unpersisted hold, marker-preserving notification repair, current routing revocation, invalid receipt/cursor, fair equal-timestamp traversal, cursor write failure after acceptance, and cron authorization/status.

The cron route authenticates before constructing the service client. Its 110-second hosting limit exceeds the worker's 65-second loop-entry limit plus one bounded final iteration (5-second queue read, 25-second attempt and 5-second cursor write). `scripts/cron-dispatch.mjs` schedules this route every five minutes through `.github/workflows/cron-dispatch.yml`; `vercel.json` contains only the daily 01:00 UTC fallback. Fast recovery therefore depends on the GitHub workflow being enabled on the deployed default branch, an accessible production `CRON_BASE_URL`, and matching `CRON_SECRET`. These deployment conditions were not exercised.

No further material duplicate-send path was found in the reviewed source. Limits remain explicit: provider acceptance is not handset delivery; a killed dispatching/unknown send needs reconciliation; historical rows without receipts are not automatically resent; non-429 rejection and the retry cap require operator attention; a sender-controlled email Message-Id may collide across families under the existing global inbox key (the new code denies the mismatch, rather than migrating legacy identities). The tests execute repository modules and installed SDK request construction with synthetic storage/provider replies. They do not run PostgreSQL/RLS, establish provider credentials, send real messages, or prove a deployed end-to-end workflow.

Reviewed production snapshot at approximately 14:48 UTC on 2026-09-12, before root's combined gate:

| Path | SHA256 |
| --- | --- |
| `lib/contact-center/urgent-delivery.ts` | `129cf3087bcaa97ac431e2eef3fe300ba30526aa8b625c0b8d639a19daba613c` |
| `lib/contact-center/server.ts` | `67129cd0c0a4a21e549ea14b46da1f5a7788f7dbca08deee2c14cf2a2a3fdea0` |
| `lib/guardian/twilio.ts` | `c34540c5dfa39a08bbe832645fdcd290d756b30fbaa64ba7d1faabb4355da166` |
| `app/api/contact-center/sms/route.ts` | `48bd8e500d2a74b9839f7ea90dc1f23b78778da54e3b56c6edd932a54d3975fc` |
| `app/api/contact-center/email/route.ts` | `682a9eeb6a45fa4e3054407347a7d43afb4b8006d12ff72475ed45764506a216` |
| `app/api/contact-center/voice/transcription/route.ts` | `1b8a041d56f19b506118eab8f9a84e67cbc4e6d5811641fd13628b6536a183b6` |
| `app/api/cron/contact-center-urgent/route.ts` | `cc5d0f4e0384a8851cbbd516dd1fb9ce580dec007bc3ba18da996fd92c2df04d` |
