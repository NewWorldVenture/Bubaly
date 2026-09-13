import { describe, expect, it } from 'vitest';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { answerAssistant, type AssistantLink } from '@/lib/assistant/service';
import { BUBALY_SWITCHED_OFF_SPEECH } from '@/lib/assistant/answers';

// Three things a speaker in the kitchen was doing that the app had already
// promised it would not:
//
//   1. It kept creating events, notes, tasks and shopping items for families
//      who had switched Bubaly off. Settings → Bubaly AI says, in these words,
//      "Bubaly is switched off: it will still answer questions, but it will not
//      change anything for your family."
//   2. It put spoken items into ARCHIVED lists — reliably, because it took the
//      family's oldest list, which is the one most likely to have been put away.
//   3. It could not see recurring events at all, so the school run, practice
//      and bin day — most of what a family actually asks a speaker about — were
//      invisible to "what's on today".

const NY = 'America/New_York';
// 21:30 UTC on Monday 14 September 2026 is 17:30 Monday in New York.
const NOW = new Date('2026-09-14T21:30:00Z');

const link: AssistantLink = {
  id: 'link-1', family_id: 'fam-1', user_id: 'user-1',
  provider: 'alexa', scopes: ['ask', 'capture'], timezone: NY,
};

type Row = Record<string, unknown>;
type Write = { table: string; payload: unknown };

