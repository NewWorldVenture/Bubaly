// The family's explicit date/time must be understood before a routine is saved.
// Real registry, adapter, trust, ledger and routine service; only database
// transport is modeled. These are not PostgreSQL/RLS or worker delivery tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { ROUTINE_ANCHORS } from '@/lib/services/routines/anchors';
import { nextCronRun, parseClockTime, parseSchedule } from '@/lib/services/routines/schedule';

type DB = SupabaseClient<Database>;
const server = vi.hoisted(() => ({ client: null as DB | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No test ledger client');
    return server.client;
  },
}));
const { toToolSpecs } = await import('@/lib/ai/tools/legacy-adapter');
const { createRoutine } = await import('@/lib/services/routines');

const FAMILY = 'family-routine-owner';
const PROMPT = 'Prepare our bags';
const NOW = new Date('2026-09-05T15:00:00Z');
const TZ = 'America/New_York';

function household(options: { role?: ServiceScope['role']; enabled?: boolean } = {}) {
  const db = createInMemorySupabase({ uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] } });
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: options.enabled ?? true, behavior: 'execute' }]);
  db.seed('vacations', [
    { id: 'own-trip', family_id: FAMILY, start_date: '2026-09-20' },
    { id: 'other-trip', family_id: 'other-family', start_date: '2026-09-10' },
  ]);
  const reads: string[] = [];
  const ruleInserts: unknown[] = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    reads.push(table);
    const builder = from(table);
    if (table === 'family_automation_rules') {
      const insert = builder.insert.bind(builder);
      vi.spyOn(builder, 'insert').mockImplementation((value) => {
        ruleInserts.push(structuredClone(value));
        return insert(value);
      });
    }
    return builder;
  });
  // The established test transport adapter is the only database type boundary.
  const client = db as unknown as DB;
  server.client = client;
  const scope: ServiceScope = {
    db: client, familyId: FAMILY, userId: 'auth-parent', memberId: 'member-parent',
    actorKind: 'ai', role: options.role ?? 'parent', tz: TZ, now: NOW,
  };
  const create = toToolSpecs(scope, { names: ['create_automation'] })[0];
  const preview = toToolSpecs(scope, { names: ['preview_schedule'] })[0];
  return { db, scope, reads, ruleInserts,
    create: (when: string) => create.execute({ when, prompt: PROMPT, name: null }),
    preview: (when: string) => preview.execute({ when }),
  };
}
type Household = ReturnType<typeof household>;

function expectNoRoutine(h: Household) {
  expect(h.ruleInserts).toEqual([]);
  expect(h.db.table('family_automation_rules')).toEqual([]);
  expect(h.db.table('agent_activity')).toEqual([]);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture must not use the network'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('an explicit invalid clock is not an absent clock', () => {
  it.each(['5:99pm', '5:60pm', '0am', '13pm', '24:00', '17:99', '25', '125', '5:6pm', '5:300pm', '5:30:12pm'])(
    'refuses the whole numeric token %s without a valid suffix or nine-am fallback', (clock) => {
      expect({ clock: parseClockTime(`at ${clock}`), schedule: parseSchedule(`every Sunday at ${clock}`, ROUTINE_ANCHORS) })
        .toEqual({ clock: null, schedule: null });
    },
  );

  it.each([
    'every morning at 5:99pm',
    'two days before every trip at 13pm',
    'the night before every game at 24:00',
  ])('does not rescue %s with a daypart or relative default', (when) => {
    expect(parseSchedule(when, ROUTINE_ANCHORS)).toBeNull();
  });

  it.each([
    ['12am', 0, 0], ['12pm', 12, 0], ['0:00', 0, 0], ['23:59', 23, 59],
    ['5:30pm', 17, 30], ['6', 18, 0], ['10', 10, 0],
  ] as const)('preserves the supported clock %s', (clock, hour, minute) => {
    expect(parseClockTime(`at ${clock}`)).toEqual({ hour, minute });
    expect(parseSchedule(`every Sunday at ${clock}`, ROUTINE_ANCHORS))
      .toEqual({ kind: 'cron', expr: `${minute} ${hour} * * 0`, said: `every Sunday at ${clock}` });
  });
});

describe('registered preview describes only a supported schedule', () => {
  it.each(['00th', '29th', '30th', '31st', '32nd', '100th'])(
    'refuses the explicit monthly ordinal %s instead of changing it to day one', async (ordinal) => {
      const h = household();
      const when = `every month on the ${ordinal} at 9am`;
      expect({ parsed: parseSchedule(when, ROUTINE_ANCHORS), preview: await h.preview(when) }).toMatchObject({
        parsed: null, preview: { ok: true, data: { understood: false, kind: null, detail: expect.stringContaining('could not tell') } },
      });
      expectNoRoutine(h);
      expect(h.db.table('ai_tool_calls')).toEqual([]);
    },
  );

  it.each(['every Sunday at 5:99pm', 'every Sunday at 5:6pm', 'two days before every trip at 13pm'])(
    'does not advertise the invalid clock in %s as understood', async (when) => {
      const h = household();
      expect(await h.preview(when)).toMatchObject({ ok: true, data: { understood: false, kind: null } });
      expectNoRoutine(h);
      expect(h.db.table('ai_tool_calls')).toEqual([]);
    },
  );
});

