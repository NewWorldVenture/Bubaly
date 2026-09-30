import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * F-G09, as the owner decided it: PARENTS WRITE, KIDS SEE THEIR OWN.
 *
 *   immunizations, health_visits   writes: parent/adult only (0414), and the
 *                                  modules offer a non-manager no control the
 *                                  database will refuse
 *   medications                    read: a manager all, anyone else the rows
 *                                  naming their own member (0465)
 *   medication_schedules,          read: exactly when their medication is
 *   medication_doses               readable; doses stay any member's to write
 *
 * docs/audit/a-child-reads-only-their-own-prescriptions-check.sql proves the
 * rule behaviourally, with negative controls. This file pins what a database
 * run cannot see: the migration's text, and the screens and the coach route
 * that sit on top of it.
 */

const read = (p: string) => readFileSync(p, 'utf8');
const MIGRATION = read('supabase/migrations/0465_a_child_reads_only_their_own_prescriptions.sql');
const PROBE = read('docs/audit/a-child-reads-only-their-own-prescriptions-check.sql');
const PRESCRIPTION_PROBE = read('docs/audit/prescription-write-boundary-check.sql');
const MEDS = read('components/modules/medications-module.tsx');
const IMMUNIZATIONS = read('components/modules/immunizations-module.tsx');
const VISITS = read('components/modules/health-visits-module.tsx');
const COACH = read('app/api/ai/health/coach/route.ts');
const HEALTH = read('components/modules/health-module.tsx');
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];

/** SQL with `--` comments removed, whitespace collapsed, so a header sentence cannot satisfy a pin. */
const code = (sql: string) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').replace(/\s+/g, ' ');
const SQL = code(MIGRATION);

describe('0465: a child reads only their own prescriptions', () => {
  it('reads a medication as a manager, or as the member it names — and a row naming nobody is a manager’s', () => {
    expect(SQL).toContain(
      "'public.is_family_member(family_id) and (public.can_manage_family(family_id) or public.is_self_member(member_id))'",
    );
    // No `member_id is null` escape hatch: the module files a parent's own
    // prescription as "Whole family" by default.
    expect(SQL).not.toMatch(/member_id is null/i);
  });

  it('reads a schedule or a dose exactly when its medication is readable', () => {
    expect(SQL).toContain("else 'public.medication_is_readable(medication_id, family_id)'");
    expect(SQL).toMatch(/create or replace function public\.medication_is_readable\(p_medication_id uuid, p_family_id uuid\).*security invoker/);
    expect(SQL).toMatch(/public\.can_manage_family\(p_family_id\) or exists \( select 1 from public\.medications m where m\.id = p_medication_id and m\.family_id = p_family_id and public\.is_self_member\(m\.member_id\) \)/);
    expect(SQL).toContain("foreach t in array array['medications', 'medication_schedules', 'medication_doses'] loop pred := case t");
  });

  it('backs each read with a restrictive guard and sweeps every other permissive read by shape', () => {
    expect(SQL).toContain("'create policy %I on public.%I as restrictive for select to authenticated using (%s)', t || '_own_or_manager_read_guard'");
    expect(SQL).toMatch(/p\.polpermissive and p\.polcmd in \('r', '\*'\) and not \(p\.polname = any\(keep\)\)/);
    expect(SQL).toContain("raise exception '0465 FAILED: % other permissive read policy(ies) still on %");
    expect(SQL).toContain("raise exception '0465 FAILED: expected three restrictive read guards, found %'");
  });

  it('keeps a dose any member’s to write, word for word', () => {
    for (const verb of ['insert', 'update', 'delete']) {
      expect(SQL, verb).toContain(`create policy medication_doses_member_${verb} on public.medication_doses for ${verb} to authenticated`);
    }
    expect(SQL).toContain('with check (public.is_family_member(family_id))');
    expect(SQL).toContain("refusing to split it");
    expect(SQL).toContain("raise exception '0465 FAILED: medication_doses should keep three member-wide write policies, found %'");
  });

  it('keeps 0309 / 0434’s six prescription write guards', () => {
    for (const t of ['medications', 'medication_schedules']) {
      for (const verb of ['insert', 'update', 'delete']) {
        expect(SQL).toContain(`'${t}_manager_${verb}_guard'`);
      }
    }
    expect(SQL).toContain("raise exception '0465 FAILED: expected the six restrictive prescription write guards from 0309/0434, found %'");
    // 0465 never drops or rewrites a write policy on the two prescription tables.
    expect(SQL).not.toMatch(/drop policy[^;]*_(mng|manager)_(insert|update|delete)/);
  });
});

