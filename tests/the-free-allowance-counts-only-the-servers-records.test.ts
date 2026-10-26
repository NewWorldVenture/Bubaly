// household-roles R7-R1-FREE-AI-ALLOWANCE-COUNTS-PLANTED-CONCIERGE-ROWS, round 8.
//
// The Free plan's ten AI requests a month are one family-wide meter
// (lib/server/ai-access.ts, behind assertAIAccess and assertAIAllowance). On a
// database without held migration 0493 it is counted directly: every
// `ai_requests` row of the family from the start of the UTC month, with no
// upper bound. 0255 lets any member, a child or a guest included, insert a
// request of one shape (kind 'concierge', status 'queued', their own
// requested_by) with any created_at, and nothing lets a member update one. So
// ten such rows dated 2100 refused the parents' assistant, voice, Journal,
// Notes, meal planner and every helper behind the allowance, in every month
// from then on, without a model ever being asked.
//
// The direct count now counts only the server's records of a request (every
// row but one still in the member-filed shape) and only inside the month. The
// intake moves a real concierge request to 'planning' on the ledger client as
// soon as it is filed, so the rows still counted are the ones the server wrote
// or settled.
//
// Driven through the real Journal prompt (assertAIAllowance) and the real
// voice reply (assertAIAccess on the assistant's entry), the real plan
// resolver and tiers, and the real request recorder, over the in-memory
// database with no count_family_ai_requests_month: the fallback 0493's absence
// selects.
import { readFileSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000a8801';
const PARENT_USER = '00000000-0000-4000-8000-0000000a8811';
const CHILD_USER = '00000000-0000-4000-8000-0000000a8812';
const PARENT = '00000000-0000-4000-8000-0000000a8821';
const CHILD = '00000000-0000-4000-8000-0000000a8822';
const NOW = new Date('2026-10-14T15:00:00Z');

const h = vi.hoisted(() => ({ db: null as unknown, caller: 'parent' as 'parent' | 'child', complete: vi.fn(), upstream: vi.fn() }));
function ctx() {
  const parent = h.caller === 'parent';
  return {
    user: { id: parent ? PARENT_USER : CHILD_USER, email: parent ? 'dana@example.test' : null },
    memberships: [],
    active: {
      familyId: FAMILY, role: h.caller,
      member: { id: parent ? PARENT : CHILD, display_name: parent ? 'Dana' : 'Kit' },
      family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
    },
  };
}
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => ctx(),
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'test-model', complete: h.complete }),
}));
// The per-minute limit has its own tests.
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The voice route's authenticator (cookie or bearer) has its own tests; the
// access gate beside it in the same module is the real one.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  authenticateAI: async () => ({ supabase: h.db, ctx: ctx(), via: 'cookie' }),
}));
vi.mock('@/lib/ai/settings', () => ({ getOpenAIKey: async () => 'sk-test' }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: (...args: unknown[]) => h.upstream(...args) }));

const journal = (await import('@/app/api/ai/journal/route')).POST;
const speak = (await import('@/app/api/ai/voice/speak/route')).POST;

