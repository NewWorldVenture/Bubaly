// The super-admin funnel and the "Conversion after value" metric read two
// tables anyone can write: `onboarding_events` (0133) and `activation_events`
// (0146) accept `user_id is null` from the public anon key, name no family
// check, and take any `created_at`. Driven through the real
// /dashboard/onboarding-funnel page and the real loadStrategyMetrics over the
// in-memory database:
//
//   N1  one row dated '-infinity' blanked the funnel and the TTFV panel for good;
//   N4/N16  anonymous rows were counted as sessions, completions and cohorts;
//   N2/N6  a row naming a household its writer is no member of activated that
//          household and moved its conversion date;
//   N9  "New families" was only the households that already had a milestone;
//   N18 "First capture", which nothing records, read as a measured 0%.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { formatDuration } from '@/lib/analytics/onboarding';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({}), isSuperAdmin: async () => true }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, vars?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, vars) };
});

const { default: FunnelPage } = await import('@/app/(app)/dashboard/onboarding-funnel/page');
const { loadStrategyMetrics } = await import('@/lib/metric/strategy-server');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;
const uuid = (prefix: number, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FAMILY = [1, 2, 3].map((n) => uuid(1, n));
const USER = [1, 2, 3].map((n) => `user-${n}`);
const CREATED = '2026-09-01T00:00:00.000Z';
let seq = 0;
const next = () => uuid(9, ++seq);
const onboarding = (row: Row): Row => ({ id: next(), created_at: CREATED, duration_ms: 1000, ...row });
const activation = (row: Row): Row => ({ id: next(), created_at: CREATED, session_index: 1, ms_since_signup: null, ...row });

/** Three households, each with its member, and what those members really recorded. */
function seedHouseholds(): void {
  db.seed('families', FAMILY.map((id) => ({ id, created_at: CREATED })));
  db.seed('family_members', FAMILY.map((family_id, i) => ({ id: uuid(2, i + 1), family_id, user_id: USER[i] })));
  // One real wizard run, by user 1.
  db.seed('onboarding_events', [
    onboarding({ user_id: USER[0], session_id: 'run-1', step: 'profile', phase: 'started' }),
    onboarding({ user_id: USER[0], session_id: 'run-1', step: 'done', phase: 'completed', duration_ms: 300_000 }),
  ]);
  // Household 1 reached first value in ten minutes; household 2 only saw a briefing.
  db.seed('activation_events', [
    activation({ user_id: USER[0], family_id: FAMILY[0], session_id: FAMILY[0], milestone: 'first_outcome_viewed', ms_since_signup: 600_000 }),
    activation({ user_id: USER[1], family_id: FAMILY[1], session_id: FAMILY[1], milestone: 'first_brief_viewed', ms_since_signup: 1000 }),
  ]);
}

async function funnelHtml(): Promise<string> {
  return renderToStaticMarkup(await FunnelPage() as ReactElement).replace(/&#x27;|&#39;/g, "'");
}
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The figure a StatTile shows above `label`. */
function tile(html: string, label: string): string | null {
  return html.match(new RegExp(`<p class="text-2xl[^"]*">([^<]*)</p><p class="[^"]*">${escapeRe(label)}</p>`))?.[1] ?? null;
}
/** The "N · R%" (or "Not recorded") beside a milestone. */
function milestone(html: string, label: string): string | null {
  return html.match(new RegExp(`<span class="font-medium">${escapeRe(label)}</span><span class="text-muted">([^<]*)</span>`))?.[1] ?? null;
}

beforeEach(() => {
  seq = 0;
  db = createInMemorySupabase<DB>();
  state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
  seedHouseholds();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('/dashboard/onboarding-funnel (N1)', () => {
  it('keeps rendering the funnel and the TTFV panel after a row dated -infinity in each table', async () => {
    db.seed('onboarding_events', [onboarding({ user_id: USER[0], session_id: 'x', step: 'profile', phase: 'started', created_at: '-infinity' })]);
    db.seed('activation_events', [activation({ user_id: USER[0], family_id: FAMILY[0], session_id: FAMILY[0], milestone: 'first_outcome_viewed', created_at: '-infinity' })]);
    const html = await funnelHtml();
    expect(html).not.toContain('load onboarding telemetry');
    expect(html).not.toContain('load activation telemetry');
    expect(tile(html, 'Sessions started')).toBe('1');
    expect(tile(html, 'New families')).toBe('3');
  });
});

describe('/dashboard/onboarding-funnel counts what members recorded (N4, N16, N2, N9, N18)', () => {
  it('does not count anonymous onboarding rows as sessions or completions', async () => {
    for (let i = 0; i < 4; i++) {
      db.seed('onboarding_events', [
        onboarding({ user_id: null, session_id: `planted-${i}`, step: 'profile', phase: 'started' }),
        onboarding({ user_id: null, session_id: `planted-${i}`, step: 'done', phase: 'completed', duration_ms: 1 }),
      ]);
    }
    const html = await funnelHtml();
    expect(tile(html, 'Sessions started')).toBe('1');
    expect(tile(html, 'Completed')).toBe('1');
    expect(tile(html, 'Median time')).toBe(formatDuration(300_000));
  });

  it('does not activate a household from an anonymous row or from a writer who is not its member', async () => {
    db.seed('activation_events', [
      ...[1, 2, 3, 4].map((i) => activation({ user_id: null, family_id: null, session_id: `planted-${i}`, milestone: 'first_outcome_viewed', ms_since_signup: 0 })),
      // A signed-in account of another household naming household 3.
      activation({ user_id: 'user-9', family_id: FAMILY[2], session_id: FAMILY[2], milestone: 'first_outcome_viewed', ms_since_signup: 0 }),
      // A member keying a made-up cohort.
      activation({ user_id: USER[1], family_id: FAMILY[1], session_id: 'made-up', milestone: 'first_outcome_viewed', ms_since_signup: 0 }),
    ]);
    const html = await funnelHtml();
    expect(tile(html, 'Activation rate')).toBe('33%');
    expect(tile(html, 'TTFV (median)')).toBe(formatDuration(600_000));
  });

  it('counts every household as a new family, not only those that reached a milestone', async () => {
    const html = await funnelHtml();
    // Household 3 recorded nothing; it is still one of three new families.
    expect(tile(html, 'New families')).toBe('3');
    expect(milestone(html, 'Signed up')).toBe('3 · 100%');
    expect(milestone(html, 'Viewed first outcome')).toBe('1 · 33%');
  });

  it('says a milestone nothing records is not recorded, rather than a measured 0%', async () => {
    const html = await funnelHtml();
    expect(milestone(html, 'First capture')).toBe('Not recorded');
  });
});

describe('/admin/reports "Conversion after value" (N6)', () => {
  const NOW = new Date('2026-03-15T12:00:00.000Z');
  const REACHED = '2026-01-05T00:00:00.000Z';
  const PAID = '2026-01-11T00:00:00.000Z';
  const paid = (familyId: string) => {
    db.seed('subscriptions', [{ id: `sub-${familyId}`, family_id: familyId, plan: 'family', status: 'active', created_at: '2026-01-01T00:00:00.000Z' }]);
    db.seed('admin_notifications', [{
      id: `note-${familyId}`, kind: 'subscription', related_type: 'subscription', related_id: familyId,
      created_at: PAID, meta: { plan: 'family', status: 'active' },
    }]);
  };

  it('counts only first-value rows a member of that household recorded', async () => {
    db.replace('activation_events', []);
    for (const family of FAMILY) paid(family);
    db.seed('activation_events', [
      // Household 1's own member, genuinely.
      activation({ user_id: USER[0], family_id: FAMILY[0], session_id: FAMILY[0], milestone: 'first_outcome_viewed', created_at: REACHED }),
      // Household 2, backdated by the anon key.
      activation({ user_id: null, family_id: FAMILY[1], session_id: FAMILY[1], milestone: 'first_outcome_viewed', created_at: '2020-01-01T00:00:00.000Z' }),
      // Household 3, backdated by an account that is not its member.
      activation({ user_id: 'user-9', family_id: FAMILY[2], session_id: FAMILY[2], milestone: 'first_outcome_viewed', created_at: '2020-01-01T00:00:00.000Z' }),
    ]);
    const { conversion } = await loadStrategyMetrics(db, NOW);
    expect(conversion).toMatchObject({ families: 1, recordedPaidActivations: 1, medianDays: 6, priorOnly: 0, missingEvidence: 0 });
  });

  it('fails the metric rather than counting rows it could not vouch for when the membership read fails', async () => {
    paid(FAMILY[0]);
    db.replace('activation_events', [activation({ user_id: USER[0], family_id: FAMILY[0], session_id: FAMILY[0], milestone: 'first_outcome_viewed', created_at: REACHED })]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'family_members') throw new Error('members unavailable');
      return from(table as never);
    }) as typeof db.from);
    expect((await loadStrategyMetrics(db, NOW)).conversion).toBeNull();
  });
});
