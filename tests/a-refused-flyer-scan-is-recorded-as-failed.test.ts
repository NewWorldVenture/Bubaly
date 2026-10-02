import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Review on #788: the flyer scan returned the provider's Response out of
// `withAiRequest` and checked `ok` afterwards, so a provider 500 or 429 closed
// the request row as `completed` and recorded the model call as `ok: true`,
// while the caller got a 502. The real wrapper runs here; only its store is
// faked, so the status the row ends on is what is asserted.

const fetchWithDeadline = vi.fn();
const requestRows: Array<{ id: string; feature?: string | null; patches: Array<Record<string, unknown>> }> = [];
const modelCalls: Array<{ ok: boolean }> = [];

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};
const db = { from: () => { throw new Error('no table read expected'); } };

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-access', () => ({ refuseOverAIAllowance: async () => null }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: async () => ({ openaiKey: 'sk-test', model: 'gpt-4o' }) }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: (...a: unknown[]) => fetchWithDeadline(...a) }));
vi.mock('@/lib/ai/runs/store', () => ({
  createRequest: async (_scope: unknown, input: { feature?: string | null }) => {
    const id = `req-${requestRows.length + 1}`;
    requestRows.push({ id, feature: input.feature ?? null, patches: [] });
    return { ok: true, data: { id } };
  },
  updateRequest: async (_scope: unknown, id: string, patch: Record<string, unknown>) => {
    requestRows.find((r) => r.id === id)?.patches.push(patch);
    return { ok: true, data: null };
  },
}));
vi.mock('@/lib/ai/usage', () => ({
  recordModelCall: async (input: { ok: boolean }) => { modelCalls.push({ ok: input.ok }); },
}));

function scan() {
  return new NextRequest('http://localhost/api/ai/flyer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'c3ludGhldGlj', mediaType: 'image/png' }),
  });
}

const finalStatus = () => requestRows[0]?.patches.map((p) => p.status).filter(Boolean).at(-1);

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); fetchWithDeadline.mockReset(); requestRows.length = 0; modelCalls.length = 0; });

describe('a flyer scan the provider refused is recorded as failed', () => {
  for (const status of [500, 429]) {
    it(`provider ${status}: the caller gets 502 and the request row says failed`, async () => {
      fetchWithDeadline.mockResolvedValue(new Response('Synthetic provider refusal', { status }));
      const { POST } = await import('@/app/api/ai/flyer/route');
      const res = await POST(scan());
      expect(res.status).toBe(502);
      expect(requestRows).toHaveLength(1);
      expect(requestRows[0].feature).toBe('flyer.scan');
      expect(finalStatus()).toBe('failed');
      expect(modelCalls.length).toBeGreaterThan(0);
      expect(modelCalls.every((c) => c.ok === false)).toBe(true);
    });
  }

  it('control: a valid answer is recorded as completed', async () => {
    fetchWithDeadline.mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: '[]' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const { POST } = await import('@/app/api/ai/flyer/route');
    const res = await POST(scan());
    expect(res.status).toBe(200);
    expect(finalStatus()).toBe('completed');
    expect(modelCalls.every((c) => c.ok === true)).toBe(true);
  });
});
