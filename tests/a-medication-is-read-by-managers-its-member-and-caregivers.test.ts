import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { medicationReaderIds, readsEveryMedication } from '@/lib/medications/readers';
import { medicationSuggestions, type FamilySnapshot } from '@/lib/autopilot/engine';
import { bodyOf } from './helpers/source-order';

// The held 0511, the owner's decision: a medication is read by a parent or
// adult, a caregiver (who may give it) and the member it is for; one saved
// with no member (the form's default) by the first two. A refill names the
// drug only to those readers, and the Medicines page asks for what the rule
// gives each viewer.

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
const sent = vi.hoisted(() => ({ notices: [] as { recipients: unknown; title: string; body: string | null }[] }));
vi.mock('@/lib/services/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/notifications')>()),
  notify: vi.fn(async (_scope: unknown, input: { recipients: unknown; title: string; body?: string | null }) => {
    sent.notices.push({ recipients: input.recipients, title: input.title, body: input.body ?? null });
    return { ok: true, data: { created: 1 } };
  }),
}));
const { runAutopilotScan } = await import('@/lib/autopilot/scan');

type DB = SupabaseClient<Database>;
const FAMILY = 'f1';
const MIGRATION = 'supabase/reserved/0511_a_medication_is_read_by_managers_its_member_and_caregivers.sql';
const PROBE = 'docs/audit/reserved/a-medication-is-read-by-managers-its-member-and-caregivers-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');
const echo = (key: string, params?: Record<string, string | number>) => `${key} ${JSON.stringify(params ?? {})}`;

const snapshot = (over: Partial<FamilySnapshot> = {}): FamilySnapshot => ({
  today: '2026-09-21', tz: 'UTC',
  renewals: [], appointments: [], overdueChores: [], birthdays: [], lingeringGroceries: [], events: [],
  subscriptions: [], stressSignals: [], medications: [], favoriteMeals: [], plannedDinnerDays: [], insurance: [],
  ...over,
});

const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'sitter', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ava', role: 'child' }, { id: 'neighbour', role: 'guest' },
];

afterEach(() => { sent.notices = []; });

describe('who reads a medication', () => {
  it('a parent, an adult and a caregiver read every one; a teen, a child and a guest do not', () => {
    for (const role of ['parent', 'adult', 'caregiver']) expect(readsEveryMedication(role), role).toBe(true);
    for (const role of ['teen', 'child', 'guest', null, undefined]) expect(readsEveryMedication(role), String(role)).toBe(false);
  });

  it('adds the member it is for, and no one for a medication saved with no member', () => {
    expect(medicationReaderIds(ROSTER, 'ava')).toEqual(['mum', 'gran', 'sitter', 'ava']);
    expect(medicationReaderIds(ROSTER, null)).toEqual(['mum', 'gran', 'sitter']);
  });
});

describe('a refill names the drug only to its readers', () => {
  it.each([['a member', 'ava'], ['no member', null]])('the card the household reads says "a prescription" (%s)', (_label, memberId) => {
    const [draft] = medicationSuggestions(snapshot({ medications: [
      { id: 'med-1', name: 'Sertraline', memberId, refillOn: '2026-09-23', reminderDays: 7 },
    ] }));
    expect(draft.title).toBe('Prescription refill due in 2 days');
    expect(JSON.stringify([draft.title, draft.detail, draft.payload])).not.toContain('Sertraline');
    expect(draft.notificationTitle).toBe('Refill Sertraline in 2 days');
    expect(draft.audience).toBe('medication-readers');
  });

  it('the scan tells the readers, by name, and writes no drug name where the family reads', async () => {
    const db = createInMemorySupabase<DB>({
      uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']] },
      rpc: { ensure_default_grocery_list: () => 'list-1' },
    });
    db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
    db.seed('family_members', ROSTER.map((m) => ({ ...m, family_id: FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true })));
    db.seed('medications', [
      { id: 'med-ava', family_id: FAMILY, name: 'Cetirizine', member_id: 'ava', refill_on: '2026-09-22', refill_reminder_days: 7, is_active: true },
      { id: 'med-mum', family_id: FAMILY, name: 'Sertraline', member_id: null, refill_on: '2026-09-22', refill_reminder_days: 7, is_active: true },
    ]);
    await runAutopilotScan(db, FAMILY, 'u-mum', 'UTC', 'en-US', echo, new Date('2026-09-21T06:30:00Z'));

    const refills = sent.notices.filter((n) => /Cetirizine|Sertraline/.test(n.title));
    expect(refills).toHaveLength(2);
    expect(refills.find((n) => n.title.includes('Cetirizine'))?.recipients).toEqual(['mum', 'gran', 'sitter', 'ava']);
    expect(refills.find((n) => n.title.includes('Sertraline'))?.recipients).toEqual(['mum', 'gran', 'sitter']);
    expect(sent.notices.filter((n) => n.recipients === 'family').map((n) => n.title).join(' ')).not.toMatch(/Cetirizine|Sertraline/);
    const familyRead = JSON.stringify([db.table('autopilot_suggestions'), db.table('reminders')]);
    expect(familyRead).not.toMatch(/Cetirizine|Sertraline/);
    expect(db.table('autopilot_suggestions').filter((s) => s.kind === 'medication')).toHaveLength(2);
  });

  it('cannot tell who the readers are, so tells the managers, never the family', () => {
    const src = read('lib/autopilot/scan.ts');
    expect(src).toContain("privateTo = members ? medicationReaderIds(members, d.memberId) : 'managers';");
    expect(src).toContain("recipients: privateTo ?? 'family',");
  });
});

describe('the Medicines page asks for what the rule gives each viewer', () => {
  const src = read('components/modules/medications-module.tsx');

  it('a caregiver reads the household\'s medicines; anyone else their own', () => {
    expect(src).toContain("import { readsEveryMedication } from '@/lib/medications/readers';");
    expect(src).toContain('const readsEveryMedicine = readsEveryMedication(role);');
    expect(src).toContain('const ownMemberOnly = readsEveryMedicine ? null : (selfMember?.id ?? NIL_UUID);');
    expect(src).toContain('{readsEveryMedicine ? (');
  });

  it('doses stay a manager\'s or the member\'s own, a caregiver\'s included', () => {
    expect(src).toContain('const ownDosesOnly = canEdit ? null : (selfMember?.id ?? NIL_UUID);');
    const doses = bodyOf(src, "table: 'medication_doses'", '});');
    expect(doses).toContain("return ownDosesOnly ? q.eq('member_id', ownDosesOnly) : q;");
    expect(src).toContain('&& (ownDosesOnly === null || m.member_id === ownDosesOnly)))');
    expect(src).toContain('visibleMeds.filter((m) => ownDosesOnly === null || m.member_id === ownDosesOnly)');
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      expect(m['medicationsModule.noMedicinesForTheHousehold'], locale).toBeTruthy();
    }
  });
});

describe('the database half', () => {
  it('reads with the decided predicate, with no household-wide exception, and the probe pins it', () => {
    const sql = read(MIGRATION);
    const policy = bodyOf(sql, 'create policy "A medication is read by a manager, its member or a caregiver"', ';');
    expect(policy).toContain('public.can_manage_family(family_id)');
    expect(policy).toContain('public.is_self_member(member_id)');
    expect(policy).toContain("public.family_role(family_id) = 'caregiver'");
    expect(policy).not.toContain('member_id is null');
    expect(read(PROBE)).toContain("'(is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id) OR (family_role(family_id) = ''caregiver''::member_role)))'");
  });
});
