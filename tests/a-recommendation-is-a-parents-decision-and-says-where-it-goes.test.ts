// Needs Your Decision: who may decide a recommendation, where its card goes,
// and whether the page says what its caps left out.
//
//   N4  — Needs You draws the Accept / Dismiss buttons for parents and adults
//         only, but setRecommendationStatus — and the generic record actions,
//         where family_ai_recommendations was open to every role — checked
//         only that the caller was signed in. A child or a guest could take
//         the planner's "recommend, don't act" card out of the parents' queue,
//         rewrite it, or delete it; the autonomous-management page drew the
//         buttons for everyone.
//   N14 — a recommendation's `cta_href` is free text on a row a member could
//         write, and its card linked to it as written: a card in the parent's
//         queue could send them to https://evil.example/login.
//   N13 — the page says it lists everything waiting on a person, but each
//         source is read to a cap (50 recommendations, 50 approvals, …) and the
//         page passed `more={0}`: with 70 pending, it showed and counted 50.
//
// Driven through the real actions, the real pages and the real list builder
// against an in-memory database.
import { createElement, type ReactNode } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';

const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));
const FAMILY = 'fam-1';
const ctx = () => ({
  user: { id: 'user-1', email: 'member@example.invalid' },
  memberships: [],
  active: { familyId: FAMILY, role: h.role, member: { id: 'member-1', role: h.role, display_name: 'Sam' }, family: { id: FAMILY, name: 'Rivera', timezone: 'UTC' } },
});
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => ({ ok: true }) }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default' as const, messages }),
  };
});
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtRelative: (value: string) => value }) }));
vi.mock('@/lib/family/signals', () => ({
  gatherSignalsResult: async () => ({
    error: null,
    data: { stress: { level: 'low', factors: [], suggestions: [] }, completion: 80, actions: [], counts: { openTasks: 0, overdueBills: 0, billsDueSoon: 0, appointmentsToday: 0, homeworkDueSoon: 0, sportsThisWeek: 0 } },
  }),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement('a', { ...props, href }, children) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }), usePathname: () => '/dashboard/needs-you' }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {}, info: () => {} }) }));

const { setRecommendationStatus, updateFamilyRecord, deleteFamilyRecord, createFamilyRecord } = await import('@/lib/family/actions');
const NeedsYouPage = (await import('@/app/(app)/dashboard/needs-you/page')).default;
const AutonomousPage = (await import('@/app/(app)/dashboard/autonomous-family-management/page')).default;

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: InMemorySupabase;
const rec = (id: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, member_id: null, category: 'planning', title: `Recommendation ${id}`, body: null, priority: 'medium',
  cta_href: null, source: 'planner', status: 'pending', created_at: `2026-10-01T00:${String(Number(id.replace(/\D/g, '')) % 60).padStart(2, '0')}:00.000Z`, ...extra,
});
const status = (id: string) => db.table('family_ai_recommendations').find((r) => r.id === id)?.status;

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db; h.role = 'parent';
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, display_name: 'Sam', role: 'parent', is_active: true }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a pending recommendation is decided by a parent or an adult (N4)', () => {
  beforeEach(() => db.seed('family_ai_recommendations', [rec('rec-1')]));

  it.each(['child', 'teen', 'guest', 'caregiver'])('a %s cannot dismiss, rewrite, delete or plant one', async (role) => {
    h.role = role;
    expect(await setRecommendationStatus('rec-1', 'dismissed')).toMatchObject({ ok: false });
    expect(await updateFamilyRecord('family_ai_recommendations', 'rec-1', { status: 'dismissed', title: 'Nothing to see' })).toMatchObject({ ok: false });
    expect(await deleteFamilyRecord('family_ai_recommendations', 'rec-1')).toMatchObject({ ok: false });
    expect(await createFamilyRecord('family_ai_recommendations', { title: 'Re-verify your bank login', cta_href: 'https://evil.example/login' })).toMatchObject({ ok: false });
    expect(db.table('family_ai_recommendations')).toEqual([expect.objectContaining({ id: 'rec-1', status: 'pending', title: 'Recommendation rec-1' })]);
  });

  it.each(['parent', 'adult'])('a %s can', async (role) => {
    h.role = role;
    expect(await setRecommendationStatus('rec-1', 'accepted')).toMatchObject({ ok: true });
    expect(status('rec-1')).toBe('accepted');
  });

  it('the autonomous-management page draws the decision buttons for a parent only', async () => {
    h.role = 'child';
    const child = renderTranslated(await AutonomousPage());
    expect(child).toContain('Recommendation rec-1');
    expect(child).not.toContain(t('recordActions.accept'));
    h.role = 'parent';
    expect(renderTranslated(await AutonomousPage())).toContain(t('recordActions.accept'));
  });
});

describe('a recommendation card links inside the app (N14)', () => {
  it('an off-app or protocol-relative cta_href falls back to the recommendations page', async () => {
    db.seed('family_ai_recommendations', [
      rec('rec-1', { title: 'Re-verify your bank login', cta_href: 'https://evil.example/login' }),
      rec('rec-2', { title: 'Look here', cta_href: '/\\evil.example' }),
      rec('rec-3', { title: 'Also here', cta_href: '//evil.example' }),
      rec('rec-4', { title: 'Plan dinner', cta_href: '/dashboard/meals' }),
    ]);
    const html = renderTranslated(await NeedsYouPage());
    expect(html).not.toContain('evil.example');
    expect(html).toContain('href="/dashboard/meals"');
    expect(html.match(/href="\/dashboard\/autonomous-family-management"/g)).toHaveLength(3);
  });
});

describe('Needs Your Decision counts what its caps left out (N13)', () => {
  it('with 70 pending recommendations it shows 50 and says 20 more need you', async () => {
    db.seed('family_ai_recommendations', Array.from({ length: 70 }, (_, i) => rec(`rec-${i + 1}`)));
    const html = renderTranslated(await NeedsYouPage());
    expect(html.match(/Recommendation rec-\d+/g)).toHaveLength(50);
    expect(html).toContain('70 things need you.');
    expect(html).toContain(t('needsAttention.moreItemsNeedYou', { n: 20 }));
  });

  it('below the caps the page is the whole list and says nothing more', async () => {
    db.seed('family_ai_recommendations', Array.from({ length: 3 }, (_, i) => rec(`rec-${i + 1}`)));
    const html = renderTranslated(await NeedsYouPage());
    expect(html).toContain('3 things need you.');
    expect(html).not.toContain('more item');
  });
});
