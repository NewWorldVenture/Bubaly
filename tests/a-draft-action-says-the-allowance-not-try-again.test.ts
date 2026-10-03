import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F19 / I18N. Two drafting actions a member calls directly (paperwork draft
// reply, contact reconnect message) check the monthly allowance with
// `assertAIAllowance` and then call the model through `withAiRequest`.
//
//   • At the gate they returned the denial's English `error`, whatever the
//     reader's language.
//   • In the race — the gate read 9 of 10, then another request took the 10th
//     and the admission (0477) refused this one — they answered with
//     `describeAIError`, which did not know the refusal: "Something went wrong
//     while answering. Please try again." A family at its limit was told to
//     retry a request that cannot succeed this month.
//
// Drives the REAL actions, the real gate and the real catalogues in German.
// The admission refusal is the real `AiRequestOverAllowance`, thrown where
// `withAiRequest` throws it.

const state = vi.hoisted(() => ({
  locale: 'de-DE',
  used: 10,
  race: false,
  modelCalls: 0,
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};
const rows: Record<string, unknown> = {
  paperwork_items: { id: 'item-1', family_id: 'fam-1', raw_text: 'School trip permission slip, due Friday.', summary: null, title: 'Trip', meta: {} },
  family_contacts: { id: 'contact-1', family_id: 'fam-1', name: 'Alex', relationship: 'Friend', birthday_month: null, birthday_day: null },
};
function client() {
  return {
    from: (table: string) => {
      let head = false;
      const chain: Record<string, unknown> = {
        select: (_c?: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return chain; },
        eq: () => chain, gte: () => chain, order: () => chain, in: () => chain, update: () => chain,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok(head ? { data: null, error: null, count: state.used } : { data: [], error: null }),
      };
      return chain;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(state.locale as never), key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(state.locale), messages: getMessages(state.locale as never), source: 'cookie' }),
  };
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx, getUserContext: async () => ctx }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => client(), createServiceClient: () => client() }));
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 0,
}));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ model: 'test', complete: async () => { state.modelCalls += 1; return { text: 'A draft.', toolCalls: [] }; } }),
}));
vi.mock('@/lib/ai/observability', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/observability')>();
  return {
    ...real,
    // The race: the gate passed, and the admission then refused before the body ran.
    withAiRequest: async (_scope: unknown, spec: { feature: string }, body: (obs: unknown) => unknown) => {
      if (state.race) throw new real.AiRequestOverAllowance(spec.feature, 10);
      return body({ used: () => {}, failed: () => {} });
    },
  };
});

vi.setConfig({ testTimeout: 20_000 });

const GERMAN = 'Ihre Familie hat ihre 10 KI-Anfragen für diesen Monat aufgebraucht. Wechseln Sie zu Family Basic für unbegrenzte Anfragen oder versuchen Sie es nächsten Monat erneut.';
const ENGLISH = 'Your family has used its 10 AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.';

beforeEach(() => {
  state.locale = 'de-DE';
  state.used = 10;
  state.race = false;
  state.modelCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const draftReply = async () => (await import('@/app/(app)/dashboard/paperwork/actions')).draftPaperworkReplyAction('item-1');
const draftReconnect = async () => (await import('@/app/(app)/dashboard/contacts/[id]/actions')).draftReconnectMessageAction('contact-1', 'warm');

describe.each([
  ['paperwork draft reply', draftReply],
  ['contact reconnect message', draftReconnect],
])('%s', (_name, run) => {
  it('at the gate (10 of 10): the allowance, in German, and no model call', async () => {
    expect(await run()).toEqual({ ok: false, error: GERMAN });
    expect(state.modelCalls).toBe(0);
  });

  it('in the race (gate at 9, admission refused at 10): the allowance in German, not "try again"', async () => {
    state.used = 9;
    state.race = true;
    expect(await run()).toEqual({ ok: false, error: GERMAN });
    expect(state.modelCalls).toBe(0);
  });

  it('control: under the cap, the draft is made', async () => {
    state.used = 3;
    expect(await run()).toMatchObject({ ok: true });
    expect(state.modelCalls).toBe(1);
  });

  it('control: an English reader reads the English refusal', async () => {
    state.locale = 'en-US';
    expect(await run()).toEqual({ ok: false, error: ENGLISH });
  });
});

describe('describeAIError knows the admission refusal', () => {
  it('reads it as allowance_exceeded with its own text, not "Something went wrong… try again"', async () => {
    const { describeAIError } = await import('@/lib/ai/provider');
    const { AiRequestOverAllowance } = await import('@/lib/ai/observability');
    expect(describeAIError(new AiRequestOverAllowance('meals.plan', 10))).toMatchObject({ code: 'allowance_exceeded', message: ENGLISH });
  });

  it('control: an ordinary failure still reads as before', async () => {
    const { describeAIError } = await import('@/lib/ai/provider');
    expect(describeAIError(new Error('boom'))).toMatchObject({ code: 'unknown' });
  });
});
