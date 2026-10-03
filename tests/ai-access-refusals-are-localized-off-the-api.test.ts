import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// F19 / I18N: `assertAIAccess` writes every refusal in English. API routes
// translate the allowance one through `accessDeniedResponse(denial, t)`, but a
// server action or a page showed `denial.error` as is. A German family asking
// Bubaly from the concierge form, or opening a mission draft, read "Ask Bubaly
// is part of Family Basic…" or "Your family has used its 10 AI requests…" in
// English. `denialMessage(denial, t)` says every code in the reader's language.
//
// Drives the real gate, the real server actions, the real request translator
// (`getTranslations` via next/headers) and the real catalogues. Only identity,
// plan/tier settings, the usage count and rate limits are fixed.

const state = vi.hoisted(() => ({
  used: 10 as number,
  countFails: false,
  planLevel: 0 as number | 'throws',
  tiers: { 'ai-requests': 'free', 'family-missions': 'free' } as Record<string, string>,
  cookie: undefined as string | undefined,
  intakeRefuses: false,
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};

/** Answers the allowance's head count on `ai_requests` with `state.used`, or an error. */
function client() {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, gte: () => chain,
    then: (ok: (v: unknown) => unknown) => ok(state.countFails
      ? { data: null, error: { message: 'boom' }, count: null }
      : { data: null, error: null, count: state.used }),
  };
  return { from: () => chain, auth: { getUser: async () => ({ data: { user: ctx.user } }) } };
}
const db = client();
const submitRequest = vi.fn();
const generateChorePlan = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'bubaly-locale' && state.cookie ? { value: state.cookie } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => ctx, requireUserContext: async () => ctx }));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => true }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => state.tiers,
  getFeatureTiersByHref: async () => ({}),
}));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => {
    if (state.planLevel === 'throws') throw new Error('plan read failed');
    return state.planLevel;
  },
}));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
}));
vi.mock('@/lib/ai/runs/intake', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/runs/intake')>();
  return {
    ...real,
    isRetryPastAllowance: async () => false,
    submitRequest: async (...a: unknown[]) => {
      submitRequest(...a);
      // The intake's own refusal (F19): the gate counted 9, the admission 10.
      if (state.intakeRefuses) {
        return {
          ok: false, status: 429, code: 'allowance_exceeded', limit: 10, retryable: false,
          error: 'Your family has used its 10 AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.',
        };
      }
      return { ok: true, data: { requestId: 'r-1', runId: null, planId: null, outcome: 'answer', summary: 'ok', redirect: null } };
    },
  };
});
vi.mock('@/lib/chores/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chores/ai')>()),
  generateChorePlan: (...a: unknown[]) => generateChorePlan(...a),
}));

// The first import parses every catalogue; give it room on a cold cache.
vi.setConfig({ testTimeout: 20_000 });

const DE = {
  allowance: 'Ihre Familie hat ihre 10 KI-Anfragen für diesen Monat aufgebraucht. Wechseln Sie zu Family Basic für unbegrenzte Anfragen oder versuchen Sie es nächsten Monat erneut.',
  basic: 'Ask Bubaly ist Teil von Family Basic. Führen Sie ein Upgrade durch, damit Bubaly für Ihre Familie planen und handeln kann.',
  plusMissions: 'Family Missions ist Teil von Family+. Führen Sie ein Upgrade durch, damit Bubaly für Ihre Familie planen und handeln kann.',
  off: 'Ask Bubaly ist für Ihre Familie nicht verfügbar.',
  plan: 'Bubaly konnte Ihren Tarif gerade nicht bestätigen. Versuchen Sie es gleich noch einmal.',
  usage: 'Bubaly konnte die Nutzung in diesem Monat nicht prüfen. Versuchen Sie es gleich noch einmal.',
};
const EN_ALLOWANCE = 'Your family has used its 10 AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.';

