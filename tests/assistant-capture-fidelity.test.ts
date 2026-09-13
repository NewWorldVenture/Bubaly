import { describe, expect, it } from 'vitest';
import { classifyAssistantUtterance, captureSpeech } from '@/lib/assistant/intent';
import { classifyVoiceCommand } from '@/lib/voice/command-router';
import { answerAssistant, type AssistantLink } from '@/lib/assistant/service';

// What a speaker in the kitchen actually does with what it hears.
//
// Every case here was wrong before. Read together they are one defect: the
// utterance was classified, and then everything the classification had worked
// out — which day, which time, which words were the command rather than the
// thing — was dropped on the floor before anything reached the database.

const NY = 'America/New_York';
// A server ticking in UTC. 21:30 UTC on Friday is 17:30 Friday in New York and
// already 06:30 SATURDAY in Tokyo, which is the whole point of the day-boundary
// case below.
const NOW = new Date('2026-09-18T21:30:00Z');

describe('a command is a command, even when it contains a question word', () => {
  // Each of these matched a question matcher and was answered instead of saved.
  // To the person that is Bubaly ignoring them.
  it.each([
    ['schedule the school play on tuesday', 'event'],
    ['remind me to help with the homework', 'task'],
    ['remind me not to forget the passports on friday', 'task'],
    ['add soccer practice tomorrow at 4pm', 'event'],
  ])('%s is captured as a %s', (utterance, kind) => {
    const intent = classifyAssistantUtterance(utterance, NOW, NY);
    expect(intent.kind).toBe('capture');
    if (intent.kind !== 'capture') return;
    expect(intent.route.kind).toBe(kind);
  });

  it.each([
    "what's on today", 'what is happening tomorrow', 'what are my plans today',
    'read me my agenda', 'what does my schedule look like',
  ])('but %s is still a question', (utterance) => {
    expect(classifyAssistantUtterance(utterance, NOW, NY).kind).toBe('agenda');
  });

  it('still hears "what am i forgetting" and "what is next"', () => {
    expect(classifyAssistantUtterance('what am i forgetting', NOW, NY).kind).toBe('forgetting');
    expect(classifyAssistantUtterance('what is next', NOW, NY).kind).toBe('next');
  });
});

describe('the command words are not part of what you asked for', () => {
  it.each([
    ['remind me to call the dentist tomorrow', 'Call the dentist'],
    ['remind me not to forget the passports on friday', 'The passports'],
    ['add soccer practice tomorrow at 4pm', 'Soccer practice'],
    ['schedule the school play on tuesday', 'The school play'],
    ['add milk to the shopping list', 'Milk'],
  ])('%s is titled %s', (utterance, title) => {
    const route = classifyVoiceCommand(utterance, NOW, NY);
    expect(route.text).toBe(title);
  });

  it('asks rather than naming an event after its own date', () => {
    // "it" refers to something Bubaly never heard. An event called
    // "Tomorrow at 6pm" is the command talking back at the person.
    expect(classifyAssistantUtterance('put it on the calendar tomorrow at 6pm', NOW, NY).kind).toBe('unknown');
  });
});

describe('the time you said is the time that is saved', () => {
  it('resolves 4pm in the family zone, not the server zone', () => {
    const route = classifyVoiceCommand('add soccer practice tomorrow at 4pm', NOW, NY);
    expect(route.startsAt).not.toBeNull();
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(route.startsAt as Date);
    expect(local).toBe('16:00');
    // 16:00 in New York in September is 20:00 UTC — NOT the 16:00 UTC the old
    // code produced, which is noon for this family.
    expect((route.startsAt as Date).toISOString()).toBe('2026-09-19T20:00:00.000Z');
  });

  it('gives every zone its own 4pm', () => {
    for (const zone of ['UTC', NY, 'Asia/Tokyo', 'Australia/Sydney']) {
      const route = classifyVoiceCommand('add soccer practice tomorrow at 4pm', NOW, zone);
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false })
        .format(route.startsAt as Date);
      expect(local, `4pm in ${zone}`).toBe('16:00');
    }
  });

  it('reads "tomorrow" from the family calendar, not the server one', () => {
    // At this instant it is still Friday in New York but already Saturday in
    // Tokyo, so "tomorrow" is a different date for each of them.
    const ny = classifyVoiceCommand('add soccer practice tomorrow at 4pm', NOW, NY).startsAt as Date;
    const tokyo = classifyVoiceCommand('add soccer practice tomorrow at 4pm', NOW, 'Asia/Tokyo').startsAt as Date;
    const dayIn = (d: Date, zone: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' }).format(d);
    expect(dayIn(ny, NY)).toBe('2026-09-19');
    expect(dayIn(tokyo, 'Asia/Tokyo')).toBe('2026-09-20');
  });

  it('moves an appointment to the first minute that exists on the spring-forward morning', () => {
    // New York jumps 02:00 -> 03:00 on 8 March 2026, so 02:30 never happens.
    const eve = new Date('2026-03-07T18:00:00Z');
    const route = classifyVoiceCommand('add furnace service tomorrow at 2:30am', eve, NY);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: NY, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(route.startsAt as Date);
    expect(local).toBe('03:00');
  });

  it('gives a spoken reminder its due date', () => {
    expect(classifyVoiceCommand('remind me to renew the passports tomorrow', NOW, NY).dueDate).toBe('2026-09-19');
    expect(classifyVoiceCommand('remind me to call the dentist', NOW, NY).dueDate).toBeNull();
  });

  it('leaves the browser path alone when no zone is given', () => {
    // /dashboard/capture and /dashboard/voice run in the browser, where
    // runtime-local already IS the person's clock. Passing no zone must keep
    // exactly the old behaviour.
    const route = classifyVoiceCommand('add soccer practice tomorrow at 4pm', NOW);
    expect(route.startsAt?.getHours()).toBe(16);
  });
});

