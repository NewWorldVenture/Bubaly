// N17 / N18 — the Free plan's ten AI requests a month were enforced only by the
// routes that called `assertAIAccess` (the assistant, Fridge Chef, Ask Bubaly).
//
// N18: the Habits coach, the Journal prompt and Notes AI made their paid model
// calls behind nothing but a per-minute limit, so a Free family past its ten
// kept getting them — while their rows still counted toward the limit the
// assistant refused them on.
//
// N18, its siblings: the meal planner, the nutrition estimate and every free
// module's AI Assist (`/api/ai/insights`) were the same — a model call and a
// counted `ai_requests` row behind a per-minute limit and nothing else.
//
// N17: voice transcription had no allowance check, no usage record and no
// duration cap: 25 MB of audio a request, ten a minute, from any member of any
// family, Free included, none of it in the family's usage. Speech was the same.
//
// N18, its siblings 2: the recipe suggest and transform helpers, the contact
// reconnect draft, the paperwork reply draft and the marketplace assistant
// were the same again — each files an `ai_requests` row through
// `withAiRequest`, so a Free family past its ten got an eleventh call and an
// eleventh row.
//
// N18 / N17, the coupling: the helpers asked `assertAIAccess` on the
// ASSISTANT's catalog entry only to meter, and so answered to the assistant's
// tier and its Off switch as well: an admin who switched "AI Assistant" Off
// turned every one of them into a 404 behind pages that still offered it, and
// raising the assistant to Family+ refused a Basic family the meal planner.
// They now ask `assertAIAllowance` — the lock, the plan's allowance and the
// month's count, nothing else — and answer to their own pages' gates for
// whether they are available.
//
// N18, its siblings 3: the Relationship Helper and the AI review of a child's
// chore proof were the same again, and a Free family reaches both. The helper
// answered to its own twenty a day and nothing else; the chore review ran on
// every submission, a 'none'-proof chore's included, so each chore a child sent
// in used one of the family's ten while the review itself was never refused.
// The helper is now refused like the others. A child's submission is not
// refused: past the allowance the proof goes to a parent, as any review the
// model cannot give does, and no model is asked.
//
// Each asks before the provider is called, and the voice routes record their
// call where the allowance counts it and take a spoken request's worth of
// audio. Driven through the real routes and actions, the real access gate and
// the real request recorder, over the in-memory database.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000f1801';
const USER = '00000000-0000-4000-8000-0000000f1811';
const MEMBER = '00000000-0000-4000-8000-0000000f1821';

const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn(), upstream: vi.fn(), caller: null as unknown }));
const ctx = {
  user: { id: USER, email: 'parent@example.test' },
  memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: MEMBER, display_name: 'Dana' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
};
const KID_USER = '00000000-0000-4000-8000-0000000f1812';
const KID = '00000000-0000-4000-8000-0000000f1822';
/** The child the chore is assigned to, signed in on /kids/submit. */
const kid = {
  user: { id: KID_USER, email: null },
  memberships: [],
  active: { familyId: FAMILY, role: 'child', member: { id: KID, display_name: 'Sam' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
};
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The paperwork actions' step-up gate has its own tests; this session has cleared it.
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));
vi.mock('@/lib/supabase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/auth')>()),
  requireUserContext: async () => h.caller ?? ctx,
  isSuperAdmin: async () => false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete: h.complete }),
  // The chore reviewer's provider (lib/chores/ai.ts).
  getProvider: () => ({ model: 'gpt-test', complete: h.complete }),
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
const mealPlan = (await import('@/app/api/ai/meals/plan/route')).POST;
const nutrition = (await import('@/app/api/ai/meals/nutrition/route')).POST;
const insights = (await import('@/app/api/ai/insights/route')).POST;
const recipeSuggest = (await import('@/app/api/recipes/suggest/route')).POST;
const recipeTransform = (await import('@/app/api/recipes/transform/route')).POST;
const { draftReconnectMessageAction } = await import('@/app/(app)/dashboard/contacts/[id]/actions');
const { draftPaperworkReplyAction } = await import('@/app/(app)/dashboard/paperwork/actions');
const { askMarketAssistantAction } = await import('@/app/(app)/marketplace/assistant-actions');
const relationship = (await import('@/app/api/ai/relationship/route')).POST;
const { submitProofAction } = await import('@/app/(app)/missions/actions');

