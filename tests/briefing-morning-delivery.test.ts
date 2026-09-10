// The morning brief, delivered — once per family per family-local day.
//
// The cron composes the same brief the page shows and files ONE notification
// for the managers with the headline and what needs deciding. What this file
// pins: the notification exists and says what the brief says; a re-run, a
// retry and a read copy never produce a second one; the delivery instant is
// the family's morning, not the cron's; and a failed read means no brief,
// never a calm one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { briefRelatedId, deliverMorningBriefs, morningBriefBody, morningTarget, readMorningBrief } from '@/lib/briefing/deliver';
import { notify } from '@/lib/services/notifications';
import { scopeForSystem } from '@/lib/services/scope';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;

// The notifications cron ticks at 11:00 UTC: 7am New York, 4am Los Angeles, 11pm Auckland.
const TICK = new Date('2026-09-07T11:00:00Z');

function approvalRow(over: Record<string, unknown>) {
  return {
    family_id: 'fam-1', status: 'pending', domain: 'reminders', capability: 'reminders.create',
    requested_by_kind: 'ai', requested_by_member_id: null, agent: null, summary: null,
    payload: { name: 'reminders.create', args: { title: 'Pack the cleats' } }, payload_kind: 'tool',
    amount_cents: null, confidence: null, reasoning: null, required_approvals: 1, approval_model: null,
    approvals: [], priority: 'normal', expires_at: null, run_id: null, plan_step_id: null, plan_step_ids: null,
    consequences: [], edited_payload: null,
    ...over,
  };
}

function household(db: InMemorySupabase, timezone = 'America/New_York') {
  db.seed('families', [{ id: 'fam-1', timezone }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: 'fam-1', user_id: 'auth-parent', display_name: 'Alex', role: 'parent', is_active: true },
    { id: 'm-adult', family_id: 'fam-1', user_id: 'auth-adult', display_name: 'Jo', role: 'adult', is_active: true },
    { id: 'm-child', family_id: 'fam-1', user_id: 'auth-child', display_name: 'Sam', role: 'child', is_active: true },
  ]);
  db.seed('approval_requests', [
    approvalRow({ id: 'ap-1', title: 'Book the plumber for Tuesday 9am', created_at: '2026-09-07T08:00:00Z' }),
  ]);
  db.seed('family_automation_runs', [
    { id: 'run-q', family_id: 'fam-1', summary: 'Plan the weekend', state: 'awaiting_context', updated_at: '2026-09-07T09:30:00Z', created_at: '2026-09-07T07:00:00Z' },
    { id: 'run-done', family_id: 'fam-1', summary: 'Planned the week', state: 'completed', progress: { total: 3, completed: 3 }, completed_at: '2026-09-07T06:00:00Z', updated_at: '2026-09-07T06:00:00Z' },
    { id: 'run-old', family_id: 'fam-1', summary: 'Last week', state: 'completed', progress: { total: 2, completed: 2 }, completed_at: '2026-08-30T06:00:00Z', updated_at: '2026-08-30T06:00:00Z' },
  ]);
  db.seed('calendar_events', [
    { id: 'ev-1', family_id: 'fam-1', title: 'Dentist', starts_at: '2026-09-07T14:00:00Z', ends_at: '2026-09-07T15:00:00Z', all_day: false, location: null },
  ]);
  db.seed('bills', [
    { id: 'b-1', family_id: 'fam-1', name: 'Electric bill', amount: 120, due_date: '2026-09-05', status: 'unpaid' },
  ]);
  db.seed('medications', [{ id: 'med-1', family_id: 'fam-1', name: 'Amoxicillin', member_id: 'm-child', is_active: true }]);
  db.seed('medication_schedules', [
    { id: 'ms-1', family_id: 'fam-1', medication_id: 'med-1', time_of_day: '08:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null },
  ]);
}

const notifications = (db: InMemorySupabase) => db.table('notifications');

describe('morningTarget', () => {
  it('files for 7am today when the tick lands before the family’s morning', () => {
    const la = morningTarget(TICK, 'America/Los_Angeles'); // 4am
    expect(la.dayKey).toBe('2026-09-07');
    expect(la.at.toISOString()).toBe('2026-09-07T14:00:00.000Z'); // 07:00 PDT
  });

  it('sends now during the day', () => {
    const ny = morningTarget(TICK, 'America/New_York'); // 7am
    expect(ny.dayKey).toBe('2026-09-07');
    expect(ny.at.getTime()).toBe(TICK.getTime());
  });

  it('composes tomorrow’s brief for 7am tomorrow when the tick lands in the evening', () => {
    const nz = morningTarget(TICK, 'Pacific/Auckland'); // 11pm
    expect(nz.dayKey).toBe('2026-09-08');
    expect(nz.at.toISOString()).toBe('2026-09-07T19:00:00.000Z'); // 07:00 NZST on the 8th
  });
});

