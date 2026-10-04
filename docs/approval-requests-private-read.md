Approval rows hold complete tool arguments, quoted consequences, manager edits
and execution results. The existing family-wide SELECT let unrelated children
read a private message draft through this separate copy even when the chat's
participant policies denied them access.

Unapplied source migration `0477_approval_requests_private_read.sql` adds a
restrictive SELECT guard. Active requesters retain their own rows through the
requester member's account mapping. Active parents and adults retain review
access, including ownerless system approvals. Other household members, foreign
accounts, inactive members and null actors cannot read the row. It preserves
existing restrictive policies, privileges and manager/requester write rules.
Approval review does not grant access to the destination private conversation.

The actual PostgreSQL regression extracts unchanged approval schema and policy
blocks from main `0093`, `0251` and `0255`, applies `0477` twice, and rolls back.
Its control omits `0477` and must fail at the unrelated-child draft assertion.
The fixture also checks different member/user IDs, legitimate equal IDs, an
ID collision belonging to another account under main's unique family/user
membership constraint, wrong family stamps, requester
INSERT RETURNING and cancellation, parent/adult decisions, service access and
inherited restrictions.

Run only against a separately created, disposable localhost PostgreSQL cluster.
Set `APPROVAL_PRIVACY_PG_BIN`, `APPROVAL_PRIVACY_PG_PORT` and
`APPROVAL_PRIVACY_PG_DATA_DIR` to that cluster's client directory, port and exact
data directory, then run `vitest run tests/approval-requests-private-read.test.ts`.
The runner verifies the data directory and port before creating isolated
synthetic databases and removes those databases afterward. Without these
explicit values, PostgreSQL cases skip; the policy contract still runs.

The existing messaging PostgreSQL workflow also runs the standalone
`scripts/verify-approval-private-read.mjs` after its role/race runner against
the same verified disposable PG17 service. It passes explicit client, loopback
port and expected data-directory arguments. Both corrected and old-policy
controls run there independently of Vitest's opt-in environment.

Local receipt: explicit bundled Node `24.19.0` and owned PostgreSQL `17.10`
passed all 23 SQL assertions, including the baseline exposure proof; the
old-policy control failed at the expected private-draft assertion. The focused
Vitest/migration checks passed 6 cases, narrow TypeScript and ESLint passed, and
the workflow YAML parsed. The filename audit found 452 numbered files, no
collisions, and next available version `0478`. Hosted CI uses the repository's
declared Node release; this local run does not replace that hosted check.

Verified SHA256: migration
`db6166c69976b5be3ae0cbffa3ee12ca7ca89eb7ac6c164e980328aa14fea431`,
role fixture `7910837cd4efa4ef12c4adf2210a4ef2f8649c93bc73bb3658e9fe344bc8b69d`,
extracted main baseline
`219e32008e1ddcc5f6de66fa77f933f805f836c2ff14fcc7a30cedfcd13c2277`.

This is based on published source `745f181dd2f8b2563a043919115c30cffbe9f899`.
It has not been applied to a hosted database. Broader copies in AI requests,
context, plans, steps, run summaries/events and tool inputs/results remain a
separate blocker to participant-private AI content. Cached AI ledger replay
also retains its earlier authorization timing limitation. Public attachment
URLs and provider configuration are outside this repair.
