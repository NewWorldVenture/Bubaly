# Chat and messaging buildout

The goal is a complete, reliable Bubaly messaging experience. This checklist covers family messaging, AI conversations, and mobile continuity. Code and tests are authoritative; older messaging documentation predates the existing GIF, audio, and private media support.

## Acceptance criteria

- Family, direct, and group conversations persist and have the correct audience. Whole-family sends never target an arbitrary subgroup. Direct conversations are deduplicated atomically.
- Database rules restrict private conversations, messages, attachments, summaries, and realtime topics to active participants. Sender identity, reply targets, membership changes, and cross-family references are validated.
- Latest messages appear in long conversations. Older history can be loaded without losing the current position. Confirmed sends appear without a realtime echo; reconnects recover missing messages.
- Late reads, writes, recorder permissions, and stream responses cannot cross a user, family, or conversation boundary. Each thread retains its own draft and reply state.
- Replies, reactions, read receipts, edits, deletion, pins, search, and group management have functional controls with honest errors and retries. Only viewed messages are marked read.
- Images, files, GIFs, and voice messages have private access and clear upload failures. Microphone tracks stop on cancel, navigation, and unmount.
- Muting has a durable per-user effect on actual notifications. Notifications exclude the sender and nonparticipants and link to the authorized conversation without revealing private text.
- AI conversations support saved history, recent context, switching, cancellation, error recovery, and persistence status. Stopping the response does not falsely promise cancellation of actions already started.
- Web UI works on narrow touch screens, keyboard-only input, and both themes. Native mobile conversation history is not lost on navigation or refresh.

## Implementation tracks

1. Database authorization and atomic messaging operations, including private storage and realtime.
2. Family messenger state ownership, history, confirmed sends, receipt/reaction concurrency, and accessible controls.
3. AI conversation ownership, streaming lifecycle, pagination, and native history parity.
4. Service integration, exact-operation idempotency, notification delivery, and end-to-end verification.

## Verification requirements

- Run real local PostgreSQL role probes for participant, same-family nonparticipant, removed member, other-family user, and anonymous access. Check cross-family message references, cross-thread replies, concurrent operations, and private attachment paths.
- Run the actual family messenger component in browser fixtures with controlled transport boundaries. Hold responses to exercise thread switching, absent realtime, retries, long history, and mobile read behavior. These fixtures do not replace database or authenticated delivery tests.
- Exercise AI history and streaming with deterministic provider responses, including late data, partial failure, cancellation, and save failure.
- Run focused tests, typecheck, lint, migration audit, and a build. Record environment limitations rather than calling unrun checks successful.
- Do not send real SMS/email/push, change production data, or deploy migrations merely to test. External communications inbox logging is a separate surface from internal chat.

## Current evidence

- Messaging service suite: 20 tests for canonical routing, active identity, authoritative participants, private activity text protection, valid reply targets, and exact-operation retries.
- Real PostgreSQL 17 (Windows) and 18 (Linux): participant/nonparticipant/removed-member/anonymous boundaries, canonical/DM creation, reply and sender integrity, private media and realtime authorization, notices/mute/deletion, group departure, archived-send rejection, two-session races, migration reapplication and repeated seed scripts pass. Run `node scripts/verify-messaging-database.mjs --bin "C:/Program Files/PostgreSQL/17/bin"`; it creates and removes only its own local cluster.
- Family messenger: 14 real-component Chromium tests pass with the production Tailwind stylesheet, including confirmed sends without realtime, lost-response retry, late history/send/microphone responses, thread drafts, hidden-mobile read boundaries, history galleries, leave/archive, and light/dark mobile/desktop overflow and text contrast. Transport/auth boundaries are controlled; this is not a hosted Supabase integration test.
- AI web lifecycle: 7 Chromium tests pass for conversation ownership, stale requests, stream interruption/persistence errors, stopping, and StrictMode submission. Native history/owner/voice/i18n checks pass (152 focused tests), with full native TypeScript validation against the matching Expo dependencies. No physical-device runtime check was performed.
- In-app notice transport: 5 tests prove that chat notices cannot enter email/push delivery or starve unrelated notices behind a large backlog, including push cursor wrap.
- Production webpack build passes. Web TypeScript, targeted lint, translation gate, Supabase query audit and migration filename audit pass. A Windows-only loader-path bug was fixed using `fileURLToPath` so the normal webpack build could run locally.
- Final complete native Linux unit run: **24,214 passed, zero failures, 72 skipped/todo**. The initial Windows run exposed Unix-shell/POSIX-path assumptions and stale message-source guards; message guards now match the checked-write/RPC contract, and the unmodified platform-sensitive tests were verified on Linux rather than weakened.

## Delivery boundaries

- No logo changes, shared navigation changes, production writes, migration application or external messages are included.
- Migrations 0475 and 0476 must precede the matching application release. See `docs/PENDING_PROD_MIGRATIONS.md`; production migration execution remains human-owned.
- Notifications are in-app only. Muting withdraws unread chat notices and suppresses future ones; it does not forge read receipts.
- Search returns the latest 100 matching messages and asks the user to refine. Full history, photos and pins have independent pagination.
- Browser fixtures and SQL probes verify different boundaries. A hosted two-user smoke test, real native-device check and the complete CI migration replay remain release checks, not completed production validation.
- Hosted Realtime caches private-channel authorization until JWT refresh/expiry. The probes verify current database/join authorization, not immediate socket eviction. Typing broadcasts carry no message content; the operator should disable public Realtime channels and verify private-channel configuration for the release.
