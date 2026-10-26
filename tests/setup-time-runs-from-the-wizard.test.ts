// /admin/onboarding's "Median setup time", "Setup completed within 90s" and
// its On target banner timed `completed_at - created_at` of onboarding_progress
// — and for the ordinary sign-up that row is born inside
// `onboarding_claim_family`, in the same finalize request that stamps
// `completed_at`. So the median was a few seconds and the goal was met whatever
// the wizard took (N7). A reset run kept its `completed_at`, still counted as a
// completed setup and never showed under "where incomplete runs stall", and its
// next completion was timed from the first run's row (N19). A failed read of
// the wizard starts then failed the whole audit, though only the timing reads
// them.
//
// Driven through the real page and the real progress writer over the
// in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type Row } from './helpers/in-memory-supabase';

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

const { default: AuditPage } = await import('@/app/(app)/admin/onboarding/page');
const { recordOnboardingProgress } = await import('@/lib/server/onboarding-progress');

type DB = SupabaseClient<Database>;
let db: ReturnType<typeof createInMemorySupabase<DB>>;
const uuid = (prefix: number, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let seq = 0;
const progress = (row: Row): Row => ({ id: uuid(1, ++seq), status: 'completed', value_engaged: true, steps_completed: ['profile'], reset_at: null, ...row });
const started = (userId: string, at: string): Row => ({ id: uuid(2, ++seq), user_id: userId, session_id: `run-${seq}`, step: 'profile', phase: 'started', duration_ms: 0, created_at: at });

async function auditHtml(): Promise<string> {
  let element = await AuditPage() as ReactElement;
  // The read-failure card is an async component; resolve it as the server renderer would.
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    element = await (element.type as (props: unknown) => Promise<ReactElement>)(element.props);
  }
  return renderToStaticMarkup(element).replace(/&#x27;|&#39;/g, "'");
}
/** The figure a stat card shows above `label`. */
function stat(html: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<p class="text-2xl[^"]*">([^<]*)</p><p class="[^"]*">${escaped}</p>`))?.[1] ?? null;
}

beforeEach(() => {
  seq = 0;
  db = createInMemorySupabase<DB>();
  state.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('setup time on /admin/onboarding (N7)', () => {
  it('times the wizard from its own start, not from the progress row the finalize request created', async () => {
    // Two sign-ups: each spent about ten minutes in the wizard, and each
    // progress row was created three seconds before its completion stamp.
    db.seed('onboarding_events', [started('user-1', '2026-09-01T10:00:00.000Z'), started('user-2', '2026-09-02T10:00:00.000Z')]);
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T10:10:00.000Z', completed_at: '2026-09-01T10:10:03.000Z' }),
      progress({ user_id: 'user-2', created_at: '2026-09-02T10:12:00.000Z', completed_at: '2026-09-02T10:12:03.000Z' }),
    ]);
    const html = await auditHtml();
    expect(stat(html, 'Median setup time')).toBe('10m 3s');
    expect(stat(html, 'Setup completed within 90s')).toBe('0%');
    expect(html).toContain('Below target.');
    expect(html).not.toContain('On target.');
  });

  it('leaves a run with no recorded wizard start untimed instead of timing it from the wrong clock', async () => {
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T10:10:00.000Z', completed_at: '2026-09-01T10:10:03.000Z' }),
    ]);
    const html = await auditHtml();
    expect(stat(html, 'Median setup time')).toBe('—');
    expect(html).toContain('No valid timing records yet.');
    expect(html).not.toContain('On target.');
  });

  it('starts an auto-provisioned account’s clock at its wizard, not at provisioning days earlier', async () => {
    db.seed('onboarding_events', [started('user-1', '2026-09-05T09:00:00.000Z')]);
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-05T09:01:00.000Z' }),
    ]);
    expect(stat(await auditHtml(), 'Median setup time')).toBe('1m');
  });
});

describe('a reset run on /admin/onboarding (N19)', () => {
  it('is not a completed setup, and shows where it stalled', async () => {
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z' }),
      // Reset afterwards; the old completion stamp is still on the row.
      progress({ user_id: 'user-2', status: 'reset', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z', reset_at: '2026-09-03T00:00:00.000Z' }),
    ]);
    const html = await auditHtml();
    expect(stat(html, 'Completion')).toBe('50%');
    expect(html).not.toContain('No incomplete runs');
  });

  it('a run back in progress that still carries an old completion stamp is not a completed setup', async () => {
    // A legacy row, or one prepareCalendarFamily reopened: it moves the status
    // to in_progress and leaves completed_at as it was.
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z' }),
      progress({ user_id: 'user-2', status: 'in_progress', steps_completed: ['profile', 'family'], created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z' }),
    ]);
    const html = await auditHtml();
    expect(stat(html, 'Completion')).toBe('50%');
    expect(html).not.toContain('No incomplete runs');
  });

  it('times a re-completion from the wizard run after the reset, not from the first run', async () => {
    db.seed('onboarding_events', [started('user-1', '2026-09-01T00:00:00.000Z'), started('user-1', '2026-09-08T12:00:00.000Z')]);
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-08T12:02:00.000Z', reset_at: '2026-09-08T11:00:00.000Z' }),
    ]);
    expect(stat(await auditHtml(), 'Median setup time')).toBe('2m');
  });

  it('the progress writer clears the completion when a run is reset or reopened', async () => {
    for (const status of ['reset', 'in_progress'] as const) {
      db.replace('onboarding_progress', [progress({ user_id: 'user-1', created_at: '2026-09-01T00:00:00.000Z', completed_at: '2026-09-01T00:05:00.000Z' })]);
      await recordOnboardingProgress(db, { userId: 'user-1', status });
      expect(db.table('onboarding_progress')).toHaveLength(1);
      expect(db.table('onboarding_progress')[0]).toMatchObject({ status, completed_at: null });
    }
  });
});

describe('a failed wizard-start read on /admin/onboarding', () => {
  it('still shows completion, the value step and where runs stall, and marks only the timing unavailable', async () => {
    db.seed('onboarding_events', [started('user-1', '2026-09-01T10:00:00.000Z')]);
    db.seed('onboarding_progress', [
      progress({ user_id: 'user-1', created_at: '2026-09-01T10:10:00.000Z', completed_at: '2026-09-01T10:10:03.000Z' }),
      progress({ user_id: 'user-2', status: 'in_progress', steps_completed: ['profile', 'family'], created_at: '2026-09-02T10:00:00.000Z', completed_at: null }),
    ]);
    state.db = withFaults(db, (table) => (table === 'onboarding_events' ? { message: 'onboarding_events unavailable' } : null));
    const html = await auditHtml();
    expect(html).not.toContain('Could not load onboarding audit data');
    expect(stat(html, 'Completion')).toBe('50%');
    expect(stat(html, 'Value step engaged')).toBe('100%');
    expect(html).toContain('Where incomplete runs stall');
    expect(html).not.toContain('No incomplete runs');
    // Only the timing says it could not be read; it is not "no timing yet".
    expect(stat(html, 'Median setup time')).toBe('—');
    expect(html).toContain('Setup timing could not be loaded');
    expect(html).not.toContain('No valid timing records yet.');
    expect(html).not.toContain('Excluded because timing is missing');
    expect(html).not.toContain('On target.');
    expect(html).not.toContain('Below target.');
  });
});
