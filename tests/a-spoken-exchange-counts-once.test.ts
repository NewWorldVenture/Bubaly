import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F19, the owner's decision of 2026-10-02 (#771 review 5391362628, follow-up
// 5391604223): one spoken exchange counts as ONE request — the assistant turn.
// Transcription admits the exchange; speech that names its turn rides on it.
// These drive the real voice routes and the real allowance helper against an
// in-memory ai_requests ledger on a Free family (10 a month).

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; family_id: string; requested_by: string | null; feature: string; created_at: string }>,
  inserts: 0,
}));

const TURN = '11111111-1111-4111-8111-111111111111';
const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};

function client() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from(table: string) {
      if (table !== 'ai_requests') throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string, opts?: { head?: boolean }) => {
          if (opts?.head) {
            // The monthly count: select(..., { head: true }).eq(family).gte(created_at)
            return { eq: (_c: string, fam: string) => ({ gte: async () => ({ count: state.rows.filter((r) => r.family_id === fam).length, error: null }) }) };
          }
          // isCountedExchange: select(...).eq('id', id).maybeSingle()
          return { eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: state.rows.find((r) => r.id === id) ?? null, error: null }) }) };
        },
        insert: () => { state.inserts += 1; throw new Error('voice must not file a request'); },
      };
    },
  };
}

vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 0,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => ctx }));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => ctx }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => ({ 'ai-requests': 'free' }),
  getFeatureTiersByHref: async () => ({}),
}));
vi.mock('@/lib/ai/settings', () => ({ getOpenAIKey: async () => 'sk-test' }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
const fetchWithDeadline = vi.fn();
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: (...a: unknown[]) => fetchWithDeadline(...a) }));

function seed(n: number) {
  for (let i = 0; i < n; i++) {
    state.rows.push({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, family_id: 'fam-1', requested_by: 'user-1', feature: 'notes.summary', created_at: new Date().toISOString() });
  }
}
function turnRow(over: Partial<(typeof state.rows)[number]> = {}) {
  state.rows.push({ id: TURN, family_id: 'fam-1', requested_by: 'user-1', feature: 'assistant.stream', created_at: new Date().toISOString(), ...over });
}
function transcribe() {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'speech.webm');
  return new NextRequest('http://localhost/api/ai/voice/transcribe', { method: 'POST', body: form });
}
function speak(exchangeId?: string) {
  return new NextRequest('http://localhost/api/ai/voice/speak', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Dinner is planned.', ...(exchangeId ? { exchangeId } : {}) }),
  });
}
const transcript = () => new Response(JSON.stringify({ text: 'Plan dinners' }), { status: 200, headers: { 'content-type': 'application/json' } });
const audio = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });

beforeEach(() => { state.rows = []; state.inserts = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); fetchWithDeadline.mockReset(); });

describe('one spoken exchange, one request', () => {
  it('an exchange admitted at 9 of 10 finishes speaking after its own turn reaches 10', async () => {
    const { POST: T } = await import('@/app/api/ai/voice/transcribe/route');
    const { POST: S } = await import('@/app/api/ai/voice/speak/route');
    seed(9);
    fetchWithDeadline.mockResolvedValueOnce(transcript());
    expect((await T(transcribe())).status).toBe(200);
    turnRow(); // the assistant turn files the exchange's one row: now 10
    fetchWithDeadline.mockResolvedValueOnce(audio());
    expect((await S(speak(TURN))).status).toBe(200);
    expect(state.rows).toHaveLength(10);
    expect(state.inserts).toBe(0);
  });

  it('a genuinely new exchange at 10 is refused at transcription, before the provider', async () => {
    const { POST: T } = await import('@/app/api/ai/voice/transcribe/route');
    seed(10);
    expect((await T(transcribe())).status).toBe(429);
    expect(fetchWithDeadline).not.toHaveBeenCalled();
  });

  it('standalone speech at 10 (no turn named) is refused', async () => {
    const { POST: S } = await import('@/app/api/ai/voice/speak/route');
    seed(10);
    expect((await S(speak())).status).toBe(429);
    expect(fetchWithDeadline).not.toHaveBeenCalled();
  });

  it('retrying the spoken answer does not count again', async () => {
    const { POST: S } = await import('@/app/api/ai/voice/speak/route');
    seed(9);
    turnRow();
    fetchWithDeadline.mockResolvedValue(audio());
    for (let i = 0; i < 3; i++) expect((await S(speak(TURN))).status).toBe(200);
    expect(state.rows).toHaveLength(10);
    expect(state.inserts).toBe(0);
  });

  it.each([
    ['another member’s turn', { requested_by: 'user-2' }],
    ['another family’s turn', { family_id: 'fam-2' }],
    ['a row that is not an assistant turn', { feature: 'recipes.suggest' }],
    ['a turn older than the exchange window', { created_at: new Date(Date.now() - 60 * 60_000).toISOString() }],
  ])('%s does not unlock speech past the allowance', async (_label, over) => {
    const { POST: S } = await import('@/app/api/ai/voice/speak/route');
    seed(9);
    turnRow(over);
    if ('family_id' in over) seed(1); // keep this family at 10 when the turn is another family's
    expect((await S(speak(TURN))).status).toBe(429);
    expect(fetchWithDeadline).not.toHaveBeenCalled();
  });

  it('a malformed id is treated as standalone speech', async () => {
    const { POST: S } = await import('@/app/api/ai/voice/speak/route');
    seed(10);
    expect((await S(speak('not-a-uuid'))).status).toBe(429);
  });
});

describe('transcription still validates the provider’s reply', () => {
  it.each([
    ['invalid JSON', 'not json'],
    ['a non-string text field', JSON.stringify({ text: 7 })],
  ])('%s answers 502, not 500', async (_label, body) => {
    const { POST: T } = await import('@/app/api/ai/voice/transcribe/route');
    fetchWithDeadline.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await T(transcribe())).status).toBe(502);
  });
});
