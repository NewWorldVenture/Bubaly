import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { notify } from '@/lib/services/notifications';
import { scopeForSystem } from '@/lib/services/scope';
import { insertNotificationRows, UNIQUE_VIOLATION } from '@/lib/notifications/insert-once';
import { createInMemorySupabase, type UniqueSpec } from './helpers/in-memory-supabase';

/**
 * A NOTIFICATION IS WRITTEN ONCE PER OCCURRENCE.
 *
 * Both writers of `notifications` decide what to write with a READ and then
 * INSERT. The engine reads the keys it is about to announce and skips the ones
 * already there; notify() reads the unread copies of its key. Nothing in the
 * database stood behind either read, and two of the engine's three callers run
 * for one family at the same minute (the daily cron and the two-hourly push
 * scan are each mirrored by Vercel and the GitHub dispatcher), so two runs
 * could both read "not yet announced" and both write — one duplicate per
 * occurrence per concurrent pair, for every candidate type the engine writes
 * (audit note of 2026-10-04 07:34 UTC on #936).
 *
 * 0489 puts a partial unique index behind the read: (family_id, type,
 * related_id, user_id), NULLS NOT DISTINCT so the family-wide row is one
 * occurrence too, over UNREAD rows with a key — because notify() dedupes
 * against unread copies only and a later notice under a read key is
 * legitimate. The second writer is refused with 23505; both writers then write
 * their batch one row at a time around the refused row (insert-once.ts).
 *
 * The one key that could not live under that index was `medication_due`: the
 * bare medication id, recurring daily, deduped by a separate same-day read.
 * It now names the dose day (`<medication>:<day>`) and dedupes like every
 * other candidate, with the bare id carried as its legacy key so the first
 * run with the dated key does not remind a family that was reminded this
 * morning under the old one.
 *
 * The race is made deterministic here: a proxy lets the other run's row land
 * the instant this run's dedupe read resolves, which is exactly the window.
 */

type DB = SupabaseClient<Database>;
type Row = Record<string, unknown>;
const FAMILY = 'fam-once';
const PARENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const KID = 'cccccccc-dddd-4eee-8fff-000000000001';
const RENEWAL = '11111111-2222-4333-8444-555555555555';
const MED = '22222222-3333-4444-8555-666666666666';
const T0 = '2026-10-03T08:00:00.000Z';
const RENEWAL_KEY = `${RENEWAL}:2026-10-13`;
const MED_KEY_DAY1 = `${MED}:2026-10-03`;

/** 0489's index, as the fake enforces it. */
const INDEX_0489: UniqueSpec = {
  name: 'uq_notifications_unread_occurrence',
  columns: ['family_id', 'type', 'related_id', 'user_id'],
  nullsNotDistinct: true,
  where: (row) => row.related_id != null && row.is_read !== true,
};

let db: ReturnType<typeof createInMemorySupabase<DB>>;
const notices = (relatedType?: string) => db.table('notifications')
  .filter((n) => !relatedType || n.related_type === relatedType)
  .map((n) => ({ key: n.related_id as string | null, user_id: n.user_id as string | null }));
const generate = (client: DB = db as unknown as DB) => generateFamilyNotifications(client, FAMILY);

function household(opts: { index?: boolean } = {}) {
  db = createInMemorySupabase<DB>(opts.index === false ? {} : { uniques: { notifications: [INDEX_0489] } });
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: 'u-parent', role: 'parent', is_active: true, display_name: 'Parent', birthday: null },
    { id: KID, family_id: FAMILY, user_id: 'u-kid', role: 'child', is_active: true, display_name: 'Kid', birthday: null },
  ]);
}
/** Car insurance expires in ten days; its own lead is two weeks: one notice, to the manager. */
const withRenewal = () => db.seed('renewals', [{ id: RENEWAL, family_id: FAMILY, title: 'Car insurance', expires_at: '2026-10-13', reminder_days: 14, status: 'active' }]);
/** The kid's evening vitamin: one pending dose today, so one reminder, to the kid. */
const withMedication = () => {
  db.seed('medications', [{ id: MED, family_id: FAMILY, name: 'Vitamin D', dosage: '1 drop', member_id: KID, is_active: true }]);
  db.seed('medication_schedules', [{ id: 'sched-1', family_id: FAMILY, medication_id: MED, time_of_day: '20:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-01-01', ends_on: null }]);
};
const landed = (rows: Row[]) => { for (const r of rows) db.table('notifications').push(db.withDefaults('notifications', r)); };