const RECIPE = '00000000-0000-4000-8000-0000000f1831';
const CONTACT = '00000000-0000-4000-8000-0000000f1841';
const PAPER = '00000000-0000-4000-8000-0000000f1851';
const CHORE = '00000000-0000-4000-8000-0000000f1861';
const ASSIGNMENT = '00000000-0000-4000-8000-0000000f1871';
const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });

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

/**
 * The same multipart upload, streamed the way a socket delivers it. A FormData
 * body is pumped by undici's own generator, which keeps enqueueing after the
 * route cancels an over-budget read; on Node 24 that surfaces as an unhandled
 * "ReadableStream is already closed" rejection after the test. This stream
 * stops when it is cancelled, so the route's streamed size check is what the
 * oversized case exercises.
 */
async function streamedAudio(bytes: number) {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }), 'speech.webm');
  const encoded = new Response(form);
  const contentType = encoded.headers.get('content-type') ?? 'multipart/form-data';
  const payload = new Uint8Array(await encoded.arrayBuffer());
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) { controller.close(); return; }
      controller.enqueue(payload.subarray(offset, offset + 64 * 1024));
      offset += 64 * 1024;
    },
  });
  const init = { method: 'POST', headers: { 'content-type': contentType }, body, duplex: 'half' };
  return new NextRequest(new Request('http://localhost/api/ai/voice/transcribe', init as RequestInit));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ rpc: { count_family_ai_requests_month: monthlyCount } });
  h.db = db;
  h.caller = null;
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
  // And a recipe to estimate, suggest and vary.
  db.seed('family_recipes', [{
    id: RECIPE, family_id: FAMILY, name: 'Lentil soup', servings: 4, category: 'dinner', cuisine: 'French', tags: [], photo_url: null, is_favorite: true,
    allergy_flags: [], ingredients: [{ name: 'lentils', quantity: '1', unit: 'cup' }], instructions: [{ step: 1, text: 'Simmer the lentils.' }],
  }]);
  // Someone to reconnect with, and a letter to answer.
  db.seed('family_contacts', [{ id: CONTACT, family_id: FAMILY, name: 'Aunt Rosa', relationship: 'aunt', birthday_month: null, birthday_day: null }]);
  db.seed('paperwork_items', [{
    id: PAPER, family_id: FAMILY, title: 'Field trip slip', kind: 'permission_slip', status: 'needs_action', urgency: 'normal', summary: 'Sign by Friday.',
    raw_text: 'Please sign and return the field trip permission slip by Friday.', due_on: null, amount: null, sender: 'school@example.test', actions: [], meta: {},
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
  ['the meal planner', () => mealPlan(post('/api/ai/meals/plan', { weekStart: '2026-10-12' }))],
  ['the nutrition estimate', () => nutrition(post('/api/ai/meals/nutrition', { subjectType: 'recipe', subjectId: RECIPE }))],
  ['the Watchlist’s AI Assist', () => insights(post('/api/ai/insights', { kind: 'watchlist' }))],
  ['the Declutter AI Assist', () => insights(post('/api/ai/insights', { kind: 'declutter' }))],
] as const;

/** A route answers the allowance's own refusal. */
const refusedRoute = async (res: unknown) => {
  const response = res as Response;
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ code: 'allowance_exceeded' });
};
/** A route answers the allowance's refusal for a count it could not read. */
const refusedUnreadable = async (res: unknown) => {
  const response = res as Response;
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'unavailable' });
};
/** A server action answers its own failure shape, with the allowance's sentence. */
const refusedAction = async (result: unknown) => {
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('used its 10 AI requests') });
};

