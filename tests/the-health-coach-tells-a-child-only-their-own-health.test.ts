// F-G09 review (#674): a non-manager must not obtain another member's health
// context from the AI health coach — whether or not migration 0465 has been
// applied to the database.
//
// 0465 narrows the READ of `medications` so a child sees only their own. But a
// migration lands on production only when an operator applies it, and until
// then a child's read still returns every member's rows. The route therefore
// cannot lean on RLS for this: a GENERAL question (no member named) used to
// read the family's active medications and send each name and dosage to the
// model, which would repeat a sibling's prescription back to the child.
//
// Synthetic, end to end through the real route: a fake database that honours
// the query's filters, in two modes —
//   before 0465   RLS returns every family row to any member (today's prod)
//   after 0465    RLS returns a non-manager only the rows naming them
// — and the exact prompt handed to the model is what is asserted on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const KID = 'member-kid';
const SIBLING = 'member-sibling';
const PARENT = 'member-parent';

const DATA: Record<string, Row[]> = {
  family_members: [
    { id: KID, family_id: 'fam', display_name: 'Kid', birthday: null },
    { id: SIBLING, family_id: 'fam', display_name: 'Sibling', birthday: null },
  ],
  medical_profiles: [
    { member_id: KID, family_id: 'fam', blood_type: 'O+', allergies: 'KID-ALLERGY', conditions: null, current_medications: null },
    { member_id: SIBLING, family_id: 'fam', blood_type: 'A-', allergies: 'SIBLING-ALLERGY', conditions: 'SIBLING-CONDITION', current_medications: null },
  ],
  medications: [
    { family_id: 'fam', member_id: KID, is_active: true, name: 'KidVitamin', dosage: '1 tab', instructions: null },
    { family_id: 'fam', member_id: SIBLING, is_active: true, name: 'SiblingSertraline', dosage: '50mg', instructions: null },
    { family_id: 'fam', member_id: PARENT, is_active: true, name: 'ParentStatin', dosage: '10mg', instructions: null },
    { family_id: 'fam', member_id: null, is_active: true, name: 'WholeFamilyUnassigned', dosage: '5ml', instructions: null },
  ],
  symptom_logs: [
    { member_id: SIBLING, family_id: 'fam', symptom: 'SIBLING-SYMPTOM', severity: 3, started_at: '2026-09-01', status: 'active', notes: null },
  ],
};

const mocks = vi.hoisted(() => ({
  role: 'child' as string,
  selfId: 'member-kid',
  applied0465: false,
  reads: [] as string[],
  prompts: [] as string[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: vi.fn(async () => ({
    user: { id: 'u' },
    active: { role: mocks.role, familyId: 'fam', family: { timezone: 'UTC' }, member: { id: mocks.selfId } },
  })),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// Every AI route now counts against the family's monthly allowance (F19).
// This file is about whose health the coach is grounded on, so the family is
// on Basic, whose allowance is unlimited: the real check runs and passes.
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 1,
  // The same, unlocked family as the whole entitlement the AI gates read.
  resolveFamilyEntitlement: async () => ({ effectiveLevel: 1, locked: false, closed: false, inTrial: false, trialEndsAt: null }),
}));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({}) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, fn: (obs: { used: () => void }) => Promise<string>) => fn({ used: () => {} }),
}));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  describeAIError: () => ({ message: 'ai error' }),
  resolveProvider: async () => ({
    complete: async ({ messages }: { messages: { content: string }[] }) => {
      mocks.prompts.push(messages.map((m) => m.content).join('\n'));
      return { text: 'ok', model: 'test', usage: {} };
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from: (table: string) => {
      mocks.reads.push(table);
      const filters: [string, unknown][] = [];
      const visible = () => (DATA[table] ?? [])
        .filter((r) => filters.every(([k, v]) => r[k] === v))
        // After 0465 a non-manager's `medications` read returns only their own
        // rows; before it, RLS is family-wide. The other tables are the
        // route's to scope by member id (0438 already covers the profile).
        .filter((r) => !(mocks.applied0465 && table === 'medications' && !['parent', 'adult'].includes(mocks.role))
          || r.member_id === mocks.selfId);
      const b: Record<string, unknown> = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
        maybeSingle: async () => ({ data: visible()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: visible(), error: null }),
      };
      return b;
    },
  }),
}));

async function ask(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/ai/health/coach/route');
  return POST(new Request('https://app.example.test/api/ai/health/coach', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

const OTHER_PEOPLES = ['SiblingSertraline', 'ParentStatin', 'WholeFamilyUnassigned', 'SIBLING-ALLERGY', 'SIBLING-CONDITION', 'SIBLING-SYMPTOM'];

beforeEach(() => {
  mocks.reads = []; mocks.prompts = [];
  mocks.role = 'child'; mocks.selfId = KID;
});

describe.each([false, true])('the health coach, with 0465 applied: %s', (applied) => {
  beforeEach(() => { mocks.applied0465 = applied; });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s asking a GENERAL question is grounded on their own medicines only', async (role) => {
    mocks.role = role;
    const res = await ask({ question: 'Can I take ibuprofen?' });
    expect(res.status).toBe(200);
    const [prompt] = mocks.prompts;
    expect(prompt).toContain('KidVitamin');
    for (const other of OTHER_PEOPLES) expect(prompt, other).not.toContain(other);
  });

  it('a child asking about THEMSELVES is grounded on their own record', async () => {
    const res = await ask({ question: 'Why am I tired?', memberId: KID });
    expect(res.status).toBe(200);
    const [prompt] = mocks.prompts;
    expect(prompt).toContain('KidVitamin');
    expect(prompt).toContain('KID-ALLERGY');
    for (const other of OTHER_PEOPLES) expect(prompt, other).not.toContain(other);
  });

  it('a child asking about a SIBLING is refused before any health read or model call', async () => {
    const res = await ask({ question: 'What does my sibling take?', memberId: SIBLING });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'coach.onlyYourOwnHealth' });
    expect(mocks.reads).toEqual([]);
    expect(mocks.prompts).toEqual([]);
  });

  it.each(['parent', 'adult'])('a %s asking a general question is still grounded on the whole family (control)', async (role) => {
    mocks.role = role; mocks.selfId = PARENT;
    const res = await ask({ question: 'Any interactions to watch?' });
    expect(res.status).toBe(200);
    const [prompt] = mocks.prompts;
    for (const name of ['KidVitamin', 'SiblingSertraline', 'ParentStatin', 'WholeFamilyUnassigned']) expect(prompt).toContain(name);
  });

  it('a parent may still ask about a named child (control)', async () => {
    mocks.role = 'parent'; mocks.selfId = PARENT;
    const res = await ask({ question: 'Is this dose right?', memberId: SIBLING });
    expect(res.status).toBe(200);
    expect(mocks.prompts[0]).toContain('SiblingSertraline');
    expect(mocks.prompts[0]).toContain('SIBLING-ALLERGY');
  });
});
