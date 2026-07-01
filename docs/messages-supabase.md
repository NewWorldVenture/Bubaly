# Messages — Supabase wiring & seed

The `/dashboard/messages` page (Family Messenger) redesigned to match the product
mock: a page header, a tabbed conversation list with previews + unread badges, a
message thread, and an **About this chat** panel (members with presence, shared
photos).

## Page & components

| Concern | File |
| --- | --- |
| Route | `app/(app)/dashboard/messages/page.tsx` |
| UI module | `components/modules/messages-module.tsx` |
| Pure helpers (tested) | `lib/messages/overview.ts` |
| Unit tests | `tests/messages-overview.test.ts` |

`lib/messages/overview.ts` holds the deterministic, unit-tested logic:
`convMatchesTab`, `previewText`, `isUnread`, `shortTime`, `summarizeConversations`.

## Supabase tables (existing, RLS-enabled)

- **`family_conversations`** — one row per chat. `kind ∈ (group, direct,
  announcement, channel)`, `avatar_emoji`, `description`, `is_archived`,
  `member_ids` (auth user ids), `participant_ids` (family_member ids),
  `last_message_at` (kept current by an `AFTER INSERT` trigger on messages).
- **`family_messages`** — one row per message. `kind ∈ (text, image, file,
  voice, poll, announcement)`, `content`, `attachment_*`, `reactions` (jsonb
  `{emoji: [userId]}`), `read_by` (uuid[]), `is_pinned`, `reply_to_id`,
  `deleted_at` (soft delete), `created_at`.

RLS on both tables is family-scoped via `public.is_family_member(family_id)` for
SELECT/INSERT/UPDATE/DELETE. No public or anonymous access.

## What's wired (no mock data)

- Read conversations + messages (realtime `postgres_changes` for both).
- Per-row **last-message preview** + **unread badge** — one bounded scan
  (`summarizeConversations`), refreshed on every conversation change.
- **Tabs** All / Direct / Groups / Announcements + **filter** (unread-only,
  show-archived) + **View archived**.
- Send text; send **image/file** (Supabase Storage bucket `family-media`, with
  orphan-cleanup on failed insert); **reactions**, **reply**, **pin**,
  **soft-delete** (own messages).
- **Presence** — a realtime presence channel powers the green "online" dots and
  "Active now".
- **About panel** — group info/description, member roster with roles + presence,
  **Shared Photos** (image messages in the thread), and actions: Add (new chat),
  Search (focus), **Mute** (device-local, persisted), Settings (→ members).
- **New Message** — multi-select people / smart groups / DM de-duplication.

Actions that require infra we don't have yet (voice/video calling, GIF picker,
voice messages) surface an honest toast rather than failing silently.

## Migration

`supabase/migrations/0108_messages_enhance.sql` (additive, idempotent):

- adds `family_conversations.description` and `family_conversations.is_archived`
- widens the `kind` check to include `announcement` + `channel`
- adds list/scan indexes

Apply locally with `npm run db:push` (or `supabase migration up`). Apply to prod
via the Supabase dashboard / your normal migration flow **before** running the
seed, since the seed writes `announcement` + `is_archived` rows.

## Seed (520 rows)

`supabase/seed_messages_one_family.sql` seeds **520 `family_messages`** across
~13 conversations for one family (default: the active family of
`newworldventurellc@gmail.com`, `92298eb2-1a9e-4bdc-9361-677b6c01b499` — change
`v_fam`/`v_email` at the top if needed).

Coverage: every conversation kind (group / direct / **announcement** /
archived), every message kind (text / image / file / announcement), reactions,
pinned, **read + unread** (drives unread badges), and timestamps spanning ~12
days including **today** (so the Today divider renders).

It first re-asserts family-scoped RLS on both tables (drift-safe), then reuses
existing seed conversations (matched by family + name + creator) and replaces
messages tagged `sender_avatar = 'seed:messages'` — so it is **idempotent** and
never touches your real conversations.

### Run it

```bash
npm run db:seed:messages
# or:
psql "$SUPABASE_DB_URL" -f supabase/seed_messages_one_family.sql
# or: paste into the Supabase SQL editor and Run
```

### Verify

Open `/dashboard/messages` and hard-refresh. You should see the conversation
list with previews + unread badges, working tabs, a full thread with reactions
and a file/photo card, and the About panel with members + shared photos.

## Environment

No new environment variables. Uses the existing Supabase client/anon config and
the `family-media` storage bucket already used by Photos.