/** The row the OTHER run writes for the renewal, exactly as the engine would. */
const competingRenewal = (): Row => ({
  family_id: FAMILY, user_id: 'u-parent', type: 'document_expiry', title: 'Renewal due: Car insurance', body: 'Expires Oct 13 · in 10 days',
  related_type: 'renewals', related_id: RENEWAL_KEY, is_read: false,
});

/**
 * The other run, landing `rows` between this run's dedupe read and its insert:
 * the first SELECT on notifications that resolves through this client writes
 * them straight into the table. The window a real race opens, held open.
 */
function raced(rows: Row[]): DB {
  let armed = true;
  const target = db as unknown as { from: (table: string) => Record<string, unknown> };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop !== 'from') return Reflect.get(t, prop, receiver);
      return (table: string) => {
        const builder = t.from(table);
        if (table !== 'notifications') return builder;
        return new Proxy(builder, {
          get(b, p) {
            if (p !== 'then') return Reflect.get(b, p);
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              (b as unknown as PromiseLike<unknown>).then((value) => {
                if (armed && (b as { op?: string }).op === 'select') { armed = false; landed(rows); }
                return value;
              }).then(resolve, reject);
          },
        });
      };
    },
  }) as unknown as DB;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  household();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('two engine runs for one family write an occurrence once', () => {
  it('the run that lost the race writes nothing and says so', async () => {
    withRenewal();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await generate(raced([competingRenewal()])), 'nothing of this run landed').toBe(0);
    expect(notices('renewals'), 'the winner\'s row stands alone').toEqual([{ key: RENEWAL_KEY, user_id: 'u-parent' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already written by a concurrent run'), expect.objectContaining({ familyId: FAMILY, refused: 1 }));
    expect(await generate(), 'the next tick has nothing to add').toBe(0);
  });

  it('the rest of the batch still lands around the occurrence the other run took', async () => {
    withRenewal();
    withMedication();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await generate(raced([competingRenewal()])), 'the medication reminder, written one row at a time').toBe(1);
    expect(notices('renewals')).toEqual([{ key: RENEWAL_KEY, user_id: 'u-parent' }]);
    expect(notices('medications')).toEqual([{ key: MED_KEY_DAY1, user_id: 'u-kid' }]);
  });

  it('control: without the index the same race writes the duplicate', async () => {
    household({ index: false });
    withRenewal();
    expect(await generate(raced([competingRenewal()]))).toBe(1);
    expect(notices('renewals'), 'two rows for one occurrence — what the index exists to refuse').toEqual([
      { key: RENEWAL_KEY, user_id: 'u-parent' }, { key: RENEWAL_KEY, user_id: 'u-parent' },
    ]);
  });
});

describe('the dedupe read failing is the tick failing, not a tick that writes everything again (review 5981509002)', () => {
  /** The in-memory client with every READ of `notifications` refused; the inserts are left alone. */
  function readsRefused(): DB {
    const target = db as unknown as { from: (table: string) => Record<string, unknown> };
    const refusal = { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' }, count: null };
    return new Proxy(target, {
      get(t, prop, receiver) {
        if (prop !== 'from') return Reflect.get(t, prop, receiver);
        return (table: string) => {
          const builder = t.from(table);
          if (table !== 'notifications') return builder;
          return new Proxy(builder, {
            get(b, p) {
              if (p !== 'select') return Reflect.get(b, p);
              return () => {
                const stub: Record<string | symbol, unknown> = new Proxy({}, {
                  get: (_s, name) => (name === 'then' ? (resolve: (v: unknown) => unknown) => Promise.resolve(refusal).then(resolve) : () => stub),
                });
                return stub;
              };
            },
          });
        };
      },
    }) as unknown as DB;
  }

  it('nothing is written and the family\'s tick fails, so the cron counts it and the next tick reads again', async () => {
    withRenewal();
    await expect(generate(readsRefused())).rejects.toThrow(/the dedup read failed for family .*; nothing was written this tick: canceling statement due to statement timeout/);
    expect(db.table('notifications'), 'not one row, keyed or not').toEqual([]);
    // The next tick, with its read answered, writes the occurrence once.
    expect(await generate()).toBe(1);
    expect(notices('renewals')).toEqual([{ key: RENEWAL_KEY, user_id: 'u-parent' }]);
  });

  it('control: with the read answered, the same household writes its notice', async () => {
    withRenewal();
    expect(await generate()).toBe(1);
  });
});

describe('notify() under the same index', () => {
  const brief = { type: 'system' as const, title: 'Your morning brief', body: 'Two things today.', relatedType: 'briefs', relatedId: 'brief:2026-10-03' };

  it('a copy another writer landed between the read and the insert is a duplicate, not a second row', async () => {
    const competing: Row = { family_id: FAMILY, user_id: 'u-parent', type: 'system', title: brief.title, body: brief.body, related_type: brief.relatedType, related_id: brief.relatedId, is_read: false };
    const res = await notify(scopeForSystem(raced([competing]), { id: FAMILY, timezone: 'UTC' }), { recipients: 'managers', ...brief });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ created: 0, ids: [], duplicates: 1, deferred: 0 });
    expect(notices('briefs')).toEqual([{ key: brief.relatedId, user_id: 'u-parent' }]);
  });

  it('…and once that copy is read, a later notice under the key lands (the unread-only rule is kept)', async () => {
    const first = await notify(scopeForSystem(db as unknown as DB, { id: FAMILY, timezone: 'UTC' }), { recipients: 'managers', ...brief });
    expect(first.ok && first.data.created).toBe(1);
    for (const row of db.table('notifications')) row.is_read = true;
    const again = await notify(scopeForSystem(db as unknown as DB, { id: FAMILY, timezone: 'UTC' }), { recipients: 'managers', ...brief });
    expect(again.ok && again.data.created, 'read, so not a duplicate — and not refused by the index either').toBe(1);
    expect(notices('briefs')).toHaveLength(2);
  });
});