// N18, its siblings 2: the helpers outside /api/ai that file an `ai_requests` row.
const siblings = [
  ['the recipe suggester', () => recipeSuggest(post('/api/recipes/suggest', { constraint: 'something warm' })), refusedRoute],
  ['the recipe transformer', () => recipeTransform(post('/api/recipes/transform', { recipeId: RECIPE, actionId: 'healthier' })), refusedRoute],
  ['the contact reconnect draft', () => draftReconnectMessageAction(CONTACT, 'warm'), refusedAction],
  ['the paperwork reply draft', () => draftPaperworkReplyAction(PAPER), refusedAction],
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

  it.each(siblings)('is refused by %s before any model call', async (_label, call, refused) => {
    allowanceSpent();

    await refused(await call());

    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(10);
  });

  it.each(siblings)('control: %s still answers inside the allowance', async (_label, call) => {
    await call();

    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(db.table('ai_requests')).toHaveLength(1);
  });

  it('is answered by the marketplace assistant from the family’s own listings, with no model call', async () => {
    allowanceSpent();

    const answer = await askMarketAssistantAction('What do we have for sale?');

    expect(answer).toMatchObject({ ok: true, source: 'engine' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(10);
  });

  it('control: the marketplace assistant asks the model inside the allowance', async () => {
    expect(await askMarketAssistantAction('What do we have for sale?')).toMatchObject({ ok: true, source: 'llm' });
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the Habits coach', () => habits(), refusedUnreadable],
    ['the recipe suggester', () => recipeSuggest(post('/api/recipes/suggest', { constraint: 'something warm' })), refusedUnreadable],
    ['the paperwork reply draft', () => draftPaperworkReplyAction(PAPER), async (result: unknown) => { expect(result).toMatchObject({ ok: false, error: expect.stringContaining('could not check this month') }); }],
    ['the Relationship Helper', () => relationship(), refusedUnreadable],
  ] as const)('refuses %s when this month’s count cannot be read, before any model call', async (_label, call, refused) => {
    // A count that errors is not an empty month: the allowance fails closed.
    const unreadable = createInMemorySupabase({ rpc: { count_family_ai_requests_month: () => { throw new Error('canceling statement due to statement timeout'); } } });
    for (const table of ['families', 'family_members', 'habits', 'family_recipes', 'paperwork_items']) unreadable.seed(table, db.table(table));
    h.db = unreadable;

    await refused(await call());

    expect(h.complete).not.toHaveBeenCalled();
    expect(unreadable.table('ai_requests')).toHaveLength(0);
  });

  it('is still served a nutrition estimate already on file, which calls no model', async () => {
    allowanceSpent();
    db.seed('meal_nutrition', [{ id: 'nutrition-1', family_id: FAMILY, subject_type: 'recipe', subject_id: RECIPE, calories: 320, summary: 'Hearty.' }]);

    const res = await nutrition(post('/api/ai/meals/nutrition', { subjectType: 'recipe', subjectId: RECIPE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cached: true, nutrition: { calories: 320 } });
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('N18, its siblings 3: the Relationship Helper', () => {
  const DIGEST = JSON.stringify({ headline: 'Plan something small this week.', prompts: ['Ask how the new job is going.'], giftIdeas: [] });
  beforeEach(() => { h.complete.mockResolvedValue({ text: DIGEST }); });
  const digestsLogged = () => db.table('audit_logs').filter((r) => r.action === 'relationship_ai_digest');

  it('refuses a Free family past its ten before any model call, under its own daily cap', async () => {
    allowanceSpent();

    await refusedRoute(await relationship());

    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(10);
    expect(digestsLogged()).toHaveLength(0);
  });

  it('control: still writes the digest inside the allowance', async () => {
    const res = await relationship();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ digest: { headline: 'Plan something small this week.' } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(db.table('ai_requests')).toMatchObject([{ feature: 'relationship.digest' }]);
  });
});

describe('N18, its siblings 3: the AI review of a child’s chore proof', () => {
  /** A chore with no photo to send, assigned to the child, who submits it. */
  function seedChore(into: InMemorySupabase) {
    into.seed('family_members', [{ id: KID, family_id: FAMILY, user_id: KID_USER, role: 'child', is_active: true, display_name: 'Sam' }]);
    into.seed('chores', [{
      id: CHORE, family_id: FAMILY, title: 'Feed the cat', instructions: 'One scoop in the blue bowl.', proof_required: 'none',
      auto_approve_score: null, reward_mode: 'fixed_points', points: 10, difficulty: 'easy', safety_level: 'none', recurrence: 'none',
    }]);
    into.seed('chore_assignments', [{ id: ASSIGNMENT, family_id: FAMILY, chore_id: CHORE, member_id: KID, status: 'todo', approved_at: null, points_awarded: null }]);
  }
  function submitChore() {
    h.caller = kid;
    const form = new FormData();
    form.set('assignment_id', ASSIGNMENT);
    form.set('note', 'Fed the cat, one scoop.');
    return submitProofAction(form);
  }
  /** The child's chore was taken, and went to a parent with the review marked as not given. */
  const wentToAParent = (from: InMemorySupabase) => {
    expect(from.table('chore_submissions')).toMatchObject([{ assignment_id: ASSIGNMENT, member_id: KID, status: 'parent_review' }]);
    expect(from.table('chore_ai_validations')).toMatchObject([{ is_fallback: true, needs_parent_review: true, status: 'parent_review_required', model: null }]);
    expect(from.table('chore_assignments')).toMatchObject([{ id: ASSIGNMENT, status: 'submitted', approved_at: null }]);
  };

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    seedChore(db);
  });

  it('takes the child’s chore past the family’s ten, sends it to a parent, and asks no model', async () => {
    allowanceSpent();

    expect(await submitChore()).toEqual({ ok: true });

    expect(h.complete).not.toHaveBeenCalled();
    expect(db.table('ai_requests')).toHaveLength(10);
    wentToAParent(db);
  });

  it('takes the child’s chore when this month’s count cannot be read, sends it to a parent, and asks no model', async () => {
    const unreadable = createInMemorySupabase({ rpc: { count_family_ai_requests_month: () => { throw new Error('canceling statement due to statement timeout'); } } });
    unreadable.seed('families', db.table('families'));
    unreadable.seed('family_members', db.table('family_members').filter((r) => r.id === MEMBER));
    seedChore(unreadable);
    h.db = unreadable;

    expect(await submitChore()).toEqual({ ok: true });

    expect(h.complete).not.toHaveBeenCalled();
    expect(unreadable.table('ai_requests')).toHaveLength(0);
    wentToAParent(unreadable);
  });

  it('control: inside the allowance the reviewer reads the chore, and its call is counted', async () => {
    expect(await submitChore()).toEqual({ ok: true });

    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(db.table('ai_requests')).toMatchObject([{ feature: 'chores.validate', family_id: FAMILY, requested_by: KID_USER }]);
    expect(db.table('chore_ai_validations')).toMatchObject([{ is_fallback: false, model: 'gpt-test' }]);
  });
});

describe('N18 / N17 coupling: each helper answers to its own page, not to the assistant’s switch', () => {
  /** The admin's Tier & Features page, as `feature_tiers` stores it. */
  const assistantTier = (tier: 'off' | 'plus') => db.seed('app_settings', [{ key: 'feature_tiers', value: { 'ai-assistant': tier } }]);

  it.each(helpers)('%s still answers when an admin switches the AI Assistant off', async (_label, call) => {
    assistantTier('off');

    const res = await call();

    expect(res.status).not.toBe(404);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it.each(helpers)('%s still answers a Basic family when the AI Assistant is raised to Family+', async (_label, call) => {
    db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
    assistantTier('plus');

    const res = await call();

    expect(res.status).not.toBe(403);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('voice input still transcribes when an admin switches the AI Assistant off', async () => {
    assistantTier('off');

    const res = await transcribe(audio(4_096));

    expect(res.status).toBe(200);
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });

  it('control: the assistant itself still answers to its own switch', async () => {
    assistantTier('off');

    const res = await speak(new NextRequest('http://localhost/api/ai/voice/speak', { method: 'POST', body: JSON.stringify({ text: 'Dinner is planned.' }) }));

    expect(res.status).toBe(404);
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it('control: a page the admin switched off still closes its own helper', async () => {
    db.seed('app_settings', [{ key: 'feature_tiers', value: { habits: 'off' } }]);

    const res = await habits();

    expect(res.status).toBe(404);
    expect(h.complete).not.toHaveBeenCalled();
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
    const res = await transcribe(await streamedAudio(3 * 1024 * 1024));

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
