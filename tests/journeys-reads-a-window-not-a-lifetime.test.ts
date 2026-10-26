// /dashboard/journeys read the active household's journey_events for all time
// under a 5,000-row ceiling, and reaching the ceiling refused the whole page —
// so ordinary use, or any member filing rows in a loop (0124's insert checks
// only the family), blanked it for good. Any duration was also a timing, so
// one row claiming a journey took 30 years moved the per-journey median (N17).
// Driven through the real page over the in-memory database.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { formatDuration } from '@/lib/analytics/journey';

const FAMILY = 'f1';
const NOW = '2026-10-14T10:00:00.000Z';
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-admin' }, active: { familyId: 'f1', role: 'parent' } }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, vars?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, vars) };
});
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));

const { default: JourneysPage } = await import('@/app/(app)/dashboard/journeys/page');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
let seq = 0;
const event = (row: Row): Row => ({
  id: `ev-${String(++seq).padStart(6, '0')}`, family_id: FAMILY, member_id: null, journey: 'capture',
  step: 1, session_id: `s-${seq}`, duration_ms: null, created_at: '2026-10-10T00:00:00.000Z', ...row,
});
const html = async () => renderToStaticMarkup(await JourneysPage() as ReactElement).replace(/&#x27;|&#39;/g, "'");

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>({ maxRows: 1000 });
  h.db = db;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('/dashboard/journeys (N17)', () => {
  it('keeps rendering after the household’s lifetime history passes the read ceiling', async () => {
    // Months of ordinary history, older than the window.
    db.seed('journey_events', Array.from({ length: 5001 }, () => event({ phase: 'started', created_at: '2026-06-01T00:00:00.000Z' })));
    // This month: two runs, one finished in four seconds.
    db.seed('journey_events', [
      event({ phase: 'started', session_id: 'a' }), event({ phase: 'completed', session_id: 'a', duration_ms: 4000 }),
      event({ phase: 'started', session_id: 'b' }),
    ]);
    const page = await html();
    expect(page).not.toContain('load journey telemetry');
    expect(page).toContain('Last 30 days.');
    expect(page).toContain('50%');
  });

  it('does not let a duration no journey could take move the median', async () => {
    db.seed('journey_events', [
      event({ phase: 'started', session_id: 'a' }), event({ phase: 'completed', session_id: 'a', duration_ms: 4000 }),
      event({ phase: 'started', session_id: 'x' }), event({ phase: 'completed', session_id: 'x', duration_ms: 1e12 }),
    ]);
    expect(await html()).toContain(`<td class="py-2.5 px-3 tabular-nums text-muted">${formatDuration(4000)}</td>`);
  });
});