describe('a medication is reminded about once a day, under a key that names the day', () => {
  it('today once, tomorrow again', async () => {
    withMedication();
    expect(await generate()).toBe(1);
    expect(notices('medications')).toEqual([{ key: MED_KEY_DAY1, user_id: 'u-kid' }]);
    expect(await generate(), 'the same day again: nothing').toBe(0);
    vi.setSystemTime('2026-10-04T08:00:00.000Z');
    expect(await generate(), 'the next day is the next occurrence').toBe(1);
    expect(notices('medications').map((n) => n.key)).toEqual([MED_KEY_DAY1, `${MED}:2026-10-04`]);
  });

  it('the first run with the dated key honours this morning\'s row under the bare id, and not yesterday\'s', async () => {
    withMedication();
    const bare = (created_at: string): Row => ({ family_id: FAMILY, user_id: 'u-kid', type: 'medication_due', title: 'Medication due: Vitamin D', related_type: 'medications', related_id: MED, created_at });
    landed([bare('2026-10-03T06:30:00.000Z')]); // an earlier deploy's run, earlier today
    expect(await generate(), 'already reminded today, under the old key').toBe(0);

    household();
    withMedication();
    landed([bare('2026-10-02T20:00:00.000Z')]); // yesterday's reminder
    expect(await generate(), 'yesterday\'s row is yesterday\'s occurrence').toBe(1);
    expect(notices('medications').map((n) => n.key)).toEqual([MED, MED_KEY_DAY1]);
  });
});