describe('registered create refuses before the routine write', () => {
  it.each([
    'monthly on the 31st at 9am',
    'monthly on the 100th at 9am',
    'every Sunday at 13pm',
    'every Sunday at 5:99pm',
    'two days before every trip at 5:99pm',
  ])('does not save or announce a different schedule for %s', async (when) => {
    const h = household();
    const result = await h.create(when);
    // Preserve actual durable effects in the causal RED assertion, rather
    // than stopping on ok:true before showing the incorrectly saved rule.
    expect({ result, rules: h.db.table('family_automation_rules'), activity: h.db.table('agent_activity'), inserts: h.ruleInserts })
      .toMatchObject({ result: { ok: false, error: expect.stringContaining('could not tell when') }, rules: [], activity: [], inserts: [] });
    expectNoRoutine(h);
    // A truthful failed tool receipt is legitimate; there was no rule write.
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({
      family_id: FAMILY, tool_name: 'routines.create', state: 'failed', resource_id: null,
    })]);
  });

  it.each(['monthly on the 29th at 9am', 'every Sunday at 17:99', 'two days before every trip at 5:6pm'])(
    'the service rejects %s before even reading an anchor or opening a table', async (said) => {
      const h = household();
      const result = await createRoutine(h.scope, { said, prompt: PROMPT });
      expect({ result, tables: h.reads, rules: h.db.table('family_automation_rules') })
        .toMatchObject({ result: { ok: false, code: 'invalid_input' }, tables: [], rules: [] });
      expectNoRoutine(h);
    },
  );
});

describe('supported schedules still reach the authorized durable boundary', () => {
  it.each([
    ['every month on the 1st at 9am', '0 9 1 * *', '2026-10-01T13:00:00.000Z'],
    ['every month on the 28th at 9am', '0 9 28 * *', '2026-09-28T13:00:00.000Z'],
    ['monthly at 8am', '0 8 1 * *', '2026-10-01T12:00:00.000Z'],
    ['every Sunday', '0 9 * * 0', '2026-09-06T13:00:00.000Z'],
    ['every Sunday at 5pm', '0 17 * * 0', '2026-09-06T21:00:00.000Z'],
    ['every day at 0:00', '0 0 * * *', '2026-09-06T04:00:00.000Z'],
  ])('previews and persists %s in the family timezone', async (when, expr, next) => {
    const h = household();
    expect(await h.preview(when)).toMatchObject({ ok: true, data: { understood: true, kind: 'cron', detail: `Understood as a repeating schedule (${expr}).` } });
    expectNoRoutine(h);
    const result = await h.create(when);
    expect(result).toMatchObject({ ok: true, summary: `Set up "${PROMPT}" — ${when}`, data: { routine: { id: expect.any(String), said: when, enabled: true, next_run_at: next } } });
    expect(h.db.table('family_automation_rules')).toEqual([expect.objectContaining({
      id: expect.any(String), family_id: FAMILY, created_by: 'auth-parent', said: when,
      schedule_kind: 'cron', schedule_expr: expr, next_run_at: next, is_enabled: true,
      action_type: 'ai_request', action_config: { prompt: PROMPT },
    })]);
    expect(h.ruleInserts).toHaveLength(1);
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({
      family_id: FAMILY, tool_name: 'routines.create', state: 'succeeded',
      resource_table: 'family_automation_rules', resource_id: h.db.table('family_automation_rules')[0].id,
    })]);
    expect(h.db.table('agent_activity')).toHaveLength(1);
  });

  it('keeps valid relative scheduling anchored to this family and its existing hour-only representation', async () => {
    const h = household();
    const when = 'two days before every trip';
    expect(await h.preview(when)).toMatchObject({ ok: true, data: { understood: true, kind: 'relative' } });
    expect(await h.create(when)).toMatchObject({ ok: true, data: { routine: { next_run_at: '2026-09-18T13:00:00.000Z' } } });
    expect(h.db.table('family_automation_rules')).toEqual([expect.objectContaining({
      family_id: FAMILY, schedule_kind: 'relative', anchor_key: 'trip', at_hour: 9,
      offset_days: -2, schedule_expr: null, next_run_at: '2026-09-18T13:00:00.000Z',
    })]);
    expect(h.ruleInserts).toHaveLength(1);
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ state: 'succeeded' })]);
    expect(h.db.table('agent_activity')).toHaveLength(1);
  });

  it('still refuses a child at the service boundary before any database call', async () => {
    const h = household({ role: 'child' });
    expect(await createRoutine(h.scope, { said: 'every Sunday at 5pm', prompt: PROMPT }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(h.reads).toEqual([]);
    expectNoRoutine(h);
  });

  it('still honors the real AI switch before a valid registered write', async () => {
    const h = household({ enabled: false });
    expect(await h.create('every Sunday at 5pm')).toMatchObject({ ok: false, error: expect.stringContaining('switched off') });
    expectNoRoutine(h);
    expect(h.db.table('ai_tool_calls')).toEqual([]);
  });

  it('does not broaden the natural-language grammar by changing stored standard cron day31', () => {
    expect(nextCronRun('0 9 31 * *', new Date('2026-01-31T09:00:00Z'), 'UTC')?.toISOString())
      .toBe('2026-03-31T09:00:00.000Z');
  });

  it('keeps standard cron day29 on leap February while skipping nonleap February', () => {
    expect(nextCronRun('0 9 29 * *', new Date('2028-02-01T00:00:00Z'), 'UTC')?.toISOString())
      .toBe('2028-02-29T09:00:00.000Z');
    expect(nextCronRun('0 9 29 * *', new Date('2026-02-01T00:00:00Z'), 'UTC')?.toISOString())
      .toBe('2026-03-29T09:00:00.000Z');
  });
});

