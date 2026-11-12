// POST /api/behavior/insight, driven end to end over an in-memory database
// seeded with two households: the real role check, the real plan resolver, the
// real durable rate limiter (rate_limit_hit over the fake's table) and the real
// behavior_logs read. The model, the observability wrapper and the monthly
// allowance are stubbed at the seams tests/behaviour-coaching-is-for-the-note-readers
// stubs them.
//
// Already proved elsewhere, and not repeated here:
//   tests/behaviour-coaching-is-for-the-note-readers.test.ts — guest/teen/child are 403
//     and no note is read; parent/adult/caregiver are coached.
//   tests/behavior-insight-observed.test.ts — the three model outcomes and what is recorded.
//   tests/member-scoped-reads-name-their-family.test.ts — the family filter, by source.
//   tests/an-ai-answer-is-not-built-on-a-read-that-failed.test.ts — the 503 branch, by source.
//   tests/route-plan-gate.test.ts — the plan gate's own outcomes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

type Ctx = { user: { id: string }; active: { familyId: string; role: string; member: { id: string }; family: { name: string; timezone: string } } };
const h = vi.hoisted(() => ({ db: null as unknown, ctx: null as Ctx | null, complete: vi.fn() }));

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', async () => {
  const { redirect } = await import('next/navigation');
  return {
    isSuperAdmin: async () => false,
    requireUserContext: async () => {
      if (!h.ctx) redirect('/login');
      return h.ctx;
    },
  };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  refuseOverAIAllowance: async () => null,
}));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: async () => ({ model: 'test-fake-model', complete: h.complete }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }),
}));

const { POST } = await import('@/app/api/behavior/insight/route');

const ID = 'API-DE112DF76F8A';
const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const PARENT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const CHILD_A = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const CHILD_B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const NOTE_A = 'Mia shared her crayons with the new kid';
const NOTE_B = 'Noah threw the remote at the television';

let db: InMemorySupabase;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function signIn(role: string, family = FAMILY_A) {
  h.ctx = {
    user: { id: `${family.slice(0, 8)}-0000-4000-8000-00000000${role.length.toString().padStart(4, '0')}` },
    active: { familyId: family, role, member: { id: PARENT_A }, family: { name: 'Household', timezone: 'UTC' } },
  };
}

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  h.db = db;
  signIn('parent');
  h.complete.mockReset().mockResolvedValue({ text: '{"insight":"Coached.","tips":["one","two","three"]}', usage: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  // A pays for Plus; B is on Free, below Behavior Tracking's Basic.
  db.seed('subscriptions', [{ family_id: FAMILY_A, plan: 'plus', status: 'active' }]);
  db.seed('behavior_logs', [
    { family_id: FAMILY_A, member_id: CHILD_A, kind: 'positive', category: 'kindness', note: NOTE_A, points: 1, occurred_at: daysAgo(1), logged_by: PARENT_A },
    { family_id: FAMILY_B, member_id: CHILD_B, kind: 'concern', category: 'tantrums', note: NOTE_B, points: -1, occurred_at: daysAgo(1), logged_by: 'bbbbbbbb-0000-4000-8000-0000000000b1' },
    // The same child id in B as well, so only the family filter separates them.
    { family_id: FAMILY_B, member_id: CHILD_A, kind: 'concern', category: 'tantrums', note: NOTE_B, points: -1, occurred_at: daysAgo(2), logged_by: 'bbbbbbbb-0000-4000-8000-0000000000b1' },
  ]);
});

const ask = (body: Record<string, unknown> = {}) => POST(new Request('https://fixture.invalid/api/behavior/insight', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as never);
const prompt = () => (h.complete.mock.calls[0][0] as { messages: { content: string }[] }).messages[0].content;

describe('who may ask for coaching', () => {
  it(`${ID} signed-out is sent to /login before any table is read or written`, async () => {
    h.ctx = null;
    await expect(ask({ memberId: CHILD_A })).rejects.toThrow('NEXT_REDIRECT /login');
    expect(db.log).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['guest', 'teen', 'child'])(`${ID} a %s is refused before the plan is read or a rate-limit row is written`, async (role) => {
    signIn(role);
    const res = await ask({ memberId: CHILD_A });
    expect(res.status).toBe(403);
    expect(db.log).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
  });
});

describe('a parent\'s request, end to end', () => {
  it(`${ID} coaches from household A's own notes for that child, and counts one durable hit on the caller`, async () => {
    const res = await ask({ memberId: CHILD_A });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ insight: 'Coached.', tips: ['one', 'two', 'three'] });
    expect(prompt()).toContain(NOTE_A);
    expect(prompt()).toContain('1 positive, 0 concern');
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`ai-behavior-insight:${h.ctx?.user.id}`]);
    expect(db.table('behavior_logs')).toHaveLength(3);
  });

  it(`${ID} answers 429 with Retry-After once the caller's durable bucket is full, reading no note and calling no model`, async () => {
    const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
    db.seed('rate_limits', [{ bucket_key: `ai-behavior-insight:${h.ctx?.user.id}`, window_start: windowStart, count: 15 }]);
    const res = await ask({ memberId: CHILD_A });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(db.log.some((e) => e.table === 'behavior_logs')).toBe(false);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('another household\'s ids', () => {
  it(`${ID} household B's child id finds nothing in A: no model call, no note, no count of B's returned`, async () => {
    const res = await ask({ memberId: CHILD_B });
    expect(res.status).toBe(200);
    const body = await res.json() as { insight: string; tips: unknown[] };
    expect(body.tips).toEqual([]);
    expect(body.insight).toMatch(/^No behavior has been logged yet/);
    expect(JSON.stringify(body)).not.toMatch(/tantrums|remote|television/);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it(`${ID} an id logged in both households is coached from household A's notes only, never blended with B's`, async () => {
    await ask({ memberId: CHILD_A });
    expect(prompt()).toContain(NOTE_A);
    expect(prompt()).not.toContain(NOTE_B);
    expect(prompt()).not.toContain('tantrums');
  });

  it(`${ID} with the model down, the fallback names only household A's numbers and categories`, async () => {
    h.complete.mockRejectedValue(new Error('provider unreachable'));
    const res = await ask({});
    expect(res.status).toBe(200);
    const body = await res.json() as { insight: string; tips: string[] };
    expect(body.insight).toContain('1 positive vs 0 concern');
    expect(body.insight).toContain('kindness');
    expect(body.insight).not.toContain('tantrums');
  });
});

describe('household B\'s plan', () => {
  it(`${ID} a parent whose active household is on Free is refused 403 with the plan level, reading no note and calling no model`, async () => {
    signIn('parent', FAMILY_B);
    const res = await ask({ memberId: CHILD_B });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ needLevel: 1 });
    expect(db.log.some((e) => e.table === 'behavior_logs')).toBe(false);
    expect(db.table('rate_limits')).toEqual([]);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('a read that fails', () => {
  it(`${ID} a failed behavior_logs read is 503 with the translated key, calls no model, and never says "nothing logged"`, async () => {
    h.db = withFaults(db, (table) => (table === 'behavior_logs' ? { message: 'relation behavior_logs: connection reset by peer' } : null));
    const res = await ask({ memberId: CHILD_A });
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'insight.behaviorDataUnavailable' });
    expect(JSON.stringify(body)).not.toMatch(/connection reset|behavior_logs|No behavior has been logged/);
    expect(h.complete).not.toHaveBeenCalled();
  });
});