beforeEach(() => {
  state.used = 10;
  state.countFails = false;
  state.planLevel = 0;
  state.tiers = { 'ai-requests': 'free', 'family-missions': 'free' };
  state.cookie = 'de-DE';
  state.intakeRefuses = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const ask = async () => {
  const { askBubalyAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
  return askBubalyAction({ text: 'Plan our week' });
};

describe('the concierge form action refuses in the reader\'s language', () => {
  it('at 10 of 10 (allowance_exceeded)', async () => {
    expect(await ask()).toEqual({ ok: false, error: DE.allowance, code: 'allowance_exceeded' });
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it('below the tier (plan_required, Family Basic)', async () => {
    state.tiers = { 'ai-requests': 'basic' };
    expect(await ask()).toEqual({ ok: false, error: DE.basic, code: 'plan_required' });
  });

  it('with the feature switched off: named, because the member is on its page', async () => {
    state.tiers = { 'ai-requests': 'off' };
    expect(await ask()).toEqual({ ok: false, error: DE.off, code: 'feature_off' });
  });

  it('when the plan cannot be read (unavailable: plan)', async () => {
    state.planLevel = 'throws';
    expect(await ask()).toEqual({ ok: false, error: DE.plan, code: 'unavailable' });
  });

  it('when this month\'s usage cannot be read (unavailable: usage)', async () => {
    state.countFails = true;
    expect(await ask()).toEqual({ ok: false, error: DE.usage, code: 'unavailable' });
  });

  it('when the gate passes at 9 but the intake\'s admission refuses at 10', async () => {
    state.used = 9;
    state.intakeRefuses = true;
    expect(await ask()).toEqual({ ok: false, error: DE.allowance, code: 'allowance_exceeded' });
    expect(submitRequest).toHaveBeenCalledTimes(1);
  });

  it('positive control: under the cap the action files once and succeeds', async () => {
    state.used = 3;
    expect(await ask()).toMatchObject({ ok: true });
    expect(submitRequest).toHaveBeenCalledTimes(1);
  });

  it('English control: an English reader keeps the English source text', async () => {
    state.cookie = 'en-US';
    expect(await ask()).toEqual({ ok: false, error: EN_ALLOWANCE, code: 'allowance_exceeded' });
  });
});

describe('the mission draft action refuses in the reader\'s language', () => {
  it('below Family+ (plan_required names Family Missions in German)', async () => {
    state.tiers = { 'family-missions': 'plus' };
    const { generatePlanAction } = await import('@/app/(app)/missions/actions');
    expect(await generatePlanAction('A clean-up week', [])).toEqual({ items: [], error: DE.plusMissions });
    expect(generateChorePlan).not.toHaveBeenCalled();
  });

  it('at 10 of 10', async () => {
    const { generatePlanAction } = await import('@/app/(app)/missions/actions');
    expect(await generatePlanAction('A clean-up week', [])).toEqual({ items: [], error: DE.allowance });
    expect(generateChorePlan).not.toHaveBeenCalled();
  });
});

describe('denialMessage and accessDeniedResponse', () => {
  it('an API 404 never names the switched-off feature, in any language', async () => {
    const { accessDeniedResponse } = await import('@/lib/server/ai-access');
    const { getTranslations } = await import('@/lib/i18n/server');
    const t = await getTranslations();
    const res = accessDeniedResponse({ ok: false, status: 404, code: 'feature_off', feature: 'Ask Bubaly', error: 'Not found.' }, t);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Nicht gefunden.', code: 'feature_off' });
  });

  it('a denial built without the new fields keeps its own text rather than a wrong translation', async () => {
    const { denialMessage } = await import('@/lib/server/ai-access');
    const t = (key: string) => `translated:${key}`;
    expect(denialMessage({ ok: false, status: 403, code: 'unavailable', error: 'raw' }, t)).toBe('raw');
    expect(denialMessage({ ok: false, status: 403, code: 'plan_required', error: 'raw' }, t)).toBe('raw');
    expect(denialMessage({ ok: false, status: 429, code: 'allowance_exceeded', error: 'raw' }, t)).toBe('raw');
  });

  it('every key it uses exists in all seven base catalogues and is translated outside English', () => {
    const keys = [
      'ai.yourFamilyUsedItsMonthlyAllowance', 'ai.featureIsPartOfFamilyPlus', 'ai.featureIsPartOfFamilyBasic',
      'ai.couldNotConfirmYourPlan', 'ai.couldNotCheckThisMonthsUsage', 'ai.notFound', 'ai.featureIsNotAvailableForYourFamily',
    ];
    const read = (loc: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'lib/i18n/messages', `${loc}.json`), 'utf8')) as Record<string, string>;
    const en = read('en-US');
    for (const loc of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const cat = read(loc);
      for (const key of keys) {
        expect(cat[key], `${loc} ${key}`).toBeTruthy();
        expect(cat[key], `${loc} ${key}`).not.toBe(en[key]);
        // Placeholders survive translation.
        expect(cat[key].match(/\{\w+\}/g) ?? [], `${loc} ${key}`).toEqual(en[key].match(/\{\w+\}/g) ?? []);
      }
    }
  });
});
