import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { loadActivationEvents, loadOnboardingEvents, loadOnboardingProgress } from '@/lib/analytics/onboarding-server';
import { summarizeActivation } from '@/lib/analytics/activation';
import { analyzeOnboarding } from '@/lib/onboarding/ttv-audit';

const state = vi.hoisted(() => ({ db: null as unknown, admin: true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => state.db) }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({}), isSuperAdmin: async () => state.admin }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, vars?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, vars) };
});
const { default: AuditPage } = await import('@/app/(app)/admin/onboarding/page');
const { default: FunnelPage } = await import('@/app/(app)/dashboard/onboarding-funnel/page');
const { createServiceClient } = await import('@/lib/supabase/server');
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const created_at = '2026-09-01T00:00:00.000Z';
const cutoff = new Date('2026-09-09T00:00:00.000Z');
const progress = (n: number) => ({ id: id(n), created_at, completed_at: '2026-09-01T00:30:00.000Z', status: 'completed', value_engaged: true, steps_completed: [] });
const activation = (n: number) => ({ id: id(n), created_at, session_id: `cohort-${n}`, milestone: 'first_outcome_viewed', session_index: 1, ms_since_signup: 1_800_000 });
beforeEach(() => {
  vi.clearAllMocks(); state.admin = true;
  db = createInMemorySupabase<SupabaseClient<Database>>(); state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function html(element: ReactElement): Promise<string> {
  // Resolve a root async error component just as the server renderer does.
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    return renderToStaticMarkup(await (element.type as (props: unknown) => Promise<ReactElement>)(element.props));
  }
  return renderToStaticMarkup(element);
}

describe('complete onboarding telemetry', () => {
  it.each([
    ['onboarding_progress', loadOnboardingProgress, progress],
    ['activation_events', loadActivationEvents, activation],
    ['onboarding_events', loadOnboardingEvents, (n: number) => ({ id: id(n), created_at, session_id: `cohort-${n}`, step: 'done', phase: 'completed', duration_ms: 100 })],
  ] as const)('reads all %s rows even when the server caps every page below the request', async (table, load, row) => {
    db.seed(table, Array.from({ length: 11 }, (_, n) => row(n + 1)));
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((name) => {
      const query = from(name);
      const limit = query.limit.bind(query);
      vi.spyOn(query, 'limit').mockImplementation((n) => limit(Math.min(n, 3)));
      return query;
    });
    const result = await load(db, cutoff);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(11);
    expect(new Set(result.data?.map((r) => r.id)).size).toBe(11);
  });

  it('keeps ordinary concurrent inserts outside the cutoff without shifting pages', async () => {
    db.seed('onboarding_progress', Array.from({ length: 401 }, (_, n) => progress(n + 1)));
    const from = db.from.bind(db); let pages = 0;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'onboarding_progress' && ++pages === 2) db.table(table).push({ ...progress(0), created_at: '2026-09-09T00:00:00.001Z' });
      return from(table);
    });
    const result = await loadOnboardingProgress(db, cutoff);
    expect(result.data).toHaveLength(401);
    expect(result.data?.some((r) => r.id === id(0))).toBe(false);
    expect(analyzeOnboarding(result.data!)).toMatchObject({ timedCompletions: 401, under30MinCount: 401 });
  });

  it('uses an older cohort first-view event beyond the old page boundary', async () => {
    db.seed('activation_events', Array.from({ length: 401 }, (_, n) => ({ ...activation(n + 1), session_id: 'one-cohort', ms_since_signup: n === 400 ? 60_000 : 3_600_000 })));
    const result = await loadActivationEvents(db, cutoff);
    expect(summarizeActivation(result.data!)).toMatchObject({ cohorts: 1, under30MinRate: 1, timedValueCohorts: 1 });
  });

  it('discards earlier pages when a later read fails', async () => {
    db.seed('activation_events', Array.from({ length: 401 }, (_, n) => activation(n + 1)));
    const from = db.from.bind(db); let pages = 0;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (++pages === 2) throw new Error('offline on later page');
      return from(table);
    });
    expect(await loadActivationEvents(db, cutoff)).toMatchObject({ data: null, error: expect.any(Error) });
    expect(console.error).toHaveBeenCalledWith('[onboarding-telemetry] activation_events read failed', expect.any(Error));
  });

  it.each(['query_error', 'null_data'] as const)('refuses an unavailable result (%s)', async (failure) => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve({
        data: null, count: null, error: failure === 'query_error' ? { message: 'unavailable', code: 'XX000', details: '', hint: '' } : null,
        status: failure === 'query_error' ? 500 : 200, statusText: failure === 'query_error' ? 'Error' : 'OK',
      }).then(resolve, reject));
      return query;
    });
    const result = await loadOnboardingProgress(db, cutoff);
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
  });

  it('fails closed if a source repeats its page instead of advancing the cursor', async () => {
    db.seed('activation_events', [activation(1)]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      vi.spyOn(query, 'or').mockReturnValue(query);
      return query;
    });
    expect(await loadActivationEvents(db, cutoff)).toMatchObject({ data: null, error: expect.any(Error) });
  });
});

describe('rendered timing reports', () => {
  it('requires admin access before reading either telemetry source', async () => {
    state.admin = false;
    await expect(AuditPage()).rejects.toThrow('NOT_FOUND');
    await expect(FunnelPage()).rejects.toThrow('NOT_FOUND');
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('renders real threshold and missing-data counts with distinct setup/view labels', async () => {
    db.seed('onboarding_progress', [progress(1), { ...progress(2), completed_at: '2026-09-01T00:31:00.000Z' }, { ...progress(3), completed_at: null }]);
    db.seed('activation_events', [activation(1), { ...activation(2), ms_since_signup: 1_800_001 }, { ...activation(3), ms_since_signup: null }]);
    const audit = await html(await AuditPage());
    const funnel = await html(await FunnelPage());
    for (const rendered of [audit, funnel]) {
      expect(rendered).toContain('50%');
      expect(rendered).toContain('1 of 2 timed records met the 30-minute threshold.');
      expect(rendered).toContain('Excluded because timing is missing or invalid: 1.');
    }
    expect(audit).toContain('Setup completed within 30 minutes');
    expect(funnel).toContain('First outcome viewed within 30 minutes');
    expect(funnel).toContain('An outcome view is not proof of completed work.');
  });

  it('shows unavailable telemetry without false zero tiles or threshold rates', async () => {
    vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('offline'); });
    const audit = await html(await AuditPage()); const funnel = await html(await FunnelPage());
    expect(audit).toContain('Could not load onboarding audit data');
    expect(funnel).toContain('load onboarding telemetry');
    expect(funnel).toContain('load activation telemetry');
    expect(funnel).not.toContain('Sessions started');
    for (const rendered of [audit, funnel]) {
      expect(rendered).not.toContain('within 30 minutes'); expect(rendered).not.toContain('0%');
    }
  });
});
