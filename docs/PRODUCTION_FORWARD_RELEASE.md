# Audited forward release: household modules and AI runtime

Production audit [33986604896](https://github.com/NewWorldVenture/Bubaly/actions/runs/33986604896)
found 441 public tables, all with RLS enabled, but only migrations 0001-0003 in
the Supabase ledger. The 33 tables introduced by 0240-0248 and 0250 were absent.

## Scope and safeguards

The one-time `Supabase reviewed forward release` workflow applies only the
hash-pinned files 0240-0254. It does not claim that older migrations ran.
The original production workflow's unrecorded-history guard remains enabled.

- The manifest targets only the audited Bubaly project.
- Default dispatch is a read-only preview. Applying requires the explicit apply input.
- Preflight compares 113 existing columns, 40 constraints, 37 approval/wallet policies,
  and four helper definitions against the metadata-only audit.
- The same checks run again inside the write transaction under a ledger lock.
- All 15 migrations and their actual ledger entries commit together, including
  0252 INSERT hardening, 0253 explicit client RPC revocation, and 0254 restrictive
  manager guards on five wallet tables. Failure rolls back the entire release.
- A five-second lock timeout prevents an extended lock wait.
- Existing household rows are not deleted or reset. The reviewed upstream migrations
  update GPT conversation provider labels and add a 48-hour expiry to existing
  pending approvals that lack an expiry.
- Table RLS, approval-policy shape, and worker RPC privileges are checked before commit.
- Production default privileges grant EXECUTE directly to anon/authenticated;
  0253 removes those direct grants rather than relying on revoking PUBLIC.
- The audit found older permissive wallet writes alongside manager policies.
  0254 removes those known writes and adds restrictive guards against recurrence.
- Wallet behavior probes run only in isolated Supabase, never against production.
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
the existing GitHub Production credentials (`SUPABASE_PROJECT_REF` and
`SUPABASE_ACCESS_TOKEN` in the environment). Never place private tokens in files.
`node scripts/apply-production-forward-release.mjs --require-applied` is a
read-only proof that the exact baseline plus the pinned release is in the ledger;
it cannot be combined with `--apply`.

Every mode, preview included, first refuses with "Production forward release is
held" while `supabase/migrations/` holds any version above the range pinned in
`supabase/production-forward-release.json` (0240-0254). The repository now holds
migrations above 0254, so today each command stops there, before production is
read, and prints no preview. That is the guard working, not a fault: do not edit
it out. Re-pinning the manifest is a reviewed change; see
`docs/PENDING_PROD_MIGRATIONS.md`.
