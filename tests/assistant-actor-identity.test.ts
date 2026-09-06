import { describe, expect, it } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';

// Who the chat assistant says did the thing.
//
// `AssistantCtx` carries two ids that look interchangeable and are not:
// `userId` is `auth.users.id`, `memberId` is `family_members.id`. Every
// `created_by` in lib/assistant/tools.ts referenced `auth.users` EXCEPT the two
// to-do tables — `0015_todos.sql` points `todo_lists.created_by` and
// `todo_items.created_by` at `public.family_members(id)` — so writing `userId`
// there was a foreign-key violation and every chat "add a to-do" failed.
//
// The other half is worse than a failure. `ctx.members.find((m) => true)` is
// `members[0]` written to look like a lookup, and it decided who RSVP'd to an
// event and who signed an announcement. A teen saying "I'm going" was recorded
// as whoever sorts first in the roster.

type DbArg = Parameters<typeof buildAssistantTools>[0];
type Operation = 'select' | 'insert' | 'upsert' | 'update' | 'delete';
type Call = { table: string; operation: Operation; payload?: unknown };

function fakeDb(rowsFor: (table: string) => unknown[]) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      let operation: Operation = 'select';
      let payload: unknown;
      const chain: Record<string, unknown> = {};
      const finish = () => {
        calls.push({ table, operation, payload });
        const rows = rowsFor(table);
        return { data: operation === 'select' ? rows : (rows[0] ?? { id: `${table}-new` }), error: null };
      };
      const pass = () => chain;
      Object.assign(chain, {
        select: pass, eq: pass, ilike: pass, in: pass, is: pass, not: pass, gte: pass, lte: pass,
        order: pass, limit: pass,
        maybeSingle: () => Promise.resolve({ data: rowsFor(table)[0] ?? null, error: null }),
        single: () => Promise.resolve(finish()),
        insert(v: unknown) { operation = 'insert'; payload = v; return chain; },
        upsert(v: unknown) { operation = 'upsert'; payload = v; return chain; },
        update(v: unknown) { operation = 'update'; payload = v; return chain; },
        delete() { operation = 'delete'; return chain; },
        then(resolve: (value: unknown) => void) { return Promise.resolve(finish()).then(resolve); },
      });
      return chain as never;
    },
  } as unknown as DbArg;
  return { db, calls };
}

// The roster's FIRST entry is a parent; the person typing is the teen. If a
// write records `parent-1`, it recorded the wrong person.
const ROSTER = [
  { id: 'parent-1', display_name: 'Dana' },
  { id: 'teen-1', display_name: 'Maya' },
];
const ctx = (over: Partial<AssistantCtx> = {}): AssistantCtx => ({
  familyId: 'fam-1',
  userId: 'auth-user-uuid',
  memberId: 'teen-1',
  members: ROSTER,
  tz: 'America/New_York',
  ...over,
});

const run = async (name: string, args: Record<string, unknown>, c = ctx(), rows: (t: string) => unknown[] = () => []) => {
  const { db, calls } = fakeDb(rows);
  const tool = buildAssistantTools(db, c).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not in the assistant toolbox`);
  const result = await tool.execute(args);
  return { result, calls, insertTo: (table: string) => calls.find((k) => k.table === table && (k.operation === 'insert' || k.operation === 'upsert'))?.payload };
};

describe('the to-do writes use the roster id, not the login id', () => {
  it('stamps a new to-do list with family_members.id', async () => {
    // `todo_lists.created_by` references family_members. Writing `userId` here
    // is an FK violation, which is why the tool answered "Could not open a
    // to-do list" for any family that had not made one yet.
    const { insertTo } = await run('add_todo', { task: 'Call the dentist' });
    expect(insertTo('todo_lists')).toMatchObject({ family_id: 'fam-1', name: 'Tasks', created_by: 'teen-1' });
    expect(insertTo('todo_lists')).not.toMatchObject({ created_by: 'auth-user-uuid' });
  });

  it('stamps the to-do item itself with family_members.id', async () => {
    const { result, insertTo } = await run('add_todo', { task: 'Call the dentist', assignee: 'Maya' });
    expect(result).toMatchObject({ ok: true });
    expect(insertTo('todo_items')).toMatchObject({
      family_id: 'fam-1', title: 'Call the dentist', assigned_to_id: 'teen-1', created_by: 'teen-1',
    });
  });

  it('records no creator rather than a wrong one when the roster and session disagree', async () => {
    // The column is nullable with `on delete set null`, so an unattributed task
    // is a legitimate row. Refusing to add it would be the worse failure.
    const { result, insertTo } = await run('add_todo', { task: 'Call the dentist' }, ctx({ memberId: null }));
    expect(result).toMatchObject({ ok: true });
    expect(insertTo('todo_items')).toMatchObject({ created_by: null });
  });

  it('leaves the auth.users-keyed tables on the login id', async () => {
    // The fix is not "use memberId everywhere". calendar_events.created_by
    // really does reference auth.users(id), and swapping it would break the
    // write that currently works.
    const { insertTo } = await run('create_calendar_event', {
      title: 'Dentist', starts_at: '2026-09-10T14:00:00Z', ends_at: '2026-09-10T15:00:00Z',
    });
    expect(insertTo('calendar_events')).toMatchObject({ created_by: 'auth-user-uuid' });
  });
});

describe('an RSVP and an announcement are attributed to the person who spoke', () => {
  it('RSVPs as the acting member, not the first name in the roster', async () => {
    const { result, insertTo } = await run(
      'rsvp_to_event', { event_title: 'Game', status: 'accepted' }, ctx(),
      (table) => (table === 'calendar_events' ? [{ id: 'event-1', title: 'Game' }] : []),
    );
    expect(result).toMatchObject({ ok: true });
    expect(insertTo('event_rsvps')).toMatchObject({ event_id: 'event-1', member_id: 'teen-1', status: 'accepted' });
    // The bug in one assertion: `members[0]` is the parent.
    expect(insertTo('event_rsvps')).not.toMatchObject({ member_id: 'parent-1' });
  });

  it('signs an announcement with the acting member', async () => {
    const { result, insertTo } = await run('create_announcement', { title: 'Practice is cancelled' });
    expect(result).toMatchObject({ ok: true });
    expect(insertTo('family_announcements')).toMatchObject({ author_member_id: 'teen-1' });
    expect(insertTo('family_announcements')).not.toMatchObject({ author_member_id: 'parent-1' });
  });

  it('refuses both rather than guessing when there is no acting member', async () => {
    // Unlike a to-do, these two ARE statements about a person. An RSVP with no
    // name on it is not a weaker record — it is a different claim.
    for (const [name, args] of [
      ['rsvp_to_event', { event_title: 'Game', status: 'accepted' }],
      ['create_announcement', { title: 'Practice is cancelled' }],
    ] as const) {
      const { result, calls } = await run(name, args, ctx({ memberId: null }),
        (table) => (table === 'calendar_events' ? [{ id: 'event-1', title: 'Game' }] : []));
      expect(result, `${name} with no member`).toMatchObject({ ok: false });
      expect(calls.some((c) => c.operation === 'insert' || c.operation === 'upsert')).toBe(false);
    }
  });
});
