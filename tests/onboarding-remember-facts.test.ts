// M30 — what a family says during onboarding becomes something Bubaly knows.
//
// The wizard asked how many adults and children a household has, how old the
// children are, where it lives and what it wants help with, then wrote all of
// it into `family_onboarding` and nowhere the assistant reads. So Bubaly asked
// again. These cases pin the derivation (pure) and the write (through the real
// memory service against an in-memory Postgres), including the one rule that
// makes the write safe to do at all: a family with memory switched off is not
// remembered from.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { ONBOARDING_FACT_NOTE, ONBOARDING_FACT_SOURCE, onboardingFacts } from '@/lib/onboarding/facts';
import { rememberOnboardingFacts } from '@/lib/onboarding/remember';
import type { ServiceScope } from '@/lib/services/types';

const ANSWERS = {
  householdAdults: 2,
  householdChildren: 2,
  childAges: [6, 9],
  region: 'Austin',
  country: 'US',
  goals: ['meals', 'chores'],
};

describe('onboardingFacts', () => {
  it('derives one fact per answered question, in a stable order', () => {
    expect(onboardingFacts(ANSWERS)).toEqual([
      { category: 'about', key: 'Household size', content: '2 adults and 2 children' },
      { category: 'about', key: 'Children’s ages', content: '6, 9' },
      { category: 'about', key: 'Where the family lives', content: 'Austin, US' },
      { category: 'preference', key: 'What this family wants help with', content: 'Meal planning, Chores & allowance' },
    ]);
  });

  it('says "1 adult" and "1 child" rather than pluralising everything', () => {
    const [size] = onboardingFacts({ ...ANSWERS, householdAdults: 1, householdChildren: 1 });
    expect(size.content).toBe('1 adult and 1 child');
  });

  it('remembers nothing at all when the About step was skipped', () => {
    expect(onboardingFacts({ householdAdults: 0, householdChildren: 0, childAges: [], goals: [] })).toEqual([]);
  });

  it('leaves out the questions that were not answered', () => {
    const facts = onboardingFacts({ householdAdults: 2, householdChildren: 0, childAges: [], goals: [] });
    expect(facts.map((f) => f.key)).toEqual(['Household size']);
  });

  it('drops placeholder child ages rather than recording phantom infants', () => {
    const facts = onboardingFacts({ ...ANSWERS, childAges: [0, 7, 0] });
    expect(facts.find((f) => f.key === 'Children’s ages')?.content).toBe('7');
  });

  it('ignores a goal value the wizard does not offer', () => {
    const facts = onboardingFacts({ ...ANSWERS, goals: ['meals', 'not-a-real-goal'] });
    expect(facts.find((f) => f.key === 'What this family wants help with')?.content).toBe('Meal planning');
  });

  it('records only what the person typed — no inference about the household', () => {
    const contents = onboardingFacts(ANSWERS).map((f) => f.content).join(' | ');
    expect(contents).not.toMatch(/probably|likely|estimated/i);
  });
});

// ── The write ────────────────────────────────────────────────────────────────

const FAMILY = 'family-1';
const USER = 'user-1';
const MEMBER = 'member-1';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

const scope = (): ServiceScope => ({
  db: db as unknown as ServiceScope['db'],
  familyId: FAMILY,
  userId: USER,
  memberId: MEMBER,
  role: 'parent',
  actorKind: 'member',
  tz: 'America/Chicago',
});

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_facts: { member_id: null, notes: null, is_pinned: false, source: 'user', confidence: null, expires_at: null },
      family_ai_settings: { memory_enabled: true },
    },
  });
});

describe('rememberOnboardingFacts', () => {
  it('writes every derived answer into family_facts', async () => {
    const res = await rememberOnboardingFacts(scope(), ANSWERS);
    expect(res).toMatchObject({ written: 4, failed: 0, memoryDisabled: false });
    const rows = db.table('family_facts');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.label)).toEqual([
      'Household size', 'Children’s ages', 'Where the family lives', 'What this family wants help with',
    ]);
    expect(rows.every((r) => r.family_id === FAMILY)).toBe(true);
  });

  it('marks them as confirmed facts the person stated, with where they came from', async () => {
    await rememberOnboardingFacts(scope(), ANSWERS);
    const [row] = db.table('family_facts');
    // The provenance the CHECK constraint allows, plus the note that says
    // onboarding — see lib/onboarding/facts.ts for why it is not 'onboarding'.
    expect(row.source).toBe(ONBOARDING_FACT_SOURCE);
    expect(row.source).toBe('user');
    expect(row.notes).toBe(ONBOARDING_FACT_NOTE);
    expect(row.created_by).toBe(USER);
    expect(row.member_id).toBeNull(); // household facts, not one child's
  });

  it('lands in the confirmed table, not the suggestion inbox', async () => {
    await rememberOnboardingFacts(scope(), ANSWERS);
    expect(db.table('family_playbook_suggestions')).toHaveLength(0);
  });

  it('writes nothing when the family has memory switched off', async () => {
    db.seed('family_ai_settings', [{ family_id: FAMILY, memory_enabled: false }]);
    const res = await rememberOnboardingFacts(scope(), ANSWERS);
    expect(res).toMatchObject({ written: 0, memoryDisabled: true });
    expect(db.table('family_facts')).toHaveLength(0);
  });

  it('remembers when the setting row says memory is on', async () => {
    db.seed('family_ai_settings', [{ family_id: FAMILY, memory_enabled: true }]);
    const res = await rememberOnboardingFacts(scope(), ANSWERS);
    expect(res.written).toBe(4);
  });

  it('does not read the settings at all when there is nothing to remember', async () => {
    const res = await rememberOnboardingFacts(scope(), { householdAdults: 0, householdChildren: 0, childAges: [], goals: [] });
    expect(res).toMatchObject({ written: 0, memoryDisabled: false });
    expect(db.table('family_facts')).toHaveLength(0);
  });

  it('updates rather than duplicates when the same answers arrive twice', async () => {
    await rememberOnboardingFacts(scope(), ANSWERS);
    await rememberOnboardingFacts(scope(), { ...ANSWERS, householdChildren: 3, childAges: [6, 9, 12] });
    const rows = db.table('family_facts');
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.label === 'Household size')?.value).toBe('2 adults and 3 children');
    expect(rows.find((r) => r.label === 'Children’s ages')?.value).toBe('6, 9, 12');
  });
});
