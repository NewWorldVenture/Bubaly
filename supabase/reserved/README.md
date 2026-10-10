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
| `0496_a_childs_xp_is_awarded_by_a_parent.sql` | kid progress award functions (for #981; requested on #771 in comment 6089394563, confirmed as a held source and probe reservation in #981 comment 6092383149) | A child or teen can award themselves any XP and rewrite their own streaks through 0341's `SECURITY DEFINER` functions, which 0354's manager-only `kid_progress` policy does not reach. Proven by `.github/workflows/kid-progress-award-runtime.yml`. |
| `0497_a_childs_wallet_and_guardian_number_stay_in_one_family.sql` | family-scoped references, second wave (for #981; requested on #771 in comment 6092501825, confirmed as a source-only reservation in #981 comment 6092625435) | A family's Guardian profile, gift link, pay handle, child wallet or medication schedule can name another family's member, child wallet or medication, and a service-role consumer acts on it (Guardian dials that member; the gift page names that child; card issuing names that child to Stripe; the morning brief counts that family's medication as this family's). Wires 0311's `reference_shares_family()` onto all five. Proven by `.github/workflows/family-reference-wave-two-runtime.yml`. |
| `0498_a_guest_cannot_feed_the_calendar_or_rewrite_a_grocery_list.sql` | guest guard on two more tables (for #981; requested on #771 in comment 6094699645, confirmed as a held source and probe reservation in #981 comment 6094770726) | A guest can add a calendar feed and can create, rename and delete grocery lists. The nightly service-role sync can import a planted feed's events only once the held 0490 exists and the fetch and parse succeed; the proof covers the rows, not that chain. Feeds already planted are not removed (residual, the importer owner's). Wires 0464's `household_write_is_not_a_guests()` onto `calendar_feeds` and `grocery_lists`. Proven by `.github/workflows/guest-household-runtime.yml`. |
| `0499_a_stored_file_answers_to_its_own_familys_rows.sql` | `documents` bucket write rule (for #981; requested on #771 in comment 6094859264, confirmed as a held source and probe reservation in #981 comment 6094986591) | A child, teen, caregiver or guest can replace, move or remove the insurance card images only a manager may save; a guest can rewrite the bytes behind a household document; a non-manager can upload at a sensitive document's missing path; and a row planted by another family hides a family's own file from it. Makes the bucket's write policies follow the row of the object's own family. Proven by `.github/workflows/stored-file-rows-runtime.yml`. |
| `0500_a_reward_request_is_the_rewards_own_snapshot.sql` | reward request snapshot, 0308's ticket guard completed (for #981; requested on #771 in comment 6094977772, economy scope added in 6095050742, confirmed as a held source and probe reservation in #981 comment 6095082508) | A child can queue a request the parent reads as "New bike · 1 pts" by naming no reward, another family's reward, or a cheap reward under the bike's title, or by re-pricing or retitling their own pending request; a member of two families can move a request, or file one, across them; in the token economy, by naming a cheap reward under the bike's title. Replaces the bodies of 0308's `reward_redemption_cost_guard` and 0428's `economy_redemption_request_guard`. Proven by `.github/workflows/reward-snapshot-runtime.yml`. |
| `0501_one_member_one_vote_in_two_households.sql` | member binding on four vote tables (for #981; requested on #771 in comment 6095180270, confirmed as a held source and probe reservation in #981 comment 6095247473) | A member of two families (a child of two households) can vote a second time in a family poll, a dinner vote and a watchlist, and RSVP twice, under their member id from the other family. Wires 0311's `reference_shares_family` onto `member_id` of the four tables. Proven by `.github/workflows/one-member-one-vote-runtime.yml`. |
| `0502_a_chore_with_assignments_is_a_managers_to_remove.sql` | chore delete guard, 0374 at the parent (proposed for #981; requested on #771 in comment 6097049650, not yet confirmed) | A child can erase a sibling's approved points, or clear the chore board, by deleting the chore: `chore_assignments.chore_id` cascades past 0374's manager-only delete. Adds a BEFORE DELETE guard on `chores`. Proven by `.github/workflows/chore-cascade-runtime.yml`. |

Production SQL application uses `--require-runnable-rpcs` to refuse a release
whose called RPCs exist only in held SQL. Ordinary source checks and read-only
production metadata verification remain available; they do not prove readiness.
