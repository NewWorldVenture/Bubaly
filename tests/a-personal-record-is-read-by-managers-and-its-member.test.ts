import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readsEveryonesRecords, recordsInScope } from '@/lib/records/personal-scope';

// The held 0517, the owner's decision: insurance policies, travel documents,
// voice commands, travel medical detail and health providers are read by a
// parent or adult and by the member a record is about; a caregiver also reads
// the two medical ones. The screens show each viewer what that rule gives
// them, and a viewer who reads only their own files only their own.

const MIGRATION = 'supabase/reserved/0517_a_personal_record_is_read_by_managers_and_its_member.sql';
const PROBE = 'docs/audit/reserved/a-personal-record-is-read-by-managers-and-its-member-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

describe('who reads a personal record', () => {
  it('a manager reads every one; a caregiver only the medical ones', () => {
    for (const role of ['parent', 'adult']) {
      expect(readsEveryonesRecords(role), role).toBe(true);
      expect(readsEveryonesRecords(role, 'medical'), role).toBe(true);
    }
    expect(readsEveryonesRecords('caregiver')).toBe(false);
    expect(readsEveryonesRecords('caregiver', 'medical')).toBe(true);
    for (const role of ['teen', 'child', 'guest', null]) {
      expect(readsEveryonesRecords(role, 'medical'), String(role)).toBe(false);
    }
  });

  it('anyone else reads the records about themselves, and a record about nobody is not theirs', () => {
    const rows = [{ id: 'a', member_id: 'me' }, { id: 'b', member_id: 'sib' }, { id: 'c', member_id: null }];
    expect(recordsInScope(rows, 'teen', 'me').map((r) => r.id)).toEqual(['a']);
    expect(recordsInScope(rows, 'caregiver', 'carer').map((r) => r.id)).toEqual([]);
    expect(recordsInScope(rows, 'caregiver', 'carer', 'medical').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the screens show each viewer what the rule gives them', () => {
  it.each([
    ['components/modules/insurance-module.tsx', 'recordsInScope(policies.data, role, selfMember?.id)', "tr('insuranceModule.onlyPoliciesThatNameYou')"],
    ['components/modules/medical-records-module.tsx', "recordsInScope(rawProviders, role, selfMember?.id, 'medical')", "t('medicalRecordsModule.onlyYourOwnInsurance')"],
    ['components/modules/voice-module.tsx', 'recordsInScope(allHistory, role, selfMember?.id)', null],
    ['components/vacations/trip-emergency.tsx', "recordsInScope(allMedical, role, selfMember?.id, 'medical')", null],
  ])('%s', (file, scoped, note) => {
    const src = read(file);
    expect(src).toContain(scoped);
    if (note) expect(src).toContain(note);
  });

  it('the insurance hub builds its summaries from what it shows', () => {
    const src = read('components/modules/insurance-module.tsx');
    expect(src).toContain('insuranceSummary(visiblePolicies, today)');
    expect(src).toContain('premiumByType(visiblePolicies)');
    expect(src).not.toMatch(/insuranceSummary\(policies\.data/);
  });

  it('the trip sections scope their rows and file a restricted viewer\'s records as theirs', () => {
    const shared = read('components/vacations/shared.tsx');
    expect(shared).toContain('const ownOnly = Boolean(personal) && !readsEveryonesRecords(role, personal);');
    expect(shared).toContain('const pickable = ownOnly ? members.filter((m) => m.id === selfMember?.id) : members;');
    expect(shared).toContain('{pickable.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}');
    expect(shared).toContain('setForm(blankForm())');
    expect(read('components/vacations/trip-documents.tsx')).toContain('personal="personal"');
    expect(read('components/vacations/trip-emergency.tsx')).toContain('personal="medical"');
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['medicalRecordsModule.onlyYourOwnInsurance', 'medicalRecordsModule.onlyYourOwnProviders',
        'insuranceModule.onlyPoliciesThatNameYou', 'shared.onlyYourOwnRecords', 'shared.onlyYourOwnMedicalRecords']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

describe('the database half', () => {
  it('reads the six tables by one rule, adds caregivers only to the medical two, and keeps the travel writes', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("('vacation_medical_information', true), ('health_providers', true)");
    expect(sql).toContain("('insurance_policies', false), ('family_insurance_policies', false)");
    expect(sql).toContain("('vacation_documents', false), ('voice_commands', false)");
    expect(sql).toContain("case when x.medical then ' or public.family_role(family_id) = ''caregiver''' else '' end");
    expect(sql).toContain("'create policy %I on public.%I for insert to authenticated with check (%s)', 'Members add ' || x.t");
    const probe = read(PROBE);
    expect(probe).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id)))'");
    expect(probe).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))'");
  });
});
