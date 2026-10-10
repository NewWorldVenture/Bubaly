Exact published composition `745f181dd2f8b2563a043919115c30cffbe9f899`
failed four probes in database CI job
[111548704729](https://github.com/NewWorldVenture/Bubaly/actions/runs/37240663681/job/111548704729).
The receipt/reaction and sender fixtures created chats without recorded
participants. The anchor message seed did the same. Under the selected history
policy those chats are creator-only, so the positive access controls no longer
exercise the guarded writes. The removed-member probe also attempted a scope
column UPDATE that the candidate deliberately denies at the privilege layer.

The probe chats now record their intended synthetic user audiences. A newly
created Seed Chat records the existing synthetic member audience; reseeding an
existing chat does not expand it. The removed-member probe accepts an explicit
privilege refusal as a denied write while retaining its positive read control,
zero-row denial and all other table checks. No application policy is weakened,
no existing audience is backfilled and no boundary probe is skipped.

On an owned PostgreSQL 17.10 cluster, the unchanged receipt and sender probes
fail and their repaired versions pass against the same focused messaging
schema. The exact updated message seed and existing family self-read probe pass.
A later active family member remains unable to read the seeded conversation or
its history after reseeding; the seed still contains exactly 500 messages.
This is a focused synthetic-schema receipt, not the complete migration replay.
The complete database CI must run again. The removed-member probe's full
ten-table interaction remains with that replay.

The bill source also partially populated four documented placeholder locales.
Those catalogs are restored to empty so their complete base-language fallback
continues to supply bill text. Existing catalog completeness and filtered-delete
refusal guards remain intact. The selected locale/document/migration checks
pass **649 tests across four files** under local Node **24.19.0**. Declared Node
**24.21.0** remains a hosted CI requirement.

Prepared `messaging-bill-readonly-preflight.sql` inventories relevant column
defaults, constraints, valid indexes, policies, triggers, function hashes,
overloads/dependencies and effective/default grants. Its statements were
validated in the same focused disposable schema inside a read-only transaction.
No hosted preflight was executed. Missing production catalog evidence remains a
release blocker; this file cannot establish compatibility from source alone.

Final local evidence is in
`C:/Users/Daniel/AppData/Local/Temp/bubaly-message-ci-audiences-7a6816f2d4d74df8a0719be80c5ac280`.
The verified owned cluster on port 55381 was stopped. Two earlier owned startup
attempts encountered Windows process-tree waiting and were stopped before SQL;
the corrected harness waits for the startup process alone. No other cluster or
production state was changed.
