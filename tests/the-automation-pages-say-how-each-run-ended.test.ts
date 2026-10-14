// N4 — the two automation pages listed runs by the legacy `status` column.
// legacyStatusFor (lib/ai/runs/states.ts) writes 'approved' for a run that is
// executing, verifying or ready, and for blocked and paused ones, and
// 'executed' for partially_completed. So "Completed Automations" (autonomous
// management) and "Recent runs" (family automation) showed a run the executor
// had BLOCKED, one it had paused and one still in flight under a green check,
// and neither page ever selected a failed run.
//
// N7 — the autonomous page drew Accept / Dismiss on every pending
// recommendation for every viewer, printed its full body, and
// setRecommendationStatus checked membership only: a child or a guest took a
// parent's pending decision off every parent's queue before a parent saw it.
//
// Both pages are rendered the way the app renders them — the real page, the
// real translator over next/headers' locale cookie, inside the real
// LocaleProvider — against the in-memory database. The family's counts loader
// is the one seam (it reads a dozen tables none of this is about).
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { LOCALE_COOKIE, localeOrDefault } from '@/lib/i18n/locales';

const FAMILY = 'fam-auto-1';
const h = vi.hoisted(() => ({ db: null as unknown, role: 'parent' }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = async () => ({
    user: { id: `user-${h.role}`, email: `${h.role}@example.test` },
    memberships: [],
    active: { familyId: 'fam-auto-1', role: h.role, member: { id: `mem-${h.role}` }, family: { id: 'fam-auto-1', timezone: 'UTC' } },
  });
  return { requireUserContext: ctx, requireFeature: ctx };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: 'en-US' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }), redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/family/signals', () => ({
  gatherSignalsResult: async () => ({
    error: null,
    data: {
      stress: { level: 'moderate', score: 40, factors: [], suggestions: [] },
      completion: 80,
      actions: [],
      counts: { openTasks: 0, overdueBills: 0, billsDueSoon: 0, appointmentsToday: 0, homeworkDueSoon: 0, sportsThisWeek: 0 },
    },
  }),
}));

const { default: AutonomousPage } = await import('@/app/(app)/dashboard/autonomous-family-management/page');
const { default: FamilyAutomationPage } = await import('@/app/(app)/dashboard/family-automation/page');
const { setRecommendationStatus } = await import('@/lib/family/actions');
const { LocaleProvider } = await import('@/components/i18n/locale-provider');
const { getMessages } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;

async function open(page: () => Promise<unknown>): Promise<string> {
  const tree = await page();
  return renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    tree as React.ReactElement,
  )).replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The list row that names `summary`: its mark and the words beside it. */
function row(html: string, summary: string): { outcome: string | null; text: string } | null {
  const item = html.split(/<li[\s>]/).find((chunk) => chunk.includes(`>${summary}<`));
  if (!item) return null;
  return {
    outcome: /data-outcome="([a-z_]+)"/.exec(item)?.[1] ?? null,
    text: item.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  };
}

const run = (id: string, summary: string, state: string, status: string, minutesAgo: number) => ({
  id, family_id: FAMILY, summary, state, status, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_automation_runs', [
    run('r-done', 'Booked the dentist', 'completed', 'executed', 1),
    run('r-partial', 'Planned the week', 'partially_completed', 'executed', 2),
    run('r-blocked', 'Paid the plumber', 'blocked', 'approved', 3),
    run('r-paused', 'Ordered groceries', 'paused', 'approved', 4),
    run('r-working', 'Drafting the school email', 'executing', 'approved', 5),
    run('r-failed', 'Renewed the passport', 'failed', 'failed', 6),
    run('r-legacy', 'Sent the old reminder', 'queued', 'executed', 7),
  ]);
  db.seed('family_ai_recommendations', [{
    id: 'rec-1', family_id: FAMILY, title: 'Pay the plumber this week', status: 'pending', priority: 'high', category: 'money',
    body: 'Move $400 from the holiday savings to cover the plumber invoice.', created_at: new Date().toISOString(),
  }]);
});

describe.each([
  ['/dashboard/autonomous-family-management', () => AutonomousPage()],
  ['/dashboard/family-automation', () => FamilyAutomationPage()],
])('%s lists each run by how it ended', (_path, page) => {
  it('gives the green check to a completed run only, and names every other ending', async () => {
    const html = await open(page);
    expect(row(html, 'Booked the dentist')).toMatchObject({ outcome: 'completed', text: expect.stringContaining('Done') });
    expect(row(html, 'Sent the old reminder')).toMatchObject({ outcome: 'completed' });
    expect(row(html, 'Planned the week')).toMatchObject({ outcome: 'partially_completed', text: expect.stringContaining('Partly done') });
    expect(row(html, 'Paid the plumber')).toMatchObject({ outcome: 'blocked', text: expect.stringContaining('Blocked') });
    expect(row(html, 'Ordered groceries')).toMatchObject({ outcome: 'paused', text: expect.stringContaining('Paused') });
  });

  it('lists a failed run, and not one still in flight', async () => {
    const html = await open(page);
    expect(row(html, 'Renewed the passport')).toMatchObject({ outcome: 'failed', text: expect.stringContaining('Failed') });
    expect(row(html, 'Drafting the school email')).toBeNull();
  });
});

describe('a pending recommendation is the parents\' to decide', () => {
  it('a parent reads it whole and can accept or dismiss it', async () => {
    const html = await open(() => AutonomousPage());
    const rec = row(html, 'Pay the plumber this week')!;
    expect(rec.text).toContain('Move $400 from the holiday savings');
    expect(rec.text).toContain('Accept');
    expect(rec.text).toContain('Dismiss');
  });

  it.each(['child', 'teen', 'guest', 'caregiver'])('a %s reads its title, not its body, and is offered no decision', async (role) => {
    h.role = role;
    const html = await open(() => AutonomousPage());
    const rec = row(html, 'Pay the plumber this week')!;
    expect(rec.text).not.toContain('$400');
    expect(rec.text).not.toContain('Accept');
    expect(rec.text).not.toContain('Dismiss');
    expect(rec.text).toContain('Awaiting parent');
  });

  it.each(['child', 'guest'])('a %s cannot take it off the parents\' queue through the action either', async (role) => {
    h.role = role;
    expect(await setRecommendationStatus('rec-1', 'dismissed')).toEqual({ ok: false, error: 'Your account can’t make that change.' });
    expect(db.table('family_ai_recommendations')[0].status).toBe('pending');

    h.role = 'parent';
    expect(await setRecommendationStatus('rec-1', 'accepted')).toEqual({ ok: true, id: 'rec-1' });
    expect(db.table('family_ai_recommendations')[0].status).toBe('accepted');
  });
});
