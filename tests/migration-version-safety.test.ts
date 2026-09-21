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
    // Bumped whenever a migration lands — 0302 keeps one live system policy
    // per family per name. Stating it rather than deriving it is
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
    expect(audit.nextVersion).toBe('0342');
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
