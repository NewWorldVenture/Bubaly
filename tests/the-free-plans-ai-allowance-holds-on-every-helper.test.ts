// N17 / N18 — the Free plan's ten AI requests a month were enforced only by the
// routes that called `assertAIAccess` (the assistant, Fridge Chef, Ask Bubaly).
//
// N18: the Habits coach, the Journal prompt and Notes AI made their paid model
// calls behind nothing but a per-minute limit, so a Free family past its ten
// kept getting them — while their rows still counted toward the limit the
// assistant refused them on.
//
// N17: voice transcription had no allowance check, no usage record and no
// duration cap: 25 MB of audio a request, ten a minute, from any member of any
// family, Free included, none of it in the family's usage. Speech was the same.
//
// Each now asks `assertAIAccess` before the provider is called, and the voice
// routes record their call where the allowance counts it and take a spoken
// request's worth of audio. Driven through the real routes, the real access
// gate and the real request recorder, over the in-memory database.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000f1801';
const USER = '00000000-0000-4000-8000-0000000f1811';
const MEMBER = '00000000-0000-4000-8000-0000000f1821';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), upstream: vi.fn() }));
const ctx = {
  user: { id: USER, email: 'parent@example.test' },
  memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER, display_name: 'Dana' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
};
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => ctx,
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
}));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The voice routes' authenticator (cookie or bearer) has its own tests; the
// access gate beside it in the same module is the real one.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  authenticateAI: async () => ({ supabase: h.db, ctx, via: 'cookie' }),
}));
vi.mock('@/lib/ai/settings', () => ({ getOpenAIKey: async () => 'sk-test' }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: (...args: unknown[]) => h.upstream(...args) }));

const habits = (await import('@/app/api/ai/habits/route')).POST;
const journal = (await import('@/app/api/ai/journal/route')).POST;
const notes = (await import('@/app/api/ai/notes/route')).POST;
const transcribe = (await import('@/app/api/ai/voice/transcribe/route')).POST;
const speak = (await import('@/app/api/ai/voice/speak/route')).POST;

const NOW = new Date('2026-10-14T15:00:00Z');
let db: InMemorySupabase;

/** count_family_ai_requests_month, over the backing table. */
function monthlyCount(args: Record<string, unknown>, mem: InMemorySupabase): number {
  return mem.table('ai_requests').filter((r) => r.family_id === args.p_family_id && String(r.created_at) >= String(args.p_month_start)).length;
}

function audio(bytes: number) {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }), 'speech.webm');
  return new NextRequest('http://localhost/api/ai/voice/transcribe', { method: 'POST', body: form });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ rpc: { count_family_ai_requests_month: monthlyCount } });
  h.db = db;
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: '{"summary":"x","actionItems":[],"tags":[],"encouragement":"x","nudges":[]}' });
  h.upstream.mockReset();
  h.upstream.mockResolvedValue(new Response(JSON.stringify({ text: 'Plan dinners for the week' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Free: no paid plan, no trial running.
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [{ id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true, display_name: 'Dana' }]);
  // Something for the coach to coach.
  db.seed('habits', [{ id: 'habit-1', family_id: FAMILY, title: 'Read for 20 minutes', cadence: 'daily', target_per_period: 1, weekdays: null, is_active: true }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The family has used this month's ten. */
function allowanceSpent() {
  db.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000f19${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: USER, kind: 'feature',
    request_text: 'earlier', status: 'completed', created_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
  })));
}

const helpers = [
  ['the Habits coach', () => habits()],
  ['the Journal prompt', () => journal()],
  ['Notes AI', () => notes(new NextRequest('http://localhost/api/ai/notes', { method: 'POST', body: JSON.stringify({ content: 'Call the plumber about the leak.' }) }))],
] as const;

describe('N18: a Free family past its ten requests', () => {
  it.each(helpers)('is refused by %s before any model call', async (_label, call) => {
    allowanceSpent();

    const res = await call();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'allowance_exceeded' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(helpers)('control: %s still answers inside the allowance', async (_label, call) => {
    const res = await call();

    expect(res.status).not.toBe(429);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe('N17: voice', () => {
  it('transcribes nothing for a Free family past its ten, and calls no provider', async () => {
    allowanceSpent();

    const res = await transcribe(audio(4_096));

    expect(res.status).toBe(429);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('speaks nothing for a Free family past its ten, and calls no provider', async () => {
    allowanceSpent();

    const res = await speak(new NextRequest('http://localhost/api/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: 'Dinner is planned.' }) }));

    expect(res.status).toBe(429);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('refuses more audio than a spoken request, before it reaches the provider', async () => {
    const res = await transcribe(audio(3 * 1024 * 1024));

    expect(res.status).toBe(413);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('records a transcription where the allowance counts it', async () => {
    const res = await transcribe(audio(4_096));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Plan dinners for the week' });
    expect(db.table('ai_requests').filter((r) => r.feature === 'voice.transcribe')).toHaveLength(1);
  });
});