type Helper = { name: string; call: () => Promise<Response>; provider: () => number };
const JOURNAL: Helper = { name: 'the Journal prompt (assertAIAllowance)', call: () => journal(), provider: () => h.complete.mock.calls.length };
const VOICE: Helper = {
  name: 'the spoken reply (assertAIAccess)',
  call: () => speak(new NextRequest('http://localhost/api/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: 'Dinner is planned.' }) })),
  provider: () => h.upstream.mock.calls.length,
};
const HELPERS = [JOURNAL, VOICE];

let db: InMemorySupabase;

/**
 * Requests a child filed on their own session, exactly as 0255's
 * ai_requests_insert admits them: their own requested_by and member, kind
 * 'concierge', status 'queued', every bookkeeping column left empty, and a
 * created_at of their choosing.
 */
function childFiled(count: number, createdAt: (i: number) => string) {
  db.seed('ai_requests', Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000a89${String(i).padStart(2, '0')}`, family_id: FAMILY,
    requested_by: CHILD_USER, requested_by_member_id: CHILD, kind: 'concierge', status: 'queued',
    request_text: 'Plan my week', context_stats: {}, model: null, prompt_tokens: null, completion_tokens: null,
    latency_ms: null, error: null, started_at: null, completed_at: null, created_at: createdAt(i),
  })));
}

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // No rpc handler: count_family_ai_requests_month answers 42883, as on a
  // database without 0493, and the allowance is counted directly.
  db = createInMemorySupabase();
  h.db = db;
  h.caller = 'parent';
  h.complete.mockReset();
  h.complete.mockResolvedValue({ text: 'What made you smile today?', model: 'test-model' });
  h.upstream.mockReset();
  h.upstream.mockImplementation(async () => new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
  // Free: no paid plan, no trial running.
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: PARENT_USER, display_name: 'Dana', role: 'parent', is_active: true },
    { id: CHILD, family_id: FAMILY, user_id: CHILD_USER, display_name: 'Kit', role: 'child', is_active: true },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Free plan’s monthly allowance counts only the server’s records of a request', () => {
  describe.each(HELPERS)('$name', (helper) => {
    it('ten queued requests a child filed, dated 2100, do not use up the parents’ month', async () => {
      childFiled(10, (i) => `2100-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`);

      const res = await helper.call();

      expect(res.status).toBe(200);
      expect(helper.provider()).toBe(1);
    });

    it('nor do ten dated earlier this month, which a child could file in a minute without the gate', async () => {
      childFiled(10, (i) => hoursAgo(i + 1));

      const res = await helper.call();

      expect(res.status).toBe(200);
      expect(helper.provider()).toBe(1);
    });

    it('control: ten requests the server settled this month, concierge ones among them, use it up, and the eleventh calls no provider', async () => {
      db.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000a8a${String(i).padStart(2, '0')}`, family_id: FAMILY,
        requested_by: i % 2 ? CHILD_USER : PARENT_USER, requested_by_member_id: i % 2 ? CHILD : PARENT,
        // A concierge request the intake moved on is the server's record, whatever it came to.
        kind: i < 4 ? 'concierge' : 'feature', status: ['planning', 'completed', 'failed', 'awaiting_context', 'completed'][i % 5],
        // A failed one counts only for the model work it recorded (round 9): these did some.
        prompt_tokens: i % 5 === 2 ? 812 : null,
        request_text: 'earlier', created_at: hoursAgo(i + 1),
      })));

      const res = await helper.call();

      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'allowance_exceeded' });
      expect(helper.provider()).toBe(0);
    });

    // household-roles round 9 (R8-RV2-FREE-ALLOWANCE-COUNTS-FAILED-CALLS): a
    // failed call does not use up the month. withAiRequest settles a provider
    // error or a thrown call as 'failed', with no usage recorded, so ten of them
    // in an outage cost a Free family its month.
    it('ten calls that failed this month with no model usage leave the eleventh open', async () => {
      db.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({
        id: `00000000-0000-4000-8000-0000000a8c${String(i).padStart(2, '0')}`, family_id: FAMILY,
        requested_by: PARENT_USER, requested_by_member_id: PARENT, kind: 'feature', feature: 'journal.prompt',
        status: 'failed', error: 'provider unavailable', prompt_tokens: null, completion_tokens: null,
        request_text: 'earlier', created_at: hoursAgo(i + 1), completed_at: hoursAgo(i + 1),
      })));

      const res = await helper.call();

      expect(res.status).toBe(200);
      expect(helper.provider()).toBe(1);
    });
  });

  it('a call that fails for real is recorded failed and does not count; one that succeeds does', async () => {
    // Nine settled uses: one more closes the month.
    db.seed('ai_requests', Array.from({ length: 9 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000a8d${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: PARENT_USER,
      kind: 'feature', status: 'completed', request_text: 'earlier', created_at: hoursAgo(i + 1),
    })));
    h.complete.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));

    // The Journal falls back to the evergreen prompt; the request is recorded failed, with no usage.
    const failed = await JOURNAL.call();
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ source: 'evergreen' });
    expect(db.table('ai_requests').filter((r) => r.status === 'failed').map((r) => r.prompt_tokens ?? null)).toEqual([null]);
    // So the tenth use is still there to make, and it closes the month.
    expect(await (await JOURNAL.call()).json()).toMatchObject({ source: 'ai' });
    expect((await JOURNAL.call()).status).toBe(429);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('control: ten real uses this month, by a parent and a child through both helpers, refuse the eleventh before any provider is asked', async () => {
    for (let i = 0; i < 10; i++) {
      h.caller = i % 2 ? 'child' : 'parent';
      const res = await (i < 5 ? JOURNAL : VOICE).call();
      expect(res.status).toBe(200);
    }
    expect(db.table('ai_requests')).toHaveLength(10);
    expect(db.table('ai_requests').every((r) => r.kind === 'feature')).toBe(true);
    expect(h.complete).toHaveBeenCalledTimes(5);
    expect(h.upstream).toHaveBeenCalledTimes(5);

    h.caller = 'parent';
    for (const helper of HELPERS) {
      const res = await helper.call();
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'allowance_exceeded' });
    }
    expect(h.complete).toHaveBeenCalledTimes(5);
    expect(h.upstream).toHaveBeenCalledTimes(5);
  });

  it('planted rows dated ahead and last month’s records leave this month open, and this month’s real uses still close it', async () => {
    childFiled(10, (i) => `2100-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`);
    db.seed('ai_requests', Array.from({ length: 10 }, (_, i) => ({
      id: `00000000-0000-4000-8000-0000000a8b${String(i).padStart(2, '0')}`, family_id: FAMILY, requested_by: PARENT_USER,
      kind: 'feature', status: 'completed', request_text: 'last month', created_at: `2026-09-${String(20 + i)}T12:00:00Z`,
    })));
    for (let i = 0; i < 10; i++) expect((await JOURNAL.call()).status).toBe(200);

    expect((await JOURNAL.call()).status).toBe(429);
    expect(h.complete).toHaveBeenCalledTimes(10);
  });
});

