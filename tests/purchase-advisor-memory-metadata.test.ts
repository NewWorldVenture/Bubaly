import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), complete: vi.fn(), buildUser: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The monthly allowance (F19) is its own suite (every-ai-route-counts-against-the-allowance); this one is the advisor's memory metadata.
vi.mock('@/lib/server/ai-access', () => ({ refuseOverAIAllowance: async () => null }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: mocks.complete }),
  describeAIError: () => ({ message: 'Synthetic provider refusal' }),
}));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: async (_scope: unknown, _meta: unknown, run: (obs: { used: () => void; failed: () => void }) => Promise<string>) =>
    run({ used: () => {}, failed: () => {} }),
}));
vi.mock('@/lib/ai/insights', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/insights')>();
  mocks.buildUser.mockImplementation(actual.INSIGHTS.purchase_advisor.buildUser);
  return {
    ...actual,
    INSIGHTS: { ...actual.INSIGHTS, purchase_advisor: { ...actual.INSIGHTS.purchase_advisor, buildUser: mocks.buildUser } },
  };
});

import { POST } from '@/app/api/ai/insights/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.complete.mockResolvedValue({ text: 'Synthetic advice', model: 'inert' });
});
afterEach(() => vi.restoreAllMocks());

function wire(role: string) {
  const db = createInMemorySupabase();
  db.seed('family_members', [{ id: 'member-reader', family_id: 'family-test', display_name: 'Synthetic reader', is_active: true }]);
  const base = { family_id: 'family-test', category: 'other', source: 'user', expires_at: null, value: 'Synthetic value', notes: null };
  db.seed('family_facts', [
    { ...base, id: 'ordinary', category: 'preference', label: 'Blender preference', value: 'Prefer a compact blender with a washable jug', notes: 'Taco night on Tuesday' },
    { ...base, id: 'sensitive-note', label: 'HiddenNoteMarker', notes: 'passport number SYNTHETIC-NOTE-MARKER' },
    { ...base, id: 'sensitive-value', label: 'HiddenValueMarker', value: 'password SYNTHETIC-VALUE-MARKER' },
    { ...base, id: 'expired', label: 'ExpiredMarker', expires_at: '2000-01-01T00:00:00Z' },
    { ...base, id: 'foreign', family_id: 'other-family', label: 'ForeignMarker' },
  ]);
  mocks.context.mockResolvedValue({
    user: { id: 'synthetic-user' }, memberships: [],
    active: { familyId: 'family-test', role, member: { id: 'member-reader' }, family: { id: 'family-test', name: 'Synthetic household', timezone: 'UTC' } },
  });
  mocks.server.mockResolvedValue(db);
}

async function advisorPrompt(role: string) {
  wire(role);
  const response = await POST(new Request('http://synthetic.invalid/api/ai/insights', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'purchase_advisor', params: { item: 'blender', question: 'Compare a synthetic household item' } }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: 'Synthetic advice' });
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.buildUser).toHaveBeenCalledOnce();
  // Observe the actual prompt registry's input while executing its real
  // formatter. It uses only matching preferences today; arbitrary notes need
  // not be printed for the route's metadata boundary to be checked.
  return mocks.buildUser.mock.calls[0][0].rows.family_facts as { id: string; notes: string | null }[];
}

describe('purchase advisor memory metadata', () => {
  it('preserves a matching benign preference in the actual prompt sent to the inert provider', async () => {
    const facts = await advisorPrompt('child');
    expect(facts.map((fact) => fact.id)).toEqual(['ordinary']);
    const completionInput = mocks.complete.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    const prompt = completionInput.messages.find((message) => message.role === 'user')!.content;
    expect(prompt).toContain('Remembered preferences: Blender preference: Prefer a compact blender with a washable jug');
    expect(prompt).not.toContain('SYNTHETIC-NOTE-MARKER');
    expect(prompt).not.toContain('SYNTHETIC-VALUE-MARKER');
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('withholds sensitive notes from the %s prompt assembly', async (role) => {
    const facts = await advisorPrompt(role);
    expect(facts.map((f) => f.id)).toEqual(['ordinary']);
    expect(facts[0].notes).toBe('Taco night on Tuesday');
  });

  it.each(['parent', 'adult'])('preserves authorized %s context while excluding foreign and expired rows', async (role) => {
    const facts = await advisorPrompt(role);
    expect(facts.map((f) => f.id)).toEqual(['ordinary', 'sensitive-note', 'sensitive-value']);
    expect(facts.find((f) => f.id === 'sensitive-note')?.notes).toContain('SYNTHETIC-NOTE-MARKER');
  });
});
