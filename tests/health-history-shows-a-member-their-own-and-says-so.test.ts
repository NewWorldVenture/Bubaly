import { createElement, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The visit and vaccination histories on /dashboard/medical and /dashboard/dental.
//
// S17 — a teen or child read every member's visits (reason, outcome, provider,
//   cost) and vaccinations (lot numbers, notes) under the default "Everyone"
//   filter: 0481 still gives them the family-wide read, and the modules only
//   narrowed the filter's OPTIONS. lib/health/record-scope.ts says the screen
//   shows the held 0506's rows before and after it is released — your own
//   record, and what you recorded — and sleep and nutrition already do.
// S14 — a caregiver, whom 0481 already narrows, saw "No visits logged" and
//   "No immunizations recorded" with an invitation to add records they cannot
//   add: an empty household history, where the household's was withheld.
//
// Each case drives the REAL module against an in-memory database seeded with
// exactly the rows that role's session reads today.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);

const { HealthVisitsModule } = await import('@/components/modules/health-visits-module');
const { ImmunizationsModule } = await import('@/components/modules/immunizations-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

const PARENT = { id: 'member-parent', display_name: 'Ada', role: 'parent', user_id: 'user-parent', is_active: true, color: null, birthday: null };
const TEEN = { id: 'member-teen', display_name: 'Bo', role: 'teen', user_id: 'user-teen', is_active: true, color: null, birthday: null };
const SIBLING = { id: 'member-sib', display_name: 'Cal', role: 'child', user_id: 'user-sib', is_active: true, color: null, birthday: null };
const SITTER = { id: 'member-sitter', display_name: 'Dee', role: 'caregiver', user_id: 'user-sitter', is_active: true, color: null, birthday: null };

function viewAs(self: typeof PARENT) {
  h.app.members = [PARENT, TEEN, SIBLING, SITTER];
  h.app.selfMember = self;
  h.app.userId = self.user_id;
  (h.app as Record<string, unknown>).role = self.role;
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = (Component: ComponentType) => render(h.hooks, createElement(Component));

function seedHousehold() {
  db.seed('health_visits', [
    { id: 'v-teen', family_id: FAMILY, member_id: TEEN.id, kind: 'medical', title: 'Sports physical', visit_date: '2026-09-02', reason: 'Season clearance', created_by: 'user-parent' },
    { id: 'v-sib', family_id: FAMILY, member_id: SIBLING.id, kind: 'medical', title: 'Therapy intake', visit_date: '2026-09-05', reason: 'Anxiety at school', outcome: 'Weekly sessions', follow_up_date: '2026-12-01', created_by: 'user-parent' },
  ]);
  db.seed('immunizations', [
    { id: 'i-teen', family_id: FAMILY, member_id: TEEN.id, vaccine: 'Tdap', date_given: '2026-08-01', lot_number: 'LOT-TEEN', created_by: 'user-parent' },
    { id: 'i-sib', family_id: FAMILY, member_id: SIBLING.id, vaccine: 'HPV', date_given: '2026-08-02', next_due_date: '2026-11-01', lot_number: 'LOT-SIB', notes: 'Fainted after dose', created_by: 'user-parent' },
  ]);
}

describe('S17 — a teen sees their own health history, not a sibling\'s', () => {
  it('visits: the teen\'s own visit, and no sibling reason, outcome or follow-up', () => {
    viewAs(TEEN);
    seedHousehold();

    const tree = screen(HealthVisitsModule);

    expect(has(tree, 'Sports physical')).toBe(true);
    for (const withheld of ['Therapy intake', 'Anxiety at school', 'Weekly sessions']) expect(has(tree, withheld), withheld).toBe(false);
    expect(has(tree, t('healthVisitsModule.onlyYourOwn'))).toBe(true);
  });

  it('vaccinations: the teen\'s own, and no sibling lot number, note or dose coming due', () => {
    viewAs(TEEN);
    seedHousehold();

    const tree = screen(ImmunizationsModule);

    expect(has(tree, 'Tdap')).toBe(true);
    for (const withheld of ['HPV', 'LOT-SIB', 'Fainted after dose']) expect(has(tree, withheld), withheld).toBe(false);
    expect(has(tree, t('immunizations.dosesComingDue'))).toBe(false);
    expect(has(tree, t('immunizationsModule.onlyYourOwn'))).toBe(true);
  });

  it('a parent still sees the household\'s, with no narrowing note', () => {
    viewAs(PARENT);
    seedHousehold();

    const visits = screen(HealthVisitsModule);
    expect(has(visits, 'Therapy intake')).toBe(true);
    expect(has(visits, t('healthVisitsModule.onlyYourOwn'))).toBe(false);
    resetHookSlots(h.hooks);
    const shots = screen(ImmunizationsModule);
    expect(has(shots, 'LOT-SIB')).toBe(true);
    expect(has(shots, t('immunizationsModule.onlyYourOwn'))).toBe(false);
  });
});

describe('S14 — a caregiver is not told the household has no history', () => {
  it('visits: no "No visits logged", and the note that a parent or adult sees the household\'s', () => {
    viewAs(SITTER);
    // 0481: a caregiver's session reads only their own rows and the ones they wrote — here, none.

    const tree = screen(HealthVisitsModule);

    expect(has(tree, t('healthVisits.noVisitsLogged'))).toBe(false);
    expect(has(tree, t('healthVisitsModule.addADoctorDentistOr'))).toBe(false);
    expect(has(tree, t('healthVisitsModule.noneOfYours'))).toBe(true);
    expect(has(tree, t('healthVisitsModule.onlyYourOwn'))).toBe(true);
  });

  it('vaccinations: no "No immunizations recorded", and the same note', () => {
    viewAs(SITTER);

    const tree = screen(ImmunizationsModule);

    expect(has(tree, t('immunizations.noImmunizationsRecorded'))).toBe(false);
    expect(has(tree, t('immunizationsModule.trackVaccinesAndNextDue'))).toBe(false);
    expect(has(tree, t('immunizationsModule.noneOfYours'))).toBe(true);
    expect(has(tree, t('immunizationsModule.onlyYourOwn'))).toBe(true);
  });

  it('a visit the caregiver recorded for a child is theirs to see', () => {
    viewAs(SITTER);
    db.seed('health_visits', [{ id: 'v-logged', family_id: FAMILY, member_id: SIBLING.id, kind: 'medical', title: 'Urgent care for a sprain', visit_date: '2026-10-01', created_by: 'user-sitter' }]);

    expect(has(screen(HealthVisitsModule), 'Urgent care for a sprain')).toBe(true);
  });
});
