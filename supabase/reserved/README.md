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
`docs/audit/reserved/`, moves back to `docs/audit/` with it. The code that uses
a held migration is written to work without it.
`tests/migration-version-safety.test.ts` checks that a held file never shares a
number with a released migration and never sits below the released sequence.

| File | Reserved for | The app without it |
|---|---|---|
| `0488_a_month_end_bill_keeps_its_day.sql` | bill anchor (#932) | Mark paid writes without `due_day` whenever the due date carries the bill's day. It asks first, or refuses, only for a month-end roll into a shorter month. |
