# Family Messenger setup and verification

`/dashboard/messages` is Bubaly's internal family chat, not carrier SMS. It uses
authenticated Supabase database, private Storage and Realtime connections. The
chat buildout requires migrations 0475 and 0476 before the matching application
release. Production migration execution remains human-owned; see
[production rollout requirements](PENDING_PROD_MIGRATIONS.md).

## Implementation

| Concern | Source |
| --- | --- |
| Route | `app/(app)/dashboard/messages/page.tsx` |
| Conversation UI | `components/modules/messages-module.tsx` |
| Thread ownership and reconciliation | `lib/messages/thread-state.ts` |
| Preview and grouping helpers | `lib/messages/overview.ts` |
| Server and AI sends | `lib/services/messages/index.ts` |
| Private media resolution | `lib/storage/use-family-media.ts` |
| Notification destination | `lib/notifications/actions.ts` |

`family_conversations` stores kind, metadata, archive state and participants.
`is_family_chat` identifies the canonical whole-family conversation. A nonempty
`participant_ids` roster is authoritative; legacy `member_ids` is the fallback.
Active household membership is required in addition to private-thread membership.
An adult role alone does not grant access to somebody else's private thread.

`family_messages` stores text/media, reply targets, reactions, receipts, pins,
soft-deletion and edit timestamps. `idempotency_key` identifies a send operation;
two separate messages with identical words are not duplicates. RLS and triggers
validate the conversation/family/sender boundary. Only senders edit/delete their
messages; users can modify only their own receipt or reaction entries.

`family_conversation_preferences` stores each participant's durable mute choice.
New messages create recipient-only, content-free in-app notifications, excluding
the sender and muted people. Viewing messages settles their notices; muting
withdraws unread notices without pretending the messages were read. These notices
are deliberately excluded from email and push dispatch.

## Supported controls

- Family, direct and subgroup creation with atomic canonical/DM deduplication.
- Newest-first history loading, older pages, confirmed sends without a realtime
  echo, retry reconciliation, and reconnect recovery.
- Per-thread drafts/replies/edits, multiline keyboard composition, reactions,
  viewed-message receipts, deletion and pins.
- Conversation and message search; message search returns the latest 100 matches
  and asks for refinement. Photos and pinned messages have separate full-history
  pagination rather than depending on the currently loaded thread window.
- Images, files, GIFs and recorded voice messages with retry/discard behavior and
  microphone cleanup on cancel, navigation or unmount.
- Conversation settings, participant management, confirmed group leave and
  shared archive/restore. Archived conversations preserve readable history and
  reject new sends. The canonical family chat cannot be left in the UI.
- Responsive desktop/mobile layouts in light and dark themes.

Voice/video calls are not provided by this messenger.

## Storage and realtime

New uploaded objects use
`{family_id}/messages/{conversation_id}/{sender_user_id}/{unique_filename}` in the
private `family-media` bucket. A sender can access their staged upload; recipients
need access to the conversation and a live message referencing the object.
Legacy references are authorized through their message rows. Media is rendered
through authenticated signed URLs, not a raw public Storage URL.

Database changes use independently owned channels. Typing broadcasts use private
`messages:{conversation_id}` topics with participant authorization. Hosted
Realtime caches channel authorization until token refresh/expiry, so SQL access
revocation is not immediate eviction of an already-connected socket. Previously
issued signed URLs retain their expiry semantics. Verify private-channel settings
and disable public Realtime access during the operator-managed rollout.

## Local seed and verification

`supabase/seed_messages_one_family.sql` creates 520 tagged example messages across
the canonical chat, themed groups, announcements, archived history and DMs. It
preserves installed RLS policies. Reruns replace tagged messages, reuse matching
conversations, and can update their metadata, including the canonical chat.
**Use a disposable local database only; this is not a production-data-safe seed.**
Review the target family/account resolution near the top before running it.

The dedicated verifier creates and removes its own loopback-only PostgreSQL
cluster. It exercises actual migrations, role boundaries, privacy, notification
and group lifecycles, concurrency, migration reapplication and repeated seeds:

```powershell
node scripts/verify-messaging-database.mjs --bin "C:/Program Files/PostgreSQL/17/bin"
```

On Linux, pass the installed version's bin directory, for example
`--bin /usr/lib/postgresql/16/bin`. No production URL or credentials are accepted.

The controlled browser fixtures use the real React components and production
stylesheet but replace transport boundaries. They complement database probes;
neither alone proves a hosted multi-user session. See the current evidence and
remaining release checks in [the buildout record](chat-messaging-buildout.md).

No new application environment variables are required. Existing authenticated
Supabase configuration and the private `family-media` bucket are used.
