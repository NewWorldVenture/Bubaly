import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditMigrationVersions,
  KNOWN_DUPLICATE_MIGRATIONS,
} from '../scripts/audit-migration-versions.mjs';

describe('Supabase migration filename safety', () => {
  const audit = auditMigrationVersions();

  // The 17 historical collisions are gone — every group was renamed to a
  // unique version preserving apply order. KNOWN_DUPLICATE_MIGRATIONS is now
  // empty and must STAY empty: it is the escape hatch that let duplicates
  // accumulate, and re-populating it to quiet a red audit is how they came
  // back the first time.
  it('has no duplicate versions at all, and no escape hatch left open', () => {
    expect(audit.unexpectedDuplicates).toEqual([]);
    expect(audit.duplicates).toEqual([]);
    expect(KNOWN_DUPLICATE_MIGRATIONS).toEqual({});
  });

  // Why this matters beyond tidiness: supabase_migrations.schema_migrations has
  // a PRIMARY KEY on version, so it cannot record two files numbered 0010. That
  // is a hard blocker for Supabase branching AND for the production ledger
  // repair, both of which replay the history into that table.
  it('gives every migration a version the ledger can actually record', () => {
    const seen = new Map<string, string>();
    for (const entry of audit.entries as { name: string; version: string }[]) {
      expect(
        seen.has(entry.version),
        `${entry.version} used by ${seen.get(entry.version)} and ${entry.name}`,
      ).toBe(false);
      seen.set(entry.version, entry.name);
    }
  });

  // The de-duplicated files carry a 5th digit that orders them within their
  // generation (00100 and 00101 both live in 0010). nextVersion reads the first
  // four digits, so those do not drag the next free number up to 1422.
  it('points new migrations at the next unused version', () => {
    // Bumped whenever a migration lands — 0418 pins what the one public bucket
    // accepts. Stating it rather than deriving it is
    // the point: the number is how a new migration announces itself, so a file
    // that quietly reuses one, or a rebase that drops one, fails here.
    //
    // 0318 guardian safety config is manager-only (AUTHZ-005); 0319 the
    // social-access DELETE grant; 0320 the audit_logs actor pin; 0321 the
    // family-erasure indexes. The last three arrived from the audit branch,
    // which had numbered them 0296, 0300 and 0301 before main claimed those —
    // this pin is exactly what surfaced that six-way collision on the merge.
    // Three of that branch's six were dropped rather than renumbered, because
    // main had already fixed the same subjects: family_credentials (0296),
    // sensitive tables incl. child_logins (0297) and invites (0298).
    //
    // 0322 the five wallet side-tables (babysitter_profiles/_payments,
    // gift_links, gift_payments, compliance_disclosures), whose server actions
    // in app/(app)/wallet/actions.ts gate on isManager while 0088's blanket
    // `FOR ALL … is_family_member` did not; 0323 the three safety records
    // (family_emergency_contacts, family_emergency_plans, guardian_suggestions)
    // — the first two named in lib/family/actions.ts's MANAGER_ONLY set, the
    // third the table that FEEDS the contacts 0318 had already closed, so a
    // child could retarget a pending proposal and let a parent's approval apply
    // it. Both moved the number by one file each; neither renumbered anything.
    //
    // The same census closed five more files, one subject each, and none of
    // them renumbered anything either. 0324 the Pay-ID handles and the savings
    // goals — the last two of 0088's fourteen-table DO loop, one deciding where
    // /pay/<handle> sends an outsider and the other feeding `wallet_fund_goal`
    // the wallet it debits; 0325 the digital-twin profiles and the dashboard
    // settings (manager-only in lib/family/actions.ts and customize-actions.ts)
    // plus `dashboard_layouts`, which is NOT uniform and gets a scope-shaped
    // guard instead, because a member may legitimately write their own
    // `scope='user'` row; 0326 the chore-dispute resolution, a BEFORE trigger
    // in the line of 0222/0223/0295 because RAISING a dispute is open by design
    // and only the decision is a manager's; 0327 the Autopilot queue, where the
    // census's "manager-only" reading was wrong — /api/autopilot/scan and the
    // resolve action are plan-gated, never role-gated, so only DELETE (which no
    // app path performs) and the `resolved_by` attribution are closed; 0328 the
    // `wallet_audit_logs` actor pin, which is 0320's repair applied to the
    // money-domain sibling it did not reach.
    //
    // Five more from the same census, one subject each, none renumbering
    // anything. 0329 `family_automation_runs`: 0251 split 0022's `FOR ALL` and
    // narrowed UPDATE/DELETE, and 0252/0255 pinned the §10 `state` column, but
    // the ORIGINAL `status text NOT NULL DEFAULT 'pending'` was never pinned —
    // so a child's INSERT landed in the parent's "Pending approvals" list
    // carrying the child's own `summary` and `metadata`, and the "Do it" button
    // stamped whatever `approval_requests` row that metadata named. The blocker
    // 0251 recorded for tightening INSERT (plan acceptance ran on the member's
    // client) is gone: `planAcceptedAction` writes with the service client.
    // 0330 `playbook_suggestions`; 0331 the AI score column, which is not the
    // child's to write; 0332 the dialler, where a child does not choose the
    // number Bubaly calls; 0333 `parent_approvals.requested_by`, the one column
    // saying whose ask it is — 0320's repair applied a third time, restrictive
    // rather than restated so 0252's conditions stay where the source-level
    // ratchets in tests/ai-insert-authority.test.ts can still read them.
    //
    // 0335, 0336 and 0338 — and the TWO GAPS, which are the point of this
    // paragraph. A census measured 247 tables still taking a write from any
    // household member and triaged 41 of them as suspect because a file that
    // writes them also carries an `isManager` gate. Four were verified one at a
    // time. TWO WERE NOT DEFECTS and no migration was written: `wallet_cards`,
    // because `addCardAction` has no role gate at all — the application never
    // claimed the rule the census inferred; and `family_decisions`, whose only
    // writer is a client module with no manager rule anywhere. 0334 and 0337
    // are therefore permanently unused, and that is recorded rather than
    // renumbered, because a gap says "this was looked at and refused" where a
    // renumber says nothing. CENSUS-002 is what happens when a name on a triage
    // list is taken for a verdict.
    //
    // 0335 the locator pair (`member_locations`, `location_events`), where the
    // gap is SELF-ONLY vs role-blind rather than manager-only — a child could
    // take a parent off the family map and file an arrival in their name at
    // coordinates of their choosing; 0336 `home_assets`, where
    // components/modules/home-module.tsx expresses a manager rule THREE times
    // (the Add button, the delete button, and `disabled={!manager}` on the
    // warranty field) and there is no server action at all, so the client wrote
    // straight through RLS; 0338 the four household ledgers — `care_log`,
    // `behavior_logs`, `screen_time_entries`, `medication_doses` — whose
    // `logged_by` nothing pinned. That last one is sharper than 0333's twin
    // finding and says so: care-module.tsx:253 RENDERS the name, so a child
    // could write a `medication` entry reading "Gave Grandma her tablets" and
    // the timeline showed it as the parent's own record.
    //
    // A second tranche took the remaining 28 names off the triage list and
    // wrote NO migration, which is why this number did not move. Five of its
    // seven batches found nothing at all — home, ai, planning and household are
    // consistent-open, with no application rule for the database to be failing
    // to mirror. Across both tranches: 41 names verified, 10 real, 31 false
    // positives.
    //
    // The three that looked real — 0339 calendar_events, 0340 the school/task
    // group, 0342 notes — were written, adversarially reviewed, and REJECTED
    // before they reached this tree. All three pinned `created_by = auth.uid()`
    // on INSERT, and that predicate is wrong on these tables: lib/services/
    // approvals/index.ts:618 `scopeForApprovedWork` deliberately runs approved
    // work as the ASKER, so `created_by` names the person who wanted the thing
    // while the session belongs to the approver. lib/trust/ai-gate.ts:36 states
    // the invariant in words — "an approval granted hours later could only be
    // replayed as the APPROVER" — and a test guards it. A bare identity pin
    // breaks it: CENSUS-002 for the third time, caught by review, not by CI.
    //
    // The NUMBER 0339 has since been re-used, by a migration that is in this
    // tree: 0339_a_calendar_event_names_who_actually_made_it.sql. It is NOT the
    // rejected draft. It carries 0272's shape rather than an identity pin —
    // `created_by is null OR created_by = auth.uid() OR
    // can_manage_family(family_id)` — so the NULL branch keeps ICS import and
    // subscribed-feed sync working and the manager branch keeps the
    // approval replay working, both of which the rejected draft broke. The
    // 0342 (notes) remains rejected and is still not in this tree; AUTHZ-021 is
    // closed on INSERT only, and the residue is recorded in that migration's
    // header and in finalaudit.md.
    //
    // 0340 is likewise a re-used NUMBER, not the rejected school/task draft.
    // 0340_an_erasure_actually_erases.sql repairs 0338's
    // attribution_is_immutable(), which preserves the attribution columns
    // UNCONDITIONALLY. Five of those columns are ON DELETE SET NULL, and
    // Postgres runs a referential action as an ordinary UPDATE — so the trigger
    // fired on it and put the deleted id back. Measured both ways: in
    // autocommit that COMMITS a dangling reference with no error (the face a
    // real erasure gets, since admin.deleteUser issues one DELETE in its own
    // transaction); inside a transaction the FK check fires and the delete is
    // refused (the face a probe gets, since every probe here rolls back).
    // pg_trigger_depth() = 1 is an application UPDATE; a referential action is
    // depth 2. See AUTHZ-023, and docs/audit/an-erasure-actually-erases-check.sql,
    // whose negative control restores the unconditional preserve and requires
    // the erasure to break — measured: exit 3 against the unguarded function,
    // exit 0 against the repaired one.
    //
    // 0341 is the first CONCURRENCY finding to take a number here rather than
    // an authorization one. 0341_two_approvals_for_one_kid_both_land.sql closes
    // a lost update in applyCompletionRewards: it read kid_progress, added the
    // XP in TypeScript, and wrote the total back by id, so two chores approved
    // for one child at the same moment both read xp=100 and both wrote 120 —
    // one award silently lost, and level/current_streak/longest_streak lost
    // with it, because all four came off that one stale read. Measured on two
    // real connections with two seconds of overlap: blind shape xp=120, locked
    // shape xp=140; and from 270 XP, blind xp=290 level=2 against locked xp=310
    // level=3, so the lost award is also a lost level-up. The fix is 0317's
    // shape — `select … for update`, the award relative to the locked row —
    // and it covers the ROLLBACK too, which wrote the pre-award row back
    // absolutely and so erased any approval that landed beside it. Held by
    // docs/audit/two-approvals-for-one-kid-both-land-check.sql (which performs
    // the blind shape on the same row as its own negative control) and by
    // tests/two-approvals-for-one-kid-both-land.test.ts (which holds the first
    // approval open and asserts mid-flight that the second had reached the
    // database and neither had written, so the interleaving is a fact rather
    // than a hope).
    //
    // 0342 is a RE-USED number, in the sense 0339 and 0340 are: it is NOT the
    // rejected notes draft this comment records above, which is still not in
    // this tree. 0342_a_child_cannot_spend_the_same_dollar_twice.sql is the
    // second concurrency finding (Q-01) and closes the last money path that
    // still wrote the ledger from TypeScript. `debitSpendBucket` in
    // lib/wallet/server.ts read the Spend balance, decided against it, and
    // inserted a debit in a separate round trip, so two $8 spends arriving
    // together against $10 both passed the check and both posted — an immutable
    // ledger at -$6.00, with nothing behind the check to catch it (the only
    // partial unique index on wallet_transactions is 0316's chore payout, the
    // only trigger is set_updated_at, and amount_cents >= 0 puts the sign in
    // `direction`). The fix is 0155's shape rather than 0317's: lock the child's
    // spend bucket FOR UPDATE, total the ledger inside that lock, refuse, write.
    // It totals `('completed','processing')` as 0155 does, so a live card hold
    // stops being invisible to an in-app spend, and its authorization RESTATES
    // wallet_transactions' manager-only INSERT policy rather than inventing one
    // — SECURITY DEFINER skips RLS, so the function has to say what RLS said.
    // Held by docs/audit/a-child-cannot-spend-the-same-dollar-twice-check.sql,
    // whose negative control replays the read-then-insert shape on the same
    // bucket and requires the overdraft to land.
    //
    // 0343_only_a_parent_mints_or_revokes_an_assistant_key.sql is an
    // authorization finding in 0254's restrictive shape. 0283's own header said
    // only a parent may create or revoke an assistant key, and its policies
    // were written against can_manage_family() — parent OR adult — so an adult
    // could mint a live bearer key over /rest/v1, widen a parent's read-only
    // speaker, revoke and un-revoke it, or delete it and cascade away its
    // usage trail. Three RESTRICTIVE guards on is_family_admin() for insert,
    // update and delete; SELECT untouched. Held by
    // tests/only-a-parent-mints-or-revokes-an-assistant-key.test.ts, which
    // replays every policy and grant on the table and evaluates each request
    // the way Postgres does; it goes red with the migration absent.
    //
    // 0349_one_saved_copy_of_a_provider_recipe_per_family.sql makes the
    // (family_id, source_provider, source_recipe_id) triple unique for provider
    // recipes, partial so the AI variants that share a source stay writable:
    // two Saves in the same second both probed an empty vault and both landed.
    // Held by docs/audit/a-family-vault-holds-one-saved-copy-of-a-provider-
    // recipe-check.sql, red on the race without it.
    //
    // 0352_a_child_cannot_clear_the_households_money_warnings.sql moves the
    // writes on money_timeline_insights from is_family_member to
    // can_manage_family, with 0275's RESTRICTIVE guards: the row is one per
    // family per advisory, so a child's Dismiss cleared the parents' warning
    // too. SELECT stays on membership (0267's decision). Held by two probes,
    // docs/audit/a-child-cannot-clear-the-households-money-warnings-check.sql
    // and docs/audit/only-a-parent-or-an-adult-clears-the-households-money-
    // warnings-check.sql, each red without it.
    //
    // 0360_a_head_out_reminder_goes_with_its_departure_plan.sql adds an AFTER
    // DELETE trigger on departure_plans that deletes the plan's head-out
    // reminder, SECURITY INVOKER and fenced to the plan's family: 00981's
    // event_id cascade took the plan with its event and stranded the reminder
    // on every member's calendar. Held by
    // docs/audit/a-head-out-reminder-goes-with-its-departure-plan-check.sql.
    //
    // 0344–0377 and 0378–0380 are the C1-K pass from
    // claude/youthful-turing-ppwrkl, numbered 0318–0351 on that branch. They
    // were renumbered after main's 0318–0343 on the first merge, and the three
    // that then collided with main's 0349, 0352 and 0360 moved to 0378
    // (savings goals), 0379 (member locations) and 0380 (audit actor).
    //
    // 0381_two_parents_means_two_parents_in_the_database_too.sql adds two
    // BEFORE UPDATE triggers on approval_requests: a move into approved or
    // modified must be earned by the row's own votes under its own model and
    // threshold, a vote is signed only as yourself, and the rule of a pending
    // row cannot be rewritten. The rule had lived in TypeScript alone, and
    // 0251's decide policy let any adult PATCH status=approved. Held by
    // docs/audit/two-parents-means-two-parents-check.sql.
    //
    // 0382_a_password_alone_does_not_delete_the_familys_budget.sql adds
    // session_cleared_step_up() — aal2, or no factor enrolled — and a
    // RESTRICTIVE insert/update/delete guard on budgets, savings_goals and
    // bills: the step-up the money pages demanded was never a database rule.
    // Held by docs/audit/a-password-alone-does-not-delete-the-familys-budget-check.sql.
    //
    // 0383_an_archived_page_takes_its_public_answers_with_it.sql adds four
    // AFTER triggers on marketing_pages and blog_posts that move a page's
    // published FAQ answers to 'answered' in the same transaction as its
    // archive, delete, rename or unpublish: the answers had no join back to
    // their page and kept rendering after it went dark. Held by
    // docs/audit/an-archived-page-takes-its-public-answers-with-it-check.sql
    // and docs/audit/a-renamed-page-leaves-no-public-answer-behind-check.sql.
    //
    // 0384_the_urgent_fallback_number_is_stored_the_only_way_it_can_be_used.sql
    // gives family_contact_channels.forward_to_phone the E.164 CHECK its own
    // comment claimed, after normalizing the rows already there and keeping
    // what they held in forward_to_phone_legacy — no country code guessed. Held
    // by docs/audit/the-urgent-fallback-number-is-stored-the-only-way-it-can-
    // be-used-check.sql.
    //
    // 0385_a_member_only_rewrites_their_own_memory.sql re-creates
    // family_facts_update and family_facts_delete with the rule the service
    // applies — can_manage_family, or a memory about me, or one I wrote — on
    // top of 0264's category clause: any member could rewrite a parent's
    // household fact over /rest/v1. Held by
    // docs/audit/a-member-only-rewrites-their-own-memory-check.sql.
    //
    // 0386_a_family_subscribes_to_a_calendar_url_once.sql makes (family_id,
    // url) unique on calendar_feeds: a failed first sync left the row and the
    // next press inserted the same URL again, so every school event came in
    // two or three times. Held by
    // docs/audit/a-family-subscribes-to-a-calendar-url-once-check.sql.
    //
    // 0387_a_child_cannot_lift_the_publish_lock_or_link_a_document_they_cannot_read.sql
    // (AUTHZ-011) puts three guards in the database: RESTRICTIVE write policies
    // on social_settings behind social_has_permission(…, 'manage_settings'),
    // a trigger that lets a trip link only a document its caller can read from
    // its own household, and a SECURITY DEFINER trigger that refuses to move a
    // document to another household while a trip links it. Held by
    // docs/audit/a-child-cannot-lift-the-publish-lock-or-link-a-document-they-
    // cannot-read-check.sql.
    //
    // 0388_a_notification_is_written_by_bubaly_not_by_a_member.sql narrows a
    // member session's INSERT on notifications to rows addressed to the
    // member themselves; notify() writes everyone else's with the service
    // role. Held by docs/audit/notification-authorship-check.sql (re-
    // controlled) and tests/a-notification-for-someone-else-is-written-by-
    // bubaly.test.ts.
    //
    // 0389_a_decision_once_made_stays_made.sql (SRV-001, the m7+m8 residual)
    // adds the fourth trigger on approval_requests: once status leaves
    // 'pending', status, approvals, edited_payload, decided_by and decided_at
    // are frozen, and payload — the ask the votes are votes on — cannot change
    // for the life of the row; the execution stamps still land. RLS-subject
    // callers only, like 0381's rules. Held by docs/audit/two-parents-means-
    // two-parents-check.sql (the re-open, the declined→approved flip, the
    // post-decision edit and the payload rewrite refused; the stamps landing).
    //
    // 0390_a_queued_run_keeps_the_gate_it_was_born_with.sql (the same residual)
    // pins family_automation_runs.metadata: once approval_id or plan_id is set
    // it cannot be removed or changed by an RLS-subject caller. The
    // load-bearing half is in the concierge action, which now resolves the
    // governing approval from approval_requests by plan and never from the
    // run's metadata. Held by docs/audit/automation-runs-pin-what-a-member-
    // may-queue-check.sql.
    //
    // 0391_a_password_alone_does_not_open_the_familys_vault.sql (O-03) gives
    // the document area's step-up its database counterpart on the four vault
    // tables written only behind it — family_credentials, household_info,
    // tax_documents, paperwork_items: RESTRICTIVE guards on
    // `session_cleared_step_up() or not can_manage_family(family_id)`, the
    // rule needsStepUp applies (a manager must have cleared the code; anyone
    // else is left to the table's own policies), with SELECT guarded on the
    // three secret tables. documents and its bucket stay open. Held by
    // docs/audit/a-password-alone-does-not-open-the-familys-vault-check.sql.
    //
    // 0406–0418, less 0412, 0413 and 0417, are the audit branch's (PR #556):
    // ten files, and the FIFTH time that branch's numbers have moved. They sat
    // at 0300/0304–0309, then 0318–0330, then 0361–0370, and main claimed each
    // range while they waited — the last time with the C1-K pass above, which
    // is the collision this pin surfaced on the merge that brought it in. The
    // order is theirs, unchanged: 0406 social tokens service-role only; 0407
    // no TRUNCATE for the public roles; 0408 household secrets; 0409–0411 the
    // marketplace parties, reviews and review deletes; 0414 health records;
    // 0415 the paperwork stamp; 0416 the private journal; 0418 the public
    // bucket's MIME allowlist. The slots are the ones an earlier close-out of
    // the same branch had already replayed and probed against this tree with
    // all thirteen files at 0406–0418, so the ten keep those and the three
    // gaps are the three the branch DROPPED on its own merge with main (Audit
    // C1-S9-89): its social-restriction DELETE policy duplicated 0319 here,
    // less its `to authenticated`; its location policies are superseded by
    // 0335, and stacking them broke 0335's own negative control; and its
    // behaviour/care-log policy contradicted 0338's probe on whether a child
    // may log behaviour — recorded in finalaudit.md for the owner to decide
    // rather than settled by whichever merge came last. 0381–0388 went to
    // the paragraphs above (#581, #584) after that block was picked, and
    // 0389–0405 stay free, spoken for by other in-flight branches at the time;
    // a number below the one pinned is still free to land.
    //
    // 0406 puts the OAuth token store (social_account_tokens) back behind the
    // service role — 0034 created it deny-all and said never to add a policy,
    // and 0297 added four on the premise that "every policy was
    // is_family_member" when there were none (C3-S5-01). 0407 revokes TRUNCATE
    // from anon and authenticated across public: RLS is never consulted for
    // TRUNCATE, so `using (false)` did not stop it, and Supabase's default
    // privileges had handed both roles TRUNCATE on the marketing spine and both
    // credential stores (C3-S3-02, C3-S5-09). 0408 makes household_info's
    // `is_sensitive` flag reach RLS — wifi keys and alarm codes were masked by
    // an eye toggle over a row every child's browser already held.
    //
    // 0409 makes the marketplace's party columns immutable with a BEFORE UPDATE
    // trigger: 0154's UPDATE policies checked the row you started with, and
    // `with check (is_family_member)` let a buyer make themselves the seller of
    // record on their own completed order. 0410 scopes marketplace_reviews,
    // _saves and _follows UPDATE to the author (the SUBJECT of a one-star
    // review was rewriting its rating) and replaces 0409's table-branching
    // trigger function with a generic one that takes its column list from the
    // trigger definition. 0411 is the same fix for DELETE on the four
    // per-member marketplace tables — deleting a review is rewriting it —
    // with the author, a manager who is not the review's subject, and the
    // listing owner (for offers) kept.
    //
    // 0414 adds restrictive manager guards to immunizations and health_visits
    // — the two health tables 0309 named the class for and stopped short of —
    // in 0254's mechanism and 0309's shape; medication_doses stays open as
    // 0309 left it. 0415 adds paperwork_stamp_action(): stamping one paperwork
    // action used to rewrite the WHOLE `actions` array from a copy read
    // earlier, so "Add to calendar" followed by "Remind me" erased the first
    // stamp and the retap created a second event; one element via jsonb_set,
    // refusing an element already stamped, SECURITY INVOKER so RLS is
    // unchanged. 0416 makes journal_entries' `is_private` mean what it says on
    // SELECT — self, or a family MANAGER once the owner marks an entry not
    // private, which is 0364's owner-or-manager rule and what
    // docs/audit/private-journal-check.sql pins: a sibling never reads another
    // member's entry — and gives family_insurance_policies the manager-gated
    // writes its twin insurance_policies always had. 0418 pins
    // `allowed_mime_types` on the one PUBLIC bucket that accepted anything
    // (family-media), read off the six upload modules' own `accept` lists, so
    // an SVG or HTML upload is no longer a page hosted on the project's own
    // Supabase domain (F-E03's cheap half, which the LB-009 deferral was never
    // meant to cover).
    //
    // 0419_a_departed_parent_keeps_no_assistant_key.sql (SRV-001 l12) retires
    // the assistant keys of a parent who leaves the family: an AFTER UPDATE
    // (is_active, role, user_id, family_id) OR DELETE trigger on family_members
    // stamps revoked_at on the old (family, user) pair's live keys whenever
    // that pair no longer has an active parent row, SECURITY DEFINER because
    // 0343 refuses the remover (possibly an adult) writes on assistant_links,
    // plus a backfill for keys already orphaned. The application half,
    // resolveAssistantLink requiring an active parent owner, holds without it.
    // Held by docs/audit/a-departed-parent-keeps-no-assistant-key-check.sql.
    //
    // 0420_only_a_released_app_installs.sql (SRV-001 l8) adds two RESTRICTIVE
    // policies on family_app_installs, INSERT (WITH CHECK) and UPDATE (USING
    // and WITH CHECK), that require the app to be published or beta; 0165's install policies were
    // membership alone, so a member could install a coming-soon or retired app
    // over /rest/v1. DELETE stays open, so a stranded install can always be
    // removed. Held by docs/audit/only-a-released-app-installs-check.sql.
    //
    // 0426-0443 are PR #548's block, and it has moved twice. The branch
    // numbered it 0318-0338 against a main that stopped at 0317; main then
    // landed its own 0318-0360, and the author moved the block to 0361-0382 on
    // merging main at 7e54596d. main then landed 0344-0380 (#579, the C1-K
    // pass) and 0381-0387 (#581), so the block collided again, all of it this
    // time, and it moved as one block, in order and by name, into the range
    // this PR was assigned: 0361->0426, 0362->0427, 0363->0428, 0365->0429,
    // 0366->0430, 0367->0431, 0369->0432, 0370->0433, 0371->0434,
    // 0372->0435, 0373->0436, 0374->0437, 0375->0438, 0378->0439,
    // 0379->0440, 0380->0441, 0381->0442, 0382->0443. Above main's newest
    // rather than into any gap below it, because a version below the newest
    // one applied is not what `supabase db push` applies without being told
    // to. What the survivors touch: policy predicates (0426), reward prices
    // (0428), subscriptions and billing_customers (0429), nine health tables
    // (0430), a guardian_phone unique index (0432), marketplace deal terms
    // (0433), medications (0434), grades and screen-time limits (0435),
    // medical_profiles reads + family_allergies() (0438), a reward balance
    // trigger (0439), push_deliveries (0440), the Resend counter (0441) and
    // independence_milestones (0442).
    //
    // 0443_a_family_gets_one_default_list.sql adds ensure_default_grocery_list
    // and ensure_default_todo_list: get-or-create of a family's DEFAULT list as
    // one operation under a per-family advisory lock (DATA-007), SECURITY
    // INVOKER so RLS decides exactly what it decided before. Held by
    // docs/audit/a-family-gets-one-default-list-check.sql, which races two
    // sessions against it and against a lock-less copy.
    //
    // 0427, 0431, 0436 AND 0437 ARE PERMANENTLY UNUSED, and that is recorded
    // rather than renumbered, for the reason given for 0334 and 0337 above.
    // Each was the branch's fix for a subject #579 had since closed, and each
    // is shown by a probe going red with the file put back on the replayed
    // chain, not by comparing names: 0427 (driving scores) is main's 0365, a
    // trip is a manager's to erase (driving-score-write-boundary-check); 0431
    // (safety check-ins, whose locator half 0335 had already taken) is main's
    // 0379 (locator-write-boundary-check, step 6: with it a child files a
    // check-in naming nobody); 0436 (behaviour-note authorship) is main's 0377
    // (access-record-write-boundary-check); 0437 (journals) is main's 0364
    // (main's private-journal-check). Laid over main's, each replaced or
    // widened the rule main's guards stand on. The author had already dropped
    // four more the same way on the first merge (numbered 0364, 0368, 0376 and
    // 0377 then; duplicates of main's 0298, 0306/0322/0324, 0318 and 0319);
    // those never took a number in this range, and the numbers they held then
    // are main's now. 0444 and 0445 were the rest of this PR's range, unused;
    // 0444 is now the circle search-path fix (pgcrypto lives in `extensions`
    // on Supabase), and 0445 is free.
    //
    // 0447-0458 are the claude/logged-in-pages-supabase-7q6vtf audit branch's,
    // ported onto main (PORT-001). They were 0318-0336 on that branch and
    // 0389-0404 on the port until main's #583 took 0389-0391 and 0406-0445;
    // they moved as one block, in order, above main's newest. Four were
    // dropped rather than renumbered, because main now carries the same rule:
    // the port's 0393 (the OAuth token store is service-role only) is main's
    // 0406, its 0395 (the vaults ask for the second factor) is main's 0391,
    // its 0404 (a removed member's profile visibility) is main's 0426, which
    // installs the identical policy, and its 0446 (the circle search_path) is
    // main's 0444, which installs the identical function. What the twelve
    // touch:
    //
    // 0447 casts the ledger direction in invest_decide_order (every APPROVAL
    // raised 42804 from 0196 on while rejection worked). 0448 makes a
    // single-choice poll take one vote. 0449 refuses a family timezone the
    // server does not know. 0450 makes the feedback-attachments bucket
    // private. 0451 ties a chore dispute to the child whose chore it is. 0452
    // hides a proxy bid's ceiling from rival bidders. 0453 makes Guardian call
    // history a manager's write. 0454 lets onboarding resume only your own
    // family. 0455 backfills `state` on concierge runs already decided. 0456
    // takes two server-only functions away from client roles. 0457 lets an
    // auction close. 0458 lets only the server link a login to a member row.
    // 0459 is held by #621 (the family-media bucket private, SEC-001), open
    // when 0460 landed. 0460 makes the family's subscriptions a manager's
    // write (API-SWEEP-06's write half).
    //
    // 0461 narrows the seven AUTHZ-020 tables still open to any member's
    // write (family_stress_predictions and six vacation_* side tables no
    // application file references) to can_manage_family, keeping SELECT.
    //
    // 0462 makes a family that cannot see a listing unable to bid on it, buy
    // it, negotiate for it or file an offer against it (DB-RPC-M01). 0463
    // makes a chat read receipt or reaction its reader's own (DB-RPC-M02).
    // 0464 makes an invited guest read-only on the eight household resources
    // /family/permissions shows them as read-only on (ROLE-M03).
    // 0471 adds the per-recipient admin digest delivery store, and 0474
    // (reserved for #710) withdraws an admin removed after a digest was
    // frozen. 0482 (reserved on #699, 5971513705) gives a recurring event the
    // occurrences it has given up. This literal tracks the checked-in
    // high-water mark, not migration allocation: 0465-0470 remain NWV's, 0472
    // Support's, 0473 the coordinator's, 0475-0476 messaging's, 0477 Surge's,
    // 0478 Meals', 0479 Q40's (#904, which moves this pin to 0480 on its own
    // branch), 0481 the unpublished Meals fixture's.
    expect(audit.nextVersion).toBe('0483');
  });

  it('flags a newly introduced collision instead of silently accepting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bubaly-migrations-'));
    try {
      writeFileSync(join(directory, '0194_first.sql'), 'select 1;');
      writeFileSync(join(directory, '0194_second.sql'), 'select 1;');
      expect(auditMigrationVersions(directory).unexpectedDuplicates).toEqual([
        { version: '0194', names: ['0194_first.sql', '0194_second.sql'] },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
