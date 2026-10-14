// S11 — AI Assist for tax, documents, care, medical and the binder dropped
// read errors; S17 (AI half) — the medical insight read every member's visits
// for a teen or a child.
//
// `required()` turns a failed read into the route's 500 "Could not load data
// for this insight", and thirteen household kinds already passed every read
// through it. These five did not: `x.data ?? []` turned a failed read into
// "Tax documents: 0 total", "No documents stored.", "No care entries logged.",
// "No records.", and the model told the family to start adding what they
// already have, at HTTP 200. Two prompts also read columns their tables do not
// have: every document was "Untitled" (the column is `title`), and "Deductible
// items" was always 0 (tax_documents has no `is_deductible`).
//
// And the medical summary is offered to every role; for a teen or child it sent
// the household's visits to the model, while the Medical page shows them their
// own (the held 0506, lib/health/record-scope.ts).
//
// Driven through POST /api/ai/insights, against an in-memory household.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), role: 'parent' }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: h.role, member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }), describeAIError: () => ({ message: 'unavailable' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Free plan's AI allowance (N18) has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAccess: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null, refuseIfLocked: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/ai/insights/route';

let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let failing: string | null;

beforeEach(() => {
  base = createInMemorySupabase<SupabaseClient<Database>>();
  failing = null;
  h.role = 'parent';
  h.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  h.complete.mockReset().mockResolvedValue({ text: 'A grounded suggestion.' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  base.seed('family_members', [
    { id: 'member-one', family_id: FAMILY, display_name: 'Ada', is_active: true, user_id: 'user-one' },
    { id: 'member-two', family_id: FAMILY, display_name: 'Ben', is_active: true, user_id: 'user-two' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const ask = (kind: string) => POST(new Request('https://fixture.invalid/api/ai/insights', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }),
}));
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

const READS: [string, string][] = [
  ['tax', 'tax_documents'],
  ['documents', 'documents'],
  ['care', 'care_log'],
  ['medical', 'health_visits'],
  ['medical', 'appointments'],
  ['binder', 'household_info'],
];

describe('a sensitive insight is not built on a read that failed', () => {
  it.each(READS)('%s: a failed %s read answers "could not load", and the model is not asked', async (kind, table) => {
    failing = table;

    const response = await ask(kind);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'insights.couldNotLoadDataFor' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each([...new Set(READS.map(([kind]) => kind))])('%s still answers when every read succeeds', async (kind) => {
    const response = await ask(kind);
    expect(response.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe('the prompts read the columns their tables have', () => {
  it('the documents insight names each file by its title', async () => {
    base.seed('documents', [{ id: 'd1', family_id: FAMILY, title: 'Home insurance declarations', category: 'insurance', created_at: '2026-09-01T00:00:00Z' }]);

    expect((await ask('documents')).status).toBe(200);

    expect(prompt()).toContain('"Home insurance declarations"');
    expect(prompt()).not.toContain('Untitled');
  });

  it('the tax insight counts deductible items by category, as the vault does', async () => {
    base.seed('tax_documents', [
      { id: 't1', family_id: FAMILY, tax_year: 2025, category: 'charity', name: 'Food bank receipt', created_at: '2026-01-10T00:00:00Z' },
      { id: 't2', family_id: FAMILY, tax_year: 2025, category: 'medical', name: 'Orthodontist invoice', created_at: '2026-01-11T00:00:00Z' },
      { id: 't3', family_id: FAMILY, tax_year: 2025, category: 'w2', name: 'W-2 Acme', created_at: '2026-01-12T00:00:00Z' },
    ]);

    expect((await ask('tax')).status).toBe(200);

    expect(prompt()).toContain('Deductible items: 2.');
  });
});

describe('the medical insight reads what the Medical page shows the asker (S17)', () => {
  beforeEach(() => {
    base.seed('health_visits', [
      { id: 'v-own', family_id: FAMILY, member_id: 'member-one', kind: 'medical', title: 'Sports physical', visit_date: '2026-09-02', created_by: 'parent-user' },
      { id: 'v-sibling', family_id: FAMILY, member_id: 'member-two', kind: 'medical', title: 'Psychiatry follow-up', visit_date: '2026-09-05', created_by: 'parent-user' },
      { id: 'v-authored', family_id: FAMILY, member_id: 'member-two', kind: 'dental', title: 'Lost filling (logged by Ada)', visit_date: '2026-09-07', created_by: 'user-one' },
    ]);
  });

  it.each(['teen', 'child'])('a %s is summarised their own visits and the ones they recorded, not a sibling\'s', async (role) => {
    h.role = role;

    expect((await ask('medical')).status).toBe(200);

    expect(prompt()).toContain('Sports physical');
    expect(prompt()).toContain('Lost filling (logged by Ada)');
    expect(prompt()).not.toContain('Psychiatry follow-up');
  });

  it.each(['parent', 'adult'])('a %s is summarised the household\'s', async (role) => {
    h.role = role;

    expect((await ask('medical')).status).toBe(200);

    expect(prompt()).toContain('Sports physical');
    expect(prompt()).toContain('Psychiatry follow-up');
  });
});