describe('insertNotificationRows, the one way both writers insert', () => {
  const write = (rows: Row[]) => db.from('notifications').insert(rows as never).select('id') as unknown as PromiseLike<{ data: { id: string }[] | null; error: { code?: string; message: string } | null }>;
  const row = (over: Row): Row => ({ family_id: FAMILY, user_id: null, type: 'system', title: 'Notice', related_type: 'things', related_id: 'thing:1', is_read: false, ...over });

  it('a clean batch is one statement; a refused batch is written one row at a time, minus the refused rows', async () => {
    const first = await insertNotificationRows([row({ related_id: 'thing:1' }), row({ related_id: 'thing:2' })], write);
    expect(first).toMatchObject({ written: 2, refused: 0, error: null });
    expect(first.ids).toHaveLength(2);
    const second = await insertNotificationRows([row({ related_id: 'thing:1' }), row({ related_id: 'thing:3' }), row({ related_id: 'thing:2' })], write);
    expect(second).toMatchObject({ written: 1, refused: 2, error: null });
    expect(second.ids).toHaveLength(1);
    expect(db.table('notifications').map((n) => n.related_id).sort()).toEqual(['thing:1', 'thing:2', 'thing:3']);
  });

  it('the family-wide row is one occurrence (nulls are not distinct), a read row leaves the index, a keyless row is outside it', async () => {
    expect((await insertNotificationRows([row({}), row({})], write)).refused, 'two family-wide copies').toBe(1);
    for (const n of db.table('notifications')) n.is_read = true;
    expect((await insertNotificationRows([row({})], write)).refused, 'after the first was read').toBe(0);
    expect((await insertNotificationRows([row({ related_id: null }), row({ related_id: null })], write)).refused, 'no key, no index').toBe(0);
  });

  it('an error that is not a refusal is returned as itself, with what landed before it', async () => {
    let calls = 0;
    const flaky = async (rows: Row[]) => {
      calls += 1;
      if (calls === 1) return { data: null, error: { code: UNIQUE_VIOLATION, message: 'duplicate key value' } };
      if (calls === 3) return { data: null, error: { code: '42501', message: 'permission denied' } };
      return write(rows);
    };
    const result = await insertNotificationRows([row({ related_id: 'a' }), row({ related_id: 'b' }), row({ related_id: 'c' })], flaky);
    expect(result.error).toEqual({ code: '42501', message: 'permission denied' });
    expect(result).toMatchObject({ written: 1, refused: 0 });
    expect(result.ids).toHaveLength(1);
  });
});

describe('the migration, the probe and the writers say the same thing', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('0489 is the index the code relies on, built over a non-destructive repair, and the price-drop trigger steps aside', () => {
    const sql = read('supabase/migrations/0489_a_notification_is_written_once_per_occurrence.sql');
    expect(sql).toContain('create unique index if not exists uq_notifications_unread_occurrence');
    expect(sql).toContain('on public.notifications (family_id, type, related_id, user_id) nulls not distinct');
    expect(sql).toContain('where related_id is not null and is_read = false;');
    expect(sql, 'the repair marks later unread duplicates read').toMatch(/set is_read = true/);
    expect(sql, 'and deletes nothing').not.toMatch(/delete\s+from\s+public\.notifications/i);
    expect(sql, '0191\'s trigger insert yields to the index').toMatch(/from public\.marketplace_saves s\s+where s\.listing_id = new\.id\s+on conflict do nothing;/);
    expect(sql).toContain("raise exception '0489 FAILED");
  });

  it('the Database job proves the index by name', () => {
    const probe = read('docs/audit/a-notification-is-written-once-per-occurrence-check.sql');
    expect(probe).toContain("get stacked diagnostics cname = constraint_name");
    expect(probe).toContain("cname <> 'uq_notifications_unread_occurrence'");
    expect(probe).toContain('update public.marketplace_listings set price_cents = 9000');
  });

  it('both writers insert through insertNotificationRows, and the medication key names the day', () => {
    const engine = read('lib/server/notifications.ts');
    expect(engine).toContain("insertNotificationRows(allRows, (batch) => supabase.from('notifications').insert(batch).select('id'))");
    expect(engine, 'the separate same-day medication read is gone').not.toContain(".gte('created_at', todayStartIso)");
    expect(engine).toContain('candidates.unshift(...medicationDueReminders(');
    const service = read('lib/services/notifications/index.ts');
    expect(service).toContain("insertNotificationRows(rows, (batch) => writer.from('notifications').insert(batch).select('id'))");
    expect(service).toContain('duplicates: duplicates + written.refused');
    const meds = read('lib/notifications/medication-reminders.ts');
    expect(meds).toContain('related_id: `${med.id}:${dayKey}`');
    expect(meds).toContain('legacy: { related_id: med.id, since: dayStartIso }');
  });
});
