import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recordScope, rowsInScope } from '@/lib/health/record-scope';

// The held 0506 narrows the read on the eight per-member health tables to a
// manager, the member a record is about, or its author. The screens that pick
// a member must then offer a non-manager only themselves, as the health
// module's coach already did: otherwise a child taps a sibling's tab and sees
// an empty record that is not empty. Before 0506 is released RLS returns a
// manager the same rows, so for a manager nothing changes.

const MIGRATION = 'supabase/reserved/0506_a_health_record_is_read_by_a_manager_or_its_own_member.sql';
const PROBE = 'docs/audit/reserved/a-health-record-is-read-by-a-manager-or-its-own-member-check.sql';
const TABLES = ['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
  'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs'];

const read = (p: string) => readFileSync(p, 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('a health record is read by a manager or its own member', () => {
  const sql = read(MIGRATION);

  it('narrows the read on all eight tables, and the probe pins that predicate', () => {
    expect(sql).toContain(`array['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
                           'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs']`);
    const created = squash(sql);
    expect(created).toContain("'public.is_family_member(family_id) and (' || 'public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid()))'");
    expect(read(PROBE)).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (created_by = auth.uid())))'");
    for (const t of TABLES) expect(read(PROBE)).toContain(`'${t}'`);
  });

  it('the sleep coach lets anyone log for anyone, and shows a non-manager only their own history', () => {
    const src = read('components/modules/sleep-module.tsx');
    expect(src).toContain("import { recordScope, rowsInScope } from '@/lib/health/record-scope';");
    // Every member is still a tab, so a caregiver can still log a ward's night or check-in.
    expect(src).toContain('{members.map((m) => {');
    expect(src).toContain('const scope = recordScope(role, userId, member);');
    expect(src).toContain('rowsInScope(logs.data, memberId, scope, userId)');
    expect(src).toContain('rowsInScope(checkins.data, memberId, scope, userId)');
    // The summaries and the coach are built only from a whole record, and a partial one says so.
    expect(src).toContain("{scope === 'full' && (\n      <div className=\"grid gap-4 md:grid-cols-4\">");
    expect(src).toContain("{scope === 'full' && (\n      <div className=\"grid gap-4 lg:grid-cols-3\">");
    expect(src).toContain("t('sleepModule.onlyTheNightsYouLogged', { name: member?.display_name ?? '' })");
  });

  it('the nutrition tracker lets anyone log for anyone, and shows a non-manager only their own intake', () => {
    const src = read('components/meals/nutrition-view.tsx');
    expect(src).toContain("import { recordScope, rowsInScope } from '@/lib/health/record-scope';");
    expect(src).toContain('{members.filter((m) => m.is_active).map((m) => (');
    expect(src).toContain('<LogModal members={members}');
    expect(src).toContain('const scope = recordScope(role, userId, memberById.get(member));');
    expect(src).toContain('rowsInScope(rows ?? [], member, scope, userId)');
    expect(src).toContain("t('nutritionView.onlyTheMealsYouLogged'");
  });

  it.each([
    ['components/modules/health-visits-module.tsx'],
    ['components/modules/immunizations-module.tsx'],
  ])('%s filters a non-manager to their own records', (path) => {
    const src = read(path);
    expect(squash(src)).toContain('(canEdit ? members : members.filter((m) => m.user_id === userId))');
    expect(src).toContain('{filterMembers.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}');
    expect(src).toContain('{filterMembers.length > 0 && (');
    // The editor's member picker is a manager's (canEdit) and still lists everyone.
    expect(src).toContain('{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}');
  });

  it('every write the screens make names its author, so a writer reads back what they wrote', () => {
    for (const path of ['components/modules/health-module.tsx', 'components/modules/sleep-module.tsx',
      'components/meals/nutrition-view.tsx', 'components/modules/health-visits-module.tsx',
      'components/modules/immunizations-module.tsx']) {
      const src = read(path);
      const writes = src.match(/\.from\('(?:symptom_logs|health_metrics|health_goals|health_visits|immunizations|sleep_logs|sleep_checkins|nutrition_logs)'\)\s*\.(?:insert|upsert)\(/g) ?? [];
      const authored = src.match(/created_by: userId/g) ?? [];
      expect(writes.length, path).toBeGreaterThan(0);
      expect(authored.length, path).toBeGreaterThanOrEqual(writes.length);
    }
  });
});

describe('recordScope and rowsInScope: who sees how much of a health record', () => {
  const PARENT = 'u-parent';
  const CAREGIVER = 'u-caregiver';
  const ward = { id: 'm-ward', user_id: null };
  const caregiverSelf = { id: 'm-caregiver', user_id: CAREGIVER };
  // What the database returns BEFORE 0506 is released: every row of the family.
  const nights = [
    { id: 'n1', member_id: 'm-ward', created_by: PARENT },
    { id: 'n2', member_id: 'm-ward', created_by: CAREGIVER },
    { id: 'n3', member_id: 'm-caregiver', created_by: CAREGIVER },
    { id: 'n4', member_id: 'm-caregiver', created_by: PARENT },
    { id: 'n5', member_id: 'm-ward', created_by: null },
  ];

  it('a caregiver sees only the nights they logged for a ward, even when the database returns them all', () => {
    const scope = recordScope('caregiver', CAREGIVER, ward);
    expect(scope).toBe('authored');
    expect(rowsInScope(nights, ward.id, scope, CAREGIVER).map((r) => r.id)).toEqual(['n2']);
  });

  it('a caregiver sees their own whole record, whoever logged it', () => {
    const scope = recordScope('caregiver', CAREGIVER, caregiverSelf);
    expect(scope).toBe('full');
    expect(rowsInScope(nights, caregiverSelf.id, scope, CAREGIVER).map((r) => r.id)).toEqual(['n3', 'n4']);
  });

  it('a parent or adult sees every member\'s whole record', () => {
    for (const role of ['parent', 'adult']) {
      expect(recordScope(role, PARENT, ward)).toBe('full');
      expect(rowsInScope(nights, ward.id, 'full', PARENT).map((r) => r.id)).toEqual(['n1', 'n2', 'n5']);
    }
  });

  it('follows a role change both ways', () => {
    // A caregiver promoted to adult sees the ward's whole record at once…
    expect(recordScope('adult', CAREGIVER, ward)).toBe('full');
    // …and an adult made a caregiver sees only what they logged.
    expect(recordScope('caregiver', CAREGIVER, ward)).toBe('authored');
    for (const role of ['teen', 'child', 'guest', null, undefined]) {
      expect(recordScope(role, CAREGIVER, ward), String(role)).toBe('authored');
    }
  });

  it('never treats a member with no login as the viewer', () => {
    expect(recordScope('child', '', { user_id: null })).toBe('authored');
    expect(recordScope('child', 'u-x', null)).toBe('authored');
  });

  it('says so in every language', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      expect(messages['sleepModule.onlyTheNightsYouLogged'], locale).toContain('{name}');
      expect(messages['nutritionView.onlyTheMealsYouLogged'], locale).toContain('{name}');
    }
  });
});
