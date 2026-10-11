import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notesInScope, readsEveryNote } from '@/lib/care/note-scope';
import { at, between } from './helpers/source-order';

// The held 0510, the owner's decision "managers, author, caregivers": a
// behaviour or care note is read by a parent or adult of its family, by whoever
// wrote it, and by a caregiver. The screens show each reader the notes that
// rule gives them, so a teen sees the same care log before and after 0510 is
// released, and a summary is never built from part of a log.

const MIGRATION = 'supabase/reserved/0510_a_note_about_a_member_is_read_by_managers_its_author_and_caregivers.sql';
const PROBE = 'docs/audit/reserved/a-note-about-a-member-is-read-by-managers-its-author-and-caregivers-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

describe('who reads a note', () => {
  it('a parent, an adult and a caregiver read every note; a teen, a child and a guest do not', () => {
    for (const role of ['parent', 'adult', 'caregiver']) expect(readsEveryNote(role), role).toBe(true);
    for (const role of ['teen', 'child', 'guest', null, undefined]) expect(readsEveryNote(role), String(role)).toBe(false);
  });

  it('anyone else reads the notes they wrote, and not one written about them', () => {
    const notes = [
      { id: 'a', about: 'teen', by: 'parent-user' },
      { id: 'b', about: 'teen', by: 'teen-user' },
      { id: 'c', about: 'ward', by: 'caregiver-user' },
    ];
    const by = (n: (typeof notes)[number]) => n.by;
    expect(notesInScope(notes, 'teen', 'teen-user', by).map((n) => n.id)).toEqual(['b']);
    expect(notesInScope(notes, 'child', 'child-user', by)).toEqual([]);
    expect(notesInScope(notes, 'caregiver', 'caregiver-user', by).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(notesInScope(notes, 'parent', 'parent-user', by).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('the screens show each reader what the rule gives them', () => {
  it('the care log narrows to the notes a reader wrote, and shows summaries only to a reader of every note', () => {
    const src = read('components/modules/care-module.tsx');
    expect(src).toContain("import { notesInScope, readsEveryNote } from '@/lib/care/note-scope';");
    expect(src).toContain('const seesEveryNote = readsEveryNote(role);');
    // The author column is the one 0510 reads for care_log.
    expect(src).toContain('notesInScope(entries ?? [], role, userId, (e) => e.created_by).filter((e) => e.member_id === recipientId)');
    const cards = between(src, '{/* Status cards */}', '{/* Quick log */}');
    expect(cards).toContain('{seesEveryNote && <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">');
    expect(at(src, "tr('careModule.onlyTheCareYouLogged'")).toBeLessThan(at(src, '{/* Status cards */}'));
    // Whoever writes a care note is its author, so they read it back.
    expect(src.match(/created_by: userId/g)?.length).toBe(2);
  });

  it('the behaviour page tells anyone but a reader of every note whose the notes are, before loading any', () => {
    const src = read('components/modules/behavior-module.tsx');
    const gate = between(src, 'export function BehaviorModule() {', 'function BehaviorLog() {');
    expect(gate).toContain('if (!readsEveryNote(role)) {');
    expect(gate).toContain("tr('behaviorModule.keptForParentsAndCaregivers')");
    expect(gate).toContain('return <BehaviorLog />;');
    expect(gate).not.toContain('useRealtimeQuery');
    // Whoever writes a behaviour note is its author (logged_by), so they read it back.
    expect(src).toContain('insert({ ...row, family_id: familyId, logged_by: userId })');
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['careModule.onlyTheCareYouLogged', 'behaviorModule.keptForParentsAndCaregivers', 'behaviorModule.keptForParentsAndCaregiversBody']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
      expect(m['careModule.onlyTheCareYouLogged'], locale).toContain('{name}');
    }
  });
});

describe('the database half', () => {
  it('reads each table by its own author column, and the probe pins that predicate', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("(values ('behavior_logs', 'logged_by'), ('care_log', 'created_by'))");
    expect(sql).toContain("'public.can_manage_family(family_id) or %I = auth.uid() or public.family_role(family_id) = ''caregiver''))'");
    expect(sql).toContain("'A note is read by a manager, its author or a caregiver'");
    const probe = read(PROBE);
    expect(probe).toContain("author := case t when 'behavior_logs' then 'logged_by' else 'created_by' end;");
    expect(probe).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR (%s = auth.uid()) OR (family_role(family_id) = ''caregiver''::member_role)))'");
  });
});
