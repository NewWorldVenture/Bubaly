# Chat and messaging buildout

This checklist records the selected messaging contract and the remaining acceptance work for the #969 composition of #971. Historical #971 test and build receipts apply to that branch's exact source. They do not establish acceptance of the new composition or the deployed database.

## Selected audience and release contract

- Main's allocation map is preserved: messaging occupies runnable `0475_messaging_conversation_privacy_and_delivery.sql` and `0476_messaging_notifications_preferences.sql`. Bill 0488, feed 0490, approval 0492, private AI copies/quota 0493 and atomic sync 0494 remain in `supabase/reserved/`. A successful test of a held candidate does not promote it or establish production availability.
- Existing conversations retain the union of their recorded `participant_ids` and `member_ids`. Their audience, family and creator cannot be rewritten through conversation settings. Manager status alone does not grant private-history access.
- The canonical whole-family chat is a new, empty conversation. No old group is adopted by name or by matching today's roster. Reapplying the migration retains an already flagged canonical chat. Joining a household does not expose an old private group's history.
- Direct-chat reuse checks both recorded rosters. Requesting a two-person chat cannot silently reuse an older conversation that admits an additional reader through its second roster.
- Missing privacy-critical schema or RPCs produce visible failures. The application does not adopt a legacy group or retry private reads, reactions, receipts or sends through family-wide/raw-write fallbacks. Harmless device-local mute preferences remain available where their exact database object is missing.
- Existing private audiences remain immutable. Group departure and adding readers to historical conversations are not part of this selected settings contract.

## Product acceptance criteria

- Confirmed sends render without waiting for a realtime echo. Lost responses reconcile the original operation; a retry keeps its durable identity. Attachment validation, message limits and edit markers remain enforced.
- Latest messages appear in long conversations, older history can be loaded, and pins/shared-media views can reach beyond the initial page. Drafts and reply targets belong to their conversation.
- Late history, send results, microphone permissions and recorder callbacks cannot update another user, family or conversation. Tracks and timers stop when their owning recorder is discarded or unmounted.
- Replies, reactions, read receipts, edits, deletion, pins and search retain working controls and honest refusal states. Atomic receipt/reaction RPCs derive the caller and preserve other readers' entries. Only the visible thread is marked read.
- Membership admission and service-role retries recheck the actual actor under locks. Reply ancestry stays within the same family and conversation. Parent deletion, membership removal and authenticated/service writes follow the tested locking order or return a retry error without partial mutation.
- Mute preferences affect actual in-app notices. Notices exclude the sender and unauthorized recipients, contain no private message text, and link to the conversation. Chat notices stay outside external email/push selection before batch limits, including cursor wrap.
- Family media remains **PUBLIC under the owner's explicit decision**. Row permissions, attachment-path checks and signed-reference rendering do not establish private bytes in a public bucket. No private attachment URL guarantee or bucket-privacy rollout is claimed here.
- AI web conversations and native history retain ownership, cancellation, persistence status and late-response protections. Stopping a stream does not imply that a previously started action has been undone. Their final composed verification is recorded separately by the owning review.
- Browser acceptance includes narrow touch layouts, keyboard interaction and both themes. Controlled transport fixtures do not replace authenticated Supabase or physical-device acceptance.

## Verification and remaining holds

The local composed messaging receipts include 29 synthetic PostgreSQL concurrency controls, 39 controlled Chromium messenger checks and 71 service/thread/schema cases. The concurrency controls retain the original membership/delete/FK failures and reproduce the old reaction deadlock before checking its correction. The runner's delayed-stderr regression separately proves that complete SQLSTATE diagnostics survive process exit. These are focused source receipts, not a full production catalog audit.

`scripts/verify-messaging-database.mjs` creates its own disposable loopback cluster for migration, audience, notification, storage and lifecycle checks. `scripts/verify-messaging-preserve-access.mjs` requires the exact independently owned data directory before creating synthetic databases. The dedicated workflow runs both messaging browser ownership coverage and service/thread contracts. `tests/boundary-probes-actually-assert.test.ts` verifies that the four separately named messaging probes remain wired to their runner and CI.

`tests/e2e/family-messaging-authenticated.spec.ts` requires a disposable local Supabase stack and `E2E_DURABLE_SESSION=1`; it refuses remote origins. Discovery or a gated skip is not evidence that authenticated delivery, reconnect or Realtime exclusion ran. Its authenticated screenshots/DOM output is excluded from uploaded CI artifacts.

Historical migration 0293 stays byte-for-byte as main shipped it. Migration 0476 checks `notifications.related_id` itself, converts uuid to text, retains text and refuses other types. Its policies avoid a direct dependency on that column so 0293 can replay. The historical byte/type/policy tests and the notification-key verifier retain that separate acceptance contract.

Fresh exact-head hosted checks are required after composition. The public deployment's code identity does not prove the database catalog, ACLs, foreign keys, migration ledger or held RPCs are compatible. Private AI-copy read acceptance remains held with 0493; the runnable automation probe tests its existing write guards, and a separate reserved probe requires the held read guard rather than claiming it exists.

See `docs/PENDING_PROD_MIGRATIONS.md`, `docs/messages-preserve-access.md` and `finalaudit.md` for current holds and dated receipts. No production configuration, hosted DDL, provider messages or money operations are authorized by this checklist. Production readiness remains unverified.