describe('the premise: a member’s session can leave only that one shape in ai_requests', () => {
  const migrations = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
  const naming = migrations.filter((f) => /\bai_requests\b/.test(readFileSync(`supabase/migrations/${f}`, 'utf8')));

  it('0255 is the last word on a member’s insert: kind concierge, status queued, and created_at left to the member', () => {
    const lastInsertPolicy = [...naming].reverse().find((f) => /create policy ai_requests_insert/.test(readFileSync(`supabase/migrations/${f}`, 'utf8')));
    expect(lastInsertPolicy).toBe('0255_ai_runtime_lockdown.sql');
    const sql = readFileSync('supabase/migrations/0255_ai_runtime_lockdown.sql', 'utf8');
    const policy = sql.slice(sql.indexOf('create policy ai_requests_insert'), sql.indexOf(');', sql.indexOf('create policy ai_requests_insert')));
    expect(policy).toMatch(/kind = 'concierge'/);
    expect(policy).toMatch(/status = 'queued'/);
    expect(policy).not.toMatch(/created_at/);
  });

  it('no migration gives a member an UPDATE on a request', () => {
    for (const f of naming) {
      const sql = readFileSync(`supabase/migrations/${f}`, 'utf8');
      expect(sql, f).not.toMatch(/create policy[^;]*\bon\s+public\.ai_requests\b[^;]*\bfor\s+(update|all)\b/i);
    }
  });
});
