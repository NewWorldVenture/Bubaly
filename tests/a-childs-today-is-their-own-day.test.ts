import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createFormat } from '@/lib/utils/format';
import { onMembersDay } from '@/lib/calendar/members-day';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// The kids page ("My Bubaly") promises "only the kid's own world", and its
// Today list is described as "the child's own tasks + shared family events".
// It listed EVERY calendar event of the day: Dad's "Colonoscopy prep", a
// sibling's "Therapy with Dr. Lee", Mum's work calls — the parents' and
// siblings' appointments on the screen built to be the child's.
//
// The home dashboard already shows a member only what is assigned to nobody
// (the household's) and what is assigned to them (`visibleToMember` in
// components/dashboard/ai-home-dashboard.tsx). The kids page now applies the
// same rule, and both read it from one place.

const FAMILY = '10000000-0000-4000-8000-000000000001';
const MAYA = '20000000-0000-4000-8000-000000000001';
const LEO = '20000000-0000-4000-8000-000000000002';
const DAD = '20000000-0000-4000-8000-000000000003';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-maya' },
    active: { familyId: FAMILY, role: 'child', family: { name: 'Fixture', timezone: 'UTC' }, member: { id: MAYA, display_name: 'Maya', color: 'blue', role: 'child' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages: {} }) }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async (zone: string) => createFormat('en-US', undefined, zone) }));

import KidsPage from '@/app/(app)/kids/page';

const event = (id: string, title: string, assignee_id: string | null, hour: number) => ({
  id, family_id: FAMILY, title, assignee_id,
  starts_at: `2026-10-13T${String(hour).padStart(2, '0')}:00:00Z`, ends_at: `2026-10-13T${String(hour + 1).padStart(2, '0')}:00:00Z`,
  all_day: false, recurrence: 'none', recurrence_until: null, description: null, location: null, category: 'general',
  feed_id: null, external_uid: null, created_by: null, onboarding_key: null, idempotency_key: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T07:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = createInMemorySupabase<SupabaseClient<Database>>();
  db.seed('calendar_events', [
    event('30000000-0000-4000-8000-000000000001', 'Family pizza night', null, 18),
    event('30000000-0000-4000-8000-000000000002', 'Maya swim lesson', MAYA, 16),
    event('30000000-0000-4000-8000-000000000003', 'Leo therapy with Dr. Lee', LEO, 15),
    event('30000000-0000-4000-8000-000000000004', 'Dad colonoscopy prep', DAD, 9),
  ]);
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a child's Today is their own day", () => {
  it('shows the household\'s events and the child\'s own, not a parent\'s or a sibling\'s', async () => {
    const html = renderToStaticMarkup(await KidsPage());
    expect(html).toContain('Family pizza night');
    expect(html).toContain('Maya swim lesson');
    expect(html).not.toContain('Leo therapy with Dr. Lee');
    expect(html).not.toContain('Dad colonoscopy prep');
  });

  it('the rule is the one the home dashboard uses: unassigned, or assigned to the member', () => {
    const mine = onMembersDay(MAYA);
    expect(mine({ assignee_id: null })).toBe(true);
    expect(mine({ assignee_id: MAYA })).toBe(true);
    expect(mine({ assignee_id: LEO })).toBe(false);
    const dashboard = readFileSync('components/dashboard/ai-home-dashboard.tsx', 'utf8');
    expect(dashboard).toContain('const visibleToMember = onMembersDay(myMemberId);');
  });
});
