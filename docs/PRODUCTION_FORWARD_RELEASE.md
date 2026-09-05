# Audited forward release: household modules and AI runtime

Production audit [33986604896](https://github.com/NewWorldVenture/Bubaly/actions/runs/33986604896)
found 441 public tables, all with RLS enabled, but only migrations 0001-0003 in
the Supabase ledger. The 33 tables introduced by 0240-0248 and 0250 were absent.

## Scope and safeguards

The one-time `Supabase reviewed forward release` workflow applies only the
hash-pinned files 0240-0252. It does not claim that older migrations ran.
The original production workflow's unrecorded-history guard remains enabled.

- The manifest targets only the audited Bubaly project.
- Default dispatch is a read-only preview. Applying requires the explicit apply input.
- Preflight compares 113 existing columns, 40 constraints, five approval/write policies,
  and four helper definitions against the metadata-only audit.
- The same checks run again inside the write transaction under a ledger lock.
- All 13 migrations and their actual ledger entries commit together, including the
  0252 INSERT hardening. Failure rolls back the entire forward release.
- A five-second lock timeout prevents an extended lock wait.
- Existing household rows are not deleted or reset. The reviewed upstream migrations
  update GPT conversation provider labels and add a 48-hour expiry to existing
  pending approvals that lack an expiry.
- Table RLS, approval-policy shape, and worker RPC privileges are checked before commit.
- A fresh metadata audit and the 48 zero-row API checks follow a successful apply.
- Network errors are never automatically retried. Read the ledger to resolve an
  uncertain outcome first. Artifacts contain metadata only and expire in three days.

## Remaining historical work

Versions 0004-0239 remain deliberately unrecorded and must not be bulk-stamped,
renumbered, or replayed. Future production releases need an explicitly reviewed
incremental plan until that historical baseline is reconciled. This recovery
release is not evidence that every historical schema or data migration ran.

## Commands

`node scripts/apply-production-forward-release.mjs` previews the pinned release.
`node scripts/apply-production-forward-release.mjs --apply` applies it using
the existing GitHub Production credentials. Never place private tokens in files.
