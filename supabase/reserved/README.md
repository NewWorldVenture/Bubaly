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
| `0495_a_member_invited_back_gets_what_the_invite_grants.sql` | invite rejoin role and kid-login admission (DB-RPC-001; reserved for #981, confirmed in its comment 6089092821) | A removed member who accepts a new invite gets their OLD role back, not the invite's; a parent invited back as a guest is a parent again. A kid login can accept another family's invite (the join page refuses one on the synthetic address meanwhile; a direct RPC call is not stopped). A kid login is recognised only from the account itself (its synthetic address, or the server's `app_metadata` mark), never from a `child_logins` row or a membership. Proven by `.github/workflows/invite-rejoin-role-runtime.yml`. |
| `0496_a_childs_xp_is_awarded_by_a_parent.sql` | kid progress award functions (proposed for #981; requested on #771 in comment 6089394563, not yet confirmed) | A child or teen can award themselves any XP and rewrite their own streaks through 0341's `SECURITY DEFINER` functions, which 0354's manager-only `kid_progress` policy does not reach. Proven by `.github/workflows/kid-progress-award-runtime.yml`. |
| `0497_a_childs_wallet_and_guardian_number_stay_in_one_family.sql` | family-scoped references, second wave (proposed for #981; requested on #771 in comment 6092501825, not yet confirmed) | A family's Guardian profile, gift link, pay handle, child wallet or medication schedule can name another family's member, child wallet or medication, and a service-role consumer acts on it (Guardian dials that member; the gift page names that child; card issuing names that child to Stripe; the morning brief counts that family's medication as this family's). Wires 0311's `reference_shares_family()` onto all five. Proven by `.github/workflows/family-reference-wave-two-runtime.yml`. |
| `0498_a_guest_cannot_feed_the_calendar_or_rewrite_a_grocery_list.sql` | guest guard on two more tables (proposed for #981; requested on #771 in comment 6094699645, not yet confirmed) | A guest can add a calendar feed, whose events the nightly service-role sync imports into the family calendar, and can create, rename and delete grocery lists. Wires 0464's `household_write_is_not_a_guests()` onto `calendar_feeds` and `grocery_lists`. Proven by `.github/workflows/guest-household-runtime.yml`. |

Production SQL application uses `--require-runnable-rpcs` to refuse a release
whose called RPCs exist only in held SQL. Ordinary source checks and read-only
production metadata verification remain available; they do not prove readiness.
