# Messaging participant preservation candidate

The owner selected preservation of existing participant access and a new, empty
Family Chat. The composed source includes main `d4ec0b65`, the recurring-bill candidate at
0475, participant preservation at 0476 and private approval reads at 0477.
It has not been applied to a hosted database.

`supabase/migrations/0476_preserve_messaging_participants.sql` follows the
unapplied bill migration at generation 0475 in the composed release candidate.
The earlier provisional messaging number 0492 was changed before publication.
Closed messaging PRs and active authors' migration files were not changed.
Production catalog and migration history still require separate verification
before either candidate can be released.

Existing conversations, rosters, messages and metadata are preserved during
migration. Names, full household rosters and creation order never promote a
legacy group. The canonical RPC inserts a separate row, with a unique family
index preventing duplicate canonical creation under concurrent callers. The
chat contains no adopted messages. Future active household members can access
that canonical chat; they do not inherit unrelated legacy history.

For a legacy thread, an active household member retains access when either
their member ID occurs in `participant_ids` or their account ID occurs in
`member_ids`. Both recorded audiences are honored, including historical
disagreements between them. When both lists are empty, only the active creator
has access. Deactivation suspends access; reactivation restores the recorded
grant. Authenticated callers cannot rewrite the audience, move identities or
set the canonical flag. Changing a thread's audience requires a new conversation;
this candidate does not add the old branch's leave or invitation APIs.

Conversation and message RLS enforce these boundaries on direct table access.
Message policies also require an invoker-visible conversation in the same
family, so inherited restrictive conversation policies and malformed historical
family stamps cannot expose a thread. Existing restrictive policies, sender
ownership guards and per-person receipt/reaction guards remain in place.

The UI and service use the canonical RPC without falling back to an arbitrary
group. The service carries its explicit actor to an atomic send RPC, which
revalidates the active membership, conversation audience and reply target under
locks. Table reads and insertion remain invoker operations. Only the actual
service SQL role may act without a user, and that system actor may send only to
the canonical chat. A JWT role claim does not grant that authority. An absent
canonical, send or retry-probe RPC is a visible error, with no raw-read or
raw-insert retry. Retry reads use the same actor and conversation locks and
compare the exact sender, text, kind and nullable reply. A deterministic match
in the ten-minute window is a natural retry check; it is not a durable key or an
exactly-once guarantee. Shared
activity descriptions omit message content.

The AI tool's natural key now includes reply identity; a synthetic key comparison
showed that different replies otherwise collide. Current public assistant calls
are keyless, while durable steps and approvals supply explicit keys, so this is
a registry gap fix rather than a reproduced public loss of intent. A succeeded
AI ledger replay is a separate cached path after the executor's active-owner
scope check; it bypasses the service and its retry RPC. This candidate does not
make that earlier authorization check atomic with the cached result read, and
no public exploit of that timing limit was reproduced.

Message-table audiences also do not govern copies in `ai_tool_calls`: its
existing policy lets household managers read tool inputs and outputs, which
include message content. This candidate preserves message-table access without
changing that separate ledger policy or claiming those copies are participant
private. Public attachment URLs remain a separate limitation below.

Scheduled ownerless runs keep their verified system actor through `scopeFor`.
Member-owned runs remain AI acting for the requester, with the existing run
ownership and active-membership checks. This corrects the routine caller's actor
binding; it does not relax the message service or database authorization.

Family parents are locked before memberships and conversation/message targets.
Statement guards lock the authenticated caller's active households in family-ID
order; family deletion takes exclusive parent locks in that same order. This
prevents cascades from inverting the lock order of concurrent sends, edits or
deletes, including callers active in multiple households. The tradeoff is
contention across those active households. Service calls without `auth.uid()`
lock only their explicit target family before its acting membership.

Membership lifecycle guards acquire authenticated active-household parent
locks before membership rows. Privileged/FK/manual inversions use nonblocking
admission of actual old/new parents and return SQLSTATE 55P03 when the household
is changing; callers must retry the transaction. They preserve real dirty-marker
updates and do not swallow deadlocks or authorization errors. The focused fixture
includes the actual lifecycle triggers and membership identity constraints, but
does not establish compatibility with every migration or the hosted catalog.

The browser rejects obsolete thread loads and removed-channel callbacks after
family, user or thread changes. It also rejects events stamped for a different
family or conversation. Read-receipt fallback is limited to an absent RPC;
authorization and transport errors do not trigger row-by-row retries.
Failed sends also retain their original family, user and thread scope: obsolete
responses cannot restore private drafts/replies or release a newer send's busy
state. GIF, upload, recording and presence callbacks follow that same scope.

The `family-media` bucket remains PUBLIC, as requested. This candidate does not
make known public attachment URLs private, alter storage policies, configure
Realtime authorization or prove hosted provider behavior. The wider messaging
goal remains subject to those constraints and production verification.

Run the synthetic authorization fixture in an empty disposable PostgreSQL DB:

```powershell
& '<postgres-bin>/psql.exe' -h 127.0.0.1 -p <owned-port> -U postgres -d <empty-synthetic-db> -v ON_ERROR_STOP=1 -f tests/fixtures/messaging-preserve-access.sql
```

The fixture models the relevant main schema, applies main receipt/sender guards
and both candidate replays, then tests real authenticated/service roles. It also
seeds an unsafe old canonical overload and verifies its retirement. By default
the transaction rolls back. It is a focused schema fixture, not a replay of all
main migrations or evidence about the production catalog.

The concurrent checks verify the connected postmaster's exact data directory
before creating temporary databases, observe actual lock waits and remove those
databases afterward:

```powershell
node scripts/verify-messaging-preserve-access.mjs --postgres-bin '<postgres-bin>' --port <owned-port> --expected-data-dir '<owned-disposable-data-directory>'
```

The dedicated workflow `.github/workflows/messaging-preserve-access.yml` runs
the fixture and 25 separate-session checks in a disposable PostgreSQL 17 service,
independently checks its container and data directory, and uses the declared
Node release. The checks include a failing old-policy deadlock control and real
membership dirty-marker/auth-user-cascade behavior. The earlier 17-check source
passed hosted CI at `745f181dd`; this expanded composition still needs fresh CI.
A second standalone SQL step exercises requester/manager approval reads, with
an old-policy failure control; it does not rely on an opt-in Vitest test.

The browser suite `tests/e2e/messaging-preserve-access.spec.ts` mounts the real
React module and Supabase SDK with synthetic transport and channel events. It
does not start an app server or call hosted Auth, Storage, Realtime or providers.

During initial local setup, port 55441 was already occupied by a pre-existing
meal-review cluster. A setup command accidentally created a new empty
`synthetic_messages` database there after the attempted local server start
failed. No schema, data or stop/drop operation followed on that cluster. All
messaging SQL verification ran on the separate owned cluster at port 55443;
independent review used another owned cluster at port 55445.