/**
 * A query builder that actually filters.
 *
 * A fake that accepts every filter and returns a fixed row proves nothing about
 * a fix whose whole content IS a filter — it would pass just as happily with
 * the archive check deleted. These apply eq/neq/is/gte/lt to real rows.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const writes: Write[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (column: string, value: unknown) => { rows = rows.filter((r) => r[column] === value); return chain; },
      neq: (column: string, value: unknown) => { rows = rows.filter((r) => r[column] !== value); return chain; },
      is: (column: string, value: unknown) => { rows = rows.filter((r) => (r[column] ?? null) === value); return chain; },
      in: (column: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[column])); return chain; },
      gte: (column: string, value: unknown) => { rows = rows.filter((r) => String(r[column]) >= String(value)); return chain; },
      lt: (column: string, value: unknown) => { rows = rows.filter((r) => String(r[column]) < String(value)); return chain; },
      not: () => chain,
      // `.or('recurrence_until.is.null,recurrence_until.gte.X')` is a widening
      // filter over a set the expansion narrows again by `recurrence_until`, so
      // passing it through here cannot hide a defect: an out-of-date series
      // still has to be dropped, and a test below insists it is.
      or: () => chain,
      order: (column: string) => {
        rows = [...rows].sort((a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')));
        return chain;
      },
      limit: (n: number) => { rows = rows.slice(0, n); return chain; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
      update: () => chain,
      insert: (payload: unknown) => {
        writes.push({ table, payload });
        const created = { id: `${table}-new` };
        (tables[table] ??= []).push(created);
        const inserted: Record<string, unknown> = {
          select: () => inserted,
          single: async () => ({ data: created, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return inserted;
      },
    };
    return chain;
  };
  return { db: { from } as never, writes };
}

const say = async (utterance: string, tables: Record<string, Row[]>) => {
  const { db, writes } = fakeDb(tables);
  const reply = await answerAssistant(db, link, classifyAssistantUtterance(utterance, NOW, NY), NOW);
  return { reply, writes };
};

describe('switched off means switched off, in the kitchen too', () => {
  const off = () => ({ family_ai_settings: [{ family_id: 'fam-1', enabled: false }] });

  it.each([
    'add soccer practice tomorrow at 4pm',
    'remind me to renew the passports on friday',
    'add milk to the shopping list',
    'make a note that the boiler is serviced in march',
  ])('refuses to save "%s" and says why', async (utterance) => {
    const { reply, writes } = await say(utterance, off());
    expect(reply.outcome).toBe('refused');
    expect(reply.speech).toBe(BUBALY_SWITCHED_OFF_SPEECH);
    // Not one row. Not a list created "ready for later", either.
    expect(writes.filter((w) => w.table !== 'assistant_link_events')).toEqual([]);
  });

  it('still answers questions, which is the other half of the promise', async () => {
    const { reply } = await say("what's on today", {
      ...off(),
      calendar_events: [{
        id: 'e1', family_id: 'fam-1', title: 'Dentist', starts_at: '2026-09-14T19:00:00.000Z',
        ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null,
      }],
    });
    expect(reply.outcome).toBe('answered');
    expect(reply.speech).toContain('Dentist');
  });

  it('saves normally when the family has switched Bubaly on', async () => {
    const { reply, writes } = await say('add soccer practice tomorrow at 4pm', {
      family_ai_settings: [{ family_id: 'fam-1', enabled: true }],
    });
    expect(reply.outcome).toBe('captured');
    expect(writes.some((w) => w.table === 'calendar_events')).toBe(true);
  });

  it('saves normally when the family has never opened the setting', async () => {
    // Absent is "carry on as before", not "off". A family that never visited
    // the page has not made a decision, and reading one into the gap would
    // break the feature for everyone on day one.
    const { reply, writes } = await say('add soccer practice tomorrow at 4pm', {});
    expect(reply.outcome).toBe('captured');
    expect(writes.some((w) => w.table === 'calendar_events')).toBe(true);
  });

  it('reads the setting for the link’s family and no other', async () => {
    const { reply } = await say('add soccer practice tomorrow at 4pm', {
      family_ai_settings: [{ family_id: 'someone-else', enabled: false }],
    });
    expect(reply.outcome).toBe('captured');
  });
});

describe('an item goes on a list somebody still looks at', () => {
  const item = 'add milk to the shopping list';
  const listIdOf = (writes: Write[]) =>
    (writes.find((w) => w.table === 'grocery_items')?.payload as Row[] | undefined)?.[0]?.list_id;

  it('uses a live grocery list', async () => {
    const { writes } = await say(item, {
      grocery_lists: [{ id: 'live', family_id: 'fam-1', is_archived: false, archived_at: null, created_at: '2020-01-01' }],
    });
    expect(listIdOf(writes)).toBe('live');
  });

  it('will not use one the family archived with archived_at', async () => {
    // The real-world case. Nothing in the app ever writes `is_archived`; the
    // shopping module stamps `archived_at`. An is_archived-only reader
    // therefore calls an archived list open and the milk goes where nobody
    // looks — while the speaker cheerfully says "added to your list".
    const { writes } = await say(item, {
      grocery_lists: [{
        id: 'put-away', family_id: 'fam-1', is_archived: false,
        archived_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01',
      }],
    });
    expect(listIdOf(writes)).not.toBe('put-away');
    expect(listIdOf(writes)).toBe('grocery_lists-new');
  });

  it('will not use one archived with the older is_archived column either', async () => {
    const { writes } = await say(item, {
      grocery_lists: [{ id: 'old-flag', family_id: 'fam-1', is_archived: true, archived_at: null, created_at: '2020-01-01' }],
    });
    expect(listIdOf(writes)).not.toBe('old-flag');
  });

  it('skips the archived list and takes the live one, rather than making a third', async () => {
    const { writes } = await say(item, {
      grocery_lists: [
        { id: 'put-away', family_id: 'fam-1', is_archived: false, archived_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01' },
        { id: 'current', family_id: 'fam-1', is_archived: false, archived_at: null, created_at: '2026-02-01' },
      ],
    });
    expect(listIdOf(writes)).toBe('current');
  });

  it('skips an archived to-do list, which spells it differently again', async () => {
    const { writes } = await say('remind me to renew the passports on friday', {
      todo_lists: [
        { id: 'put-away', family_id: 'fam-1', archived_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01' },
        { id: 'current', family_id: 'fam-1', archived_at: null, created_at: '2026-02-01' },
      ],
    });
    expect((writes.find((w) => w.table === 'todo_items')?.payload as Row | undefined)?.list_id).toBe('current');
  });
});

describe('the things a family actually asks a speaker about', () => {
  // A weekly event is most of a family calendar. Asked with a plain
  // `starts_at BETWEEN`, a weekly soccer practice matched once — on the
  // afternoon somebody created it — and never again.
  const weekly = {
    id: 'soccer', family_id: 'fam-1', title: 'Soccer practice',
    starts_at: '2026-08-17T20:00:00.000Z', // Monday 17 August, 16:00 New York
    ends_at: '2026-08-17T21:00:00.000Z', all_day: false,
    recurrence: 'weekly', recurrence_until: null as string | null,
  };

  it('hears a weekly event four weeks after it was created', async () => {
    const { reply } = await say("what's on today", { calendar_events: [weekly] });
    expect(reply.speech).toContain('Soccer practice');
  });

  it('speaks the occurrence’s own time, not the series start', async () => {
    const { reply } = await say("what's on today", { calendar_events: [weekly] });
    expect(reply.speech).toContain('4');
  });

  it('stops at recurrence_until', async () => {
    const { reply } = await say("what's on today", {
      calendar_events: [{ ...weekly, recurrence_until: '2026-09-01T00:00:00.000Z' }],
    });
    expect(reply.speech).not.toContain('Soccer practice');
  });

  it('does not invent an occurrence on a day the series does not fall on', async () => {
    // Monday's series, asked about on Tuesday.
    const { reply } = await say('what is happening tomorrow', { calendar_events: [weekly] });
    expect(reply.speech).not.toContain('Soccer practice');
  });

  it('still hears plain one-off events', async () => {
    const { reply } = await say("what's on today", {
      calendar_events: [{
        id: 'e1', family_id: 'fam-1', title: 'Dentist', starts_at: '2026-09-14T19:00:00.000Z',
        ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null,
      }],
    });
    expect(reply.speech).toContain('Dentist');
  });

  it('crosses midnight for "what is next" with a recurring event', async () => {
    // Tuesday's series, asked on Monday evening. "What's next" looks into
    // tomorrow, and a recurring event has to be visible there too.
    const { reply } = await say('what is next', {
      calendar_events: [{
        ...weekly, id: 'swim', title: 'Swimming',
        starts_at: '2026-08-18T12:00:00.000Z', ends_at: null,
      }],
    });
    expect(reply.speech).toContain('Swimming');
  });
});

describe('a list you can put things on is a list you can ask about', () => {
  // Bubaly could be told to put milk ON the shopping list and had no way to say
  // what was on it. Half a feature, and the missing half is the one you want
  // while standing in a shop.
  const shop = (rows: Row[]) => ({
    grocery_lists: [{ id: 'live', family_id: 'fam-1', is_archived: false, archived_at: null, created_at: '2020-01-01' }],
    grocery_items: rows.map((row) => ({
      family_id: 'fam-1', list_id: 'live', is_checked: false, created_at: '2026-01-01', ...row,
    })),
  });

  it.each([
    "what's on the shopping list",
    'what is on the grocery list',
    'read me the shopping list',
    'tell me the shopping list',
  ])('answers "%s" from the list', async (utterance) => {
    const { reply } = await say(utterance, shop([{ name: 'Milk', quantity: null }, { name: 'Eggs', quantity: null }]));
    expect(reply.intent).toBe('list:shopping');
    expect(reply.speech).toContain('Milk');
    expect(reply.speech).toContain('Eggs');
    expect(reply.speech).toContain('2 things');
  });

  it('says the quantity, because "milk" sends somebody back to the shop', async () => {
    const { reply } = await say("what's on the shopping list", shop([{ name: 'milk', quantity: '2 pints' }]));
    expect(reply.speech).toContain('2 pints milk');
  });

  it('leaves out what has already been ticked off', async () => {
    const tables = shop([{ name: 'Milk', quantity: null }, { name: 'Eggs', quantity: null, is_checked: true }]);
    const { reply } = await say("what's on the shopping list", tables);
    expect(reply.speech).toContain('Milk');
    expect(reply.speech).not.toContain('Eggs');
  });

  it('will not read back a list the family archived', async () => {
    const { reply } = await say("what's on the shopping list", {
      grocery_lists: [{ id: 'put-away', family_id: 'fam-1', is_archived: false, archived_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01' }],
      grocery_items: [{ family_id: 'fam-1', list_id: 'put-away', name: 'Milk', quantity: null, is_checked: false, created_at: '2026-01-01' }],
    });
    // Reading back a list nobody looks at is worse than saying nothing: it
    // sounds authoritative.
    expect(reply.speech).not.toContain('Milk');
    expect(reply.speech).toContain('nothing on the shopping list');
  });

  it('says so plainly when there is nothing on it', async () => {
    const { reply } = await say("what's on the shopping list", shop([]));
    expect(reply.speech).toBe('There is nothing on the shopping list.');
  });

  it('reads the to-do list too', async () => {
    const { reply } = await say("what's on my to-do list", {
      todo_items: [
        { family_id: 'fam-1', title: 'Renew the passports', is_done: false, created_at: '2026-01-01' },
        { family_id: 'fam-1', title: 'Book the boiler service', is_done: false, created_at: '2026-01-02' },
        { family_id: 'fam-1', title: 'Already done', is_done: true, created_at: '2026-01-03' },
      ],
    });
    expect(reply.intent).toBe('list:tasks');
    expect(reply.speech).toContain('Renew the passports');
    expect(reply.speech).not.toContain('Already done');
  });

  it('is still a command when it is phrased as one', async () => {
    // "add milk to the shopping list" names the list AND means put something on
    // it. The imperative guard is what keeps the read from eating the write.
    const { reply, writes } = await say('add milk to the shopping list', shop([]));
    expect(reply.outcome).toBe('captured');
    expect(writes.some((w) => w.table === 'grocery_items')).toBe(true);
  });

  it('does not turn the calendar question into a list question', async () => {
    const { reply } = await say("what's on today", {
      calendar_events: [{
        id: 'e1', family_id: 'fam-1', title: 'Dentist', starts_at: '2026-09-14T19:00:00.000Z',
        ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null,
      }],
    });
    expect(reply.intent).toBe('agenda');
    expect(reply.speech).toContain('Dentist');
  });
});
