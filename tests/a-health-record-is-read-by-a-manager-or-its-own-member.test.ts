import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('the sleep coach offers a non-manager only their own nights', () => {
    const src = read('components/modules/sleep-module.tsx');
    expect(src).toContain("import { isManager } from '@/lib/constants/roles';");
    expect(squash(src)).toContain('(isManager(role) ? members : members.filter((m) => m.user_id === userId))');
    expect(src).toContain('{shown.map((m) => {');
    expect(src).not.toContain('{members.map((m) => {');
    expect(src).toContain('setMemberId(selfMember?.id ?? shown[0].id)');
  });

  it('the nutrition tracker offers and logs a non-manager only their own meals', () => {
    const src = read('components/meals/nutrition-view.tsx');
    expect(squash(src)).toContain('members.filter((m) => m.is_active && (isManager(role) || m.user_id === userId))');
    expect(src).toContain('{shown.map((m) => (');
    expect(src).toContain('<LogModal members={shown}');
    expect(src).toContain("useState<string>(selfMember?.id ?? shown[0]?.id ?? '')");
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