describe('the probes assert the owner’s rule, not the old one', () => {
  it('the 0465 probe proves own-only reads, the dose writes and the refused health writes', () => {
    const p = code(PROBE);
    expect(p).toContain("if names is distinct from 'Amoxicillin' then raise exception 'a child read a prescription that is not theirs");
    expect(p).toContain("raise exception 'a child read a sibling''s dose history (%)'");
    expect(p).toContain("raise exception 'a child can no longer re-mark their own dose (%)'");
    expect(p).toContain("raise exception 'a child can no longer un-mark their own dose (%)'");
    expect(p).toContain("raise exception 'a child recorded an immunization'");
    expect(p).toContain("raise exception 'a child recorded a health visit'");
    expect(p).toContain("raise exception 'a parent no longer reads every prescription in the family (% of 4)'");
    expect(p).toContain("raise exception 'a parent can no longer delete an immunization (%)'");
  });

  it('the prescription write probe no longer asserts that a child reads the family’s medications', () => {
    const p = code(PRESCRIPTION_PROBE);
    expect(p).not.toContain('a child can no longer see the family medications');
    expect(p).toContain("raise exception 'a child can read a parent''s prescription'");
    // The medication it probes writes against is the child's own, so the write
    // guard — not the narrower read — is what refuses them.
    expect(p).toMatch(/values \(fam, child_mid, 'Sertraline'/);
  });
});

describe('the screens match the database', () => {
  for (const [name, src, table] of [
    ['immunizations', IMMUNIZATIONS, 'immunizations'],
    ['health visits', VISITS, 'health_visits'],
  ] as const) {
    it(`${name}: Add, Edit and Delete are a manager’s, and a refused write says so`, () => {
      expect(src).toContain('const canEdit = isManager(role);');
      expect(src).toMatch(/\{canEdit && <Button size="sm" onClick=\{\(\) => setForm\(blank\(/);
      expect(src).toMatch(/\{canEdit && \(\s*<div/);
      expect(src).toContain(`from('${table}').update(row).eq('id', form.id).eq('family_id', familyId).select('id')`);
      expect(src).toMatch(new RegExp(`from\\('${table}'\\)\\.delete\\(\\)\\s*\\.eq\\('id', id\\)\\.eq\\('family_id', familyId\\)\\.select\\('id'\\)`));
      // A refused write shows the classified error (with or without the reader's
      // translator, which I18N-011 adds).
      expect(src).toMatch(/toastError\(describeDbError\(error(, t)?\)\)/);
      expect(src.match(/wroteNoRows\(data\)\) \{? ?(return )?toastError\(t\('errors\.thatChangeWasNotSaved'\)\)/g)?.length).toBe(2);
    });
  }

  it('medications: a non-manager is told they see their own, and is not offered a filter that can only come up empty', () => {
    expect(MEDS).toContain('const canEdit = isManager(role);');
    expect(MEDS).toMatch(/\{canEdit \? \(\s*<div className="flex flex-wrap gap-1\.5 mb-4[\s\S]*?WHOLE_FAMILY[\s\S]*?\) : \(\s*<p className="text-sm text-muted mb-4">\{t\('medicationsModule\.yourOwnMedicinesOnly'\)\}<\/p>/);
    expect(MEDS).toContain("description={canEdit ? t('uiText.addAMedicationAndSetItsDosing') : t('medicationsModule.noMedicinesPrescribedToYou')}");
    // Dose logging stays open to everyone: `logDose` asks only canMutate(), not the manager variant.
    expect(MEDS).toMatch(/async function logDose\(due: DueDose, status: DoseStatus\) \{\s*if \(!canMutate\(\)\) return;/);
    expect(MEDS).toMatch(/await mutate\(`dose:\$\{due\.scheduleId\}:\$\{due\.slotKey\}`, false,/);
  });

  // #674 review: the wording above must be TRUE before 0465 is applied, when a
  // child's read still returns the family's rows. So the page itself asks a
  // non-manager for their own prescriptions and doses; the migration makes the
  // database agree, but the page does not depend on it.
  it('medications: a non-manager\'s page asks for their own rows, independent of 0465', () => {
    expect(MEDS).toContain('const ownMemberOnly = canEdit ? null : (selfMember?.id ?? NIL_UUID);');
    expect(MEDS).toContain("const NIL_UUID = '00000000-0000-0000-0000-000000000000';");
    expect(MEDS).toMatch(/table: 'medications', familyId, deps: \[familyId, ownMemberOnly\],\s*fetcher: \(sb\) => \{\s*const q = sb\.from\('medications'\)\.select\('\*'\)\.eq\('family_id', familyId\);\s*return \(ownMemberOnly \? q\.eq\('member_id', ownMemberOnly\) : q\)/);
    expect(MEDS).toMatch(/table: 'medication_doses', familyId, deps: \[familyId, dayKey, ownMemberOnly\],[\s\S]{0,200}?return ownMemberOnly \? q\.eq\('member_id', ownMemberOnly\) : q;/);
  });

  it('the health coach refuses a non-manager a question about someone else, and offers only themselves', () => {
    expect(COACH).toContain("if (memberId && !manager && memberId !== ctx.active.member.id) {");
    expect(COACH).toContain('const manager = isManager(ctx.active.role);');
    expect(COACH).toContain("return NextResponse.json({ error: t('coach.onlyYourOwnHealth') }, { status: 403 });");
    // The refusal comes before any read that would ground an answer.
    expect(at(COACH, "t('coach.onlyYourOwnHealth')")).toBeLessThan(at(COACH, "supabase.from('medications')"));
    expect(HEALTH).toContain('(isManager(role) ? members : members.filter((m) => m.user_id === userId))');
    expect(HEALTH).toContain('{coachMembers.map((m) =>');
  });

  it('the new copy is in every full catalogue', () => {
    for (const locale of LOCALES) {
      const cat = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['medicationsModule.yourOwnMedicinesOnly', 'medicationsModule.noMedicinesPrescribedToYou', 'coach.onlyYourOwnHealth']) {
        expect(cat[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});