describe('numeric token boundaries do not create a valid-looking suffix', () => {
  it.each(['every Sunday at 5 :6pm', 'every Sunday 5 :6pm'])(
    'refuses the spaced colon in %s through both registered tools', async (when) => {
      const h = household();
      const parsed = parseSchedule(when, ROUTINE_ANCHORS);
      const preview = await h.preview(when);
      const result = await h.create(when);
      expect({ parsed, preview, result, rules: h.db.table('family_automation_rules'), activity: h.db.table('agent_activity') })
        .toMatchObject({ parsed: null, preview: { ok: true, data: { understood: false, kind: null } },
          result: { ok: false, error: expect.stringContaining('could not tell when') }, rules: [], activity: [] });
      expectNoRoutine(h);
      expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ state: 'failed' })]);
    },
  );

  it('refuses an overlong zero-padded ordinal rather than extending the supported grammar', async () => {
    const h = household();
    const when = 'monthly on the 00028th at 9am';
    const parsed = parseSchedule(when, ROUTINE_ANCHORS);
    const preview = await h.preview(when);
    const result = await h.create(when);
    expect({ parsed, preview, result, rules: h.db.table('family_automation_rules'), activity: h.db.table('agent_activity') })
      .toMatchObject({ parsed: null, preview: { ok: true, data: { understood: false, kind: null } },
        result: { ok: false, error: expect.stringContaining('could not tell when') }, rules: [], activity: [] });
    expectNoRoutine(h);
  });

  it('preserves the originally supported two-digit zero-padded monthly spelling', async () => {
    const h = household();
    const when = 'monthly on the 01st at 9am';
    expect(parseSchedule(when, ROUTINE_ANCHORS)).toEqual({ kind: 'cron', expr: '0 9 1 * *', said: when });
    expect(await h.create(when)).toMatchObject({ ok: true, data: { routine: { next_run_at: '2026-10-01T13:00:00.000Z' } } });
    expect(h.db.table('family_automation_rules')).toEqual([expect.objectContaining({
      family_id: FAMILY, said: when, schedule_expr: '0 9 1 * *', next_run_at: '2026-10-01T13:00:00.000Z',
    })]);
    expect(h.ruleInserts).toHaveLength(1);
    expect(h.db.table('agent_activity')).toHaveLength(1);
  });

  it.each(['every Sunday at 5pm: plan our meals', 'every Sunday at 5pm : plan our meals', 'every Sunday at 17:00: plan our meals'])(
    'preserves a completed clock before the action delimiter in %s', async (when) => {
      const h = household();
      expect(parseClockTime(when)).toEqual({ hour: 17, minute: 0 });
      expect(await h.preview(when)).toMatchObject({ ok: true, data: { understood: true, kind: 'cron' } });
      expect(await h.create(when)).toMatchObject({ ok: true, data: { routine: { next_run_at: '2026-09-06T21:00:00.000Z' } } });
      expect(h.db.table('family_automation_rules')).toEqual([expect.objectContaining({
        family_id: FAMILY, said: when, schedule_expr: '0 17 * * 0', next_run_at: '2026-09-06T21:00:00.000Z',
      })]);
      expect(h.ruleInserts).toHaveLength(1);
      expect(h.db.table('agent_activity')).toHaveLength(1);
    },
  );
});