describe('what Bubaly says back', () => {
  it('repeats the time, because there is no screen to check it on', () => {
    const intent = classifyAssistantUtterance('add soccer practice tomorrow at 4pm', NOW, NY);
    if (intent.kind !== 'capture') throw new Error('expected a capture');
    expect(captureSpeech(intent.route, NY, NOW)).toBe('Added Soccer practice to the calendar for Saturday at 4pm.');
  });

  it('repeats a due date too', () => {
    const intent = classifyAssistantUtterance('remind me to renew the passports tomorrow', NOW, NY);
    if (intent.kind !== 'capture') throw new Error('expected a capture');
    expect(captureSpeech(intent.route, NY, NOW)).toBe('Added a task: Renew the passports, due Saturday.');
  });

  it('says nothing about a time when none was given', () => {
    const intent = classifyAssistantUtterance('add milk to the shopping list', NOW, NY);
    if (intent.kind !== 'capture') throw new Error('expected a capture');
    expect(captureSpeech(intent.route, NY, NOW)).toBe('Added Milk to the shopping list.');
  });
});

// ---------------------------------------------------------------------------
// The write itself. Everything above is worthless if the row does not carry it.
// ---------------------------------------------------------------------------

type Write = { table: string; payload: Record<string, unknown> };

function fakeDb(writes: Write[]) {
  const builder = (table: string): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      // ensureList's "does a list already exist?" — say no, so it creates one.
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: `${table}-1` }, error: null }),
      insert: (payload: Record<string, unknown>) => {
        writes.push({ table, payload });
        const inserted: Record<string, unknown> = {
          select: () => inserted,
          single: async () => ({ data: { id: `${table}-1` }, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return inserted;
      },
    };
    return chain;
  };
  return { from: (table: string) => builder(table) } as never;
}

const link: AssistantLink = {
  id: 'link-1', family_id: 'fam-1', user_id: 'user-1',
  provider: 'alexa', scopes: ['ask', 'capture'], timezone: NY,
};

async function capture(utterance: string): Promise<Write[]> {
  const writes: Write[] = [];
  const intent = classifyAssistantUtterance(utterance, NOW, link.timezone);
  await answerAssistant(fakeDb(writes), link, intent, NOW);
  return writes;
}

describe('the row that reaches the database', () => {
  it('puts the event at the time that was said, not the time it was said', async () => {
    const writes = await capture('add soccer practice tomorrow at 4pm');
    const event = writes.find((w) => w.table === 'calendar_events');
    expect(event, 'an event should have been written').toBeTruthy();
    // The bug: starts_at was `now` unconditionally, so soccer practice landed
    // in the calendar at the moment somebody mentioned it.
    expect(event?.payload.starts_at).toBe('2026-09-19T20:00:00.000Z');
    expect(event?.payload.starts_at).not.toBe(NOW.toISOString());
    expect(event?.payload.title).toBe('Soccer practice');
    expect(event?.payload.all_day).toBe(false);
  });

  it('marks a day without a clock time as all-day', async () => {
    const writes = await capture('schedule the school play on tuesday');
    const event = writes.find((w) => w.table === 'calendar_events');
    expect(event?.payload.all_day).toBe(true);
    expect(event?.payload.title).toBe('The school play');
  });

  it('gives the task the due date that was spoken', async () => {
    const writes = await capture('remind me to renew the passports tomorrow');
    const task = writes.find((w) => w.table === 'todo_items');
    expect(task?.payload.title).toBe('Renew the passports');
    expect(task?.payload.due_date).toBe('2026-09-19');
  });

  it('leaves due_date off a task with no day, rather than inventing one', async () => {
    const writes = await capture('remind me to call the dentist');
    const task = writes.find((w) => w.table === 'todo_items');
    expect(task?.payload.title).toBe('Call the dentist');
    expect(task?.payload).not.toHaveProperty('due_date');
  });

  it('still routes a shopping item to a grocery list', async () => {
    const writes = await capture('add milk to the shopping list');
    const rows = writes.find((w) => w.table === 'grocery_items')?.payload as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Milk', family_id: 'fam-1' });
    expect(rows[0].list_id, 'a list is created when the family has none').toBeTruthy();
  });

  it('adds three things when three things were said', async () => {
    // One line reading "Milk, eggs and bread" is not a shopping list — you
    // cannot tick off the eggs.
    const writes = await capture('add milk, eggs and bread to the shopping list');
    const rows = writes.find((w) => w.table === 'grocery_items')?.payload as unknown as Record<string, unknown>[];
    expect(rows.map((r) => r.name)).toEqual(['Milk', 'eggs', 'bread']);
  });

  it('keeps a spoken count as a quantity', async () => {
    const writes = await capture('add 2 pints of milk, 12 eggs to the shopping list');
    const rows = writes.find((w) => w.table === 'grocery_items')?.payload as unknown as Record<string, unknown>[];
    expect(rows).toEqual([
      expect.objectContaining({ name: 'pints of milk', quantity: '2' }),
      expect.objectContaining({ name: 'eggs', quantity: '12' }),
    ]);
  });

  it('does not split a dish that has "and" in its name', async () => {
    // No comma, so "and" is part of the thing rather than a separator.
    const writes = await capture('add macaroni and cheese to the shopping list');
    const rows = writes.find((w) => w.table === 'grocery_items')?.payload as unknown as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Macaroni and cheese');
  });
});
