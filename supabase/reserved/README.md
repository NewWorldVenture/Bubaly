# Reserved migrations, held until their number comes up

Each file here is a migration whose number is **reserved** for it in the
allocation map. It cannot be released yet, because that number is above the
next free one (owner decision of 2026-10-04; see "Numbering from `0475` on" in
`docs/PENDING_PROD_MIGRATIONS.md`).

**Nothing here is applied.** Only `supabase/migrations/` is read by:
- `supabase db push`;
- the CI replay (`docs/audit/pg-bootstrap.sh`);
- the migration audit.

A file here moves into `supabase/migrations/` under its reserved number once
every number below it has landed. Its probe, held alongside it in
`docs/audit/reserved/`, moves back to `docs/audit/` with it. Code dependent on a held RPC fails visibly when the RPC is absent.
That refusal does not provide the held behavior or prove production readiness.
`tests/migration-version-safety.test.ts` checks that a held file never shares a
number with a released migration and never sits below the released sequence.

| File | Reserved for | The app without it |
|---|---|---|
| `0488_a_month_end_bill_keeps_its_day.sql` | bill anchor (#932) | Unknown legacy anchors require an explicit choice. Writes refuse if an older schema would lose the original anchor; proven non-clamped days may advance safely. |

| `0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql` | atomic feed claim | Missing RPC refuses writes. |
| `0492_approval_requests_private_read.sql` | approval privacy | Production policies remain a rollout hold. |
| `0493_ai_copy_private_read_and_quota.sql` | AI privacy and usage | Missing count RPC refuses capped Free requests. |
| `0494_sync_atomic_pull.sql` | atomic sync | Missing RPC refuses writes and preserves cursor. |

Production SQL application uses `--require-runnable-rpcs` to refuse a release
whose called RPCs exist only in held SQL. Ordinary source checks and read-only
production metadata verification remain available; they do not prove readiness.