describe('deliverMorningBriefs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tells the managers once, with the headline the brief was built from and the decisions by name', async () => {
    const db = createInMemorySupabase<DB>();
    household(db);

    const result = await deliverMorningBriefs(db, TICK);
    expect(result).toEqual({ delivered: 1, families: 1, skipped: 0, failed: 0 });

    const rows = notifications(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.user_id).sort()).toEqual(['auth-adult', 'auth-parent']); // managers only — the child is not told the money
    for (const row of rows) {
      expect(row).toMatchObject({ family_id: 'fam-1', type: 'system', related_type: 'brief', related_id: 'brief:2026-09-07', send_at: TICK.toISOString() });
      // Decisions lead; the calendar and the overdue bill follow; the run that finished this morning counts, last week's does not.
      expect(row.title).toMatch(/^Morning brief: 2 decisions need you, 1 thing today, 1 overdue, 1 already handled\.$/);
      expect(row.body).toBe('• Plan the weekend — Bubaly has a question\n• Book the plumber for Tuesday 9am');
    }
  });

  it('is idempotent per family per day: re-runs, retries and read copies never send it twice', async () => {
    const db = createInMemorySupabase<DB>();
    household(db);

    await deliverMorningBriefs(db, TICK);
    const again = await deliverMorningBriefs(db, TICK);
    expect(again).toEqual({ delivered: 0, families: 1, skipped: 1, failed: 0 });
    expect(notifications(db)).toHaveLength(2);

    // Read, then an hour later: still the same two rows.
    for (const row of notifications(db)) row.is_read = true;
    const later = await deliverMorningBriefs(db, new Date(TICK.getTime() + 3600_000));
    expect(later).toEqual({ delivered: 0, families: 1, skipped: 1, failed: 0 });
    expect(notifications(db)).toHaveLength(2);

    // The next day is a new brief.
    const tomorrow = await deliverMorningBriefs(db, new Date(TICK.getTime() + 24 * 3600_000));
    expect(tomorrow).toEqual({ delivered: 1, families: 1, skipped: 0, failed: 0 });
    expect(notifications(db).filter((r) => r.related_id === 'brief:2026-09-08')).toHaveLength(2);
  });

  it('files the brief for the family’s 7am, not the cron’s', async () => {
    const db = createInMemorySupabase<DB>();
    household(db, 'America/Los_Angeles');
    await deliverMorningBriefs(db, TICK); // 4am there
    for (const row of notifications(db)) {
      expect(row.related_id).toBe('brief:2026-09-07');
      expect(row.send_at).toBe('2026-09-07T14:00:00.000Z');
    }
  });

  it('sends no brief for a family a read failed for, and says so', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createInMemorySupabase<DB>();
    household(db);
    const failing = { message: 'permission denied for table bills', code: '42501', details: null, hint: null };
    const broken = {
      from: (table: string) => {
        if (table !== 'bills') return db.from(table);
        const b: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'neq', 'lte', 'order', 'limit']) b[m] = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: failing });
        return b;
      },
    } as unknown as DB;

    const result = await deliverMorningBriefs(broken, TICK);
    expect(result).toEqual({ delivered: 0, families: 1, skipped: 0, failed: 1 });
    expect(notifications(db)).toHaveLength(0);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[briefing] morning brief bills read failed');
  });

  it('composes the manager view under a system scope, including the medication due today', async () => {
    const db = createInMemorySupabase<DB>();
    household(db);
    const scope = scopeForSystem(db, { id: 'fam-1', timezone: 'America/New_York' }, { now: TICK });
    const brief = await readMorningBrief(scope, morningTarget(TICK, 'America/New_York'));
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.data.digest.items.map((i) => i.domain)).toEqual(expect.arrayContaining(['bill', 'medication']));
    expect(brief.data.digest.items.find((i) => i.domain === 'medication')).toMatchObject({ title: 'Amoxicillin', member: 'Sam' });
    expect(brief.data.handled.map((h) => h.key)).toEqual(['run:run-done']);
    expect(brief.data.decisions.map((d) => d.id)).toEqual(['run:run-q', 'ai_approval:ap-1']);
    expect(morningBriefBody(brief.data)).toContain('Plan the weekend');
  });
});

describe('notify once', () => {
  it('drops a second copy of a once-only notification even after the first was read', async () => {
    const db = createInMemorySupabase<DB>();
    household(db);
    const scope = scopeForSystem(db, { id: 'fam-1', timezone: 'America/New_York' }, { now: TICK });
    const input = { recipients: 'managers' as const, type: 'system' as const, title: 'Morning brief: a quiet day.', relatedType: 'brief', relatedId: briefRelatedId('2026-09-07') };

    const first = await notify(scope, { ...input, once: true });
    expect(first).toMatchObject({ ok: true, data: { created: 2, duplicates: 0 } });
    for (const row of notifications(db)) row.is_read = true;

    const repeat = await notify(scope, { ...input, once: true });
    expect(repeat).toMatchObject({ ok: true, data: { created: 0, duplicates: 2 } });
    // The default guard is unread-only, which is why `once` exists.
    const routine = await notify(scope, input);
    expect(routine).toMatchObject({ ok: true, data: { created: 2 } });
  });
});
