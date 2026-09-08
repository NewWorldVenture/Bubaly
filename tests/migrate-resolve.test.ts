// M29 — an import proposes who each item belongs to, and says what is already
// here, BEFORE anything is written.
//
// Two halves. The first pins the pure resolution (`lib/migrate/resolve.ts`):
// whole-token name matching, category inference, and duplicate detection
// against existing rows and within one import. The second drives the real
// server actions against an in-memory Postgres, because the proposal is only
// worth anything if the commit honours it — the member the reviewer chose has
// to reach `assignee_id`/`linked_member_id`, and a skipped duplicate has to
// stay out of the table.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import {
  eventKey, inferEventCategory, matchMember, nameTokens, resolveImportedItems,
} from '@/lib/migrate/resolve';

const MEMBERS = [
  { id: 'm-emma', displayName: 'Emma' },
  { id: 'm-liam', displayName: 'Liam' },
  { id: 'm-zoe', displayName: 'Zoë Mara' },
];

const event = (title: string, startsAt: string, description: string | null = null) => ({
  title, startsAt, endsAt: null, allDay: false, location: null, description,
});

describe('nameTokens', () => {
  it('folds accents and splits on punctuation', () => {
    expect(nameTokens("Zoë's dentist")).toEqual(['zoe', 'dentist']);
    expect(nameTokens('Emma/Liam swim')).toEqual(['emma', 'liam', 'swim']);
  });

  it('drops one-letter fragments that cannot identify anyone', () => {
    expect(nameTokens('A B Emma')).toEqual(['emma']);
  });
});

describe('matchMember', () => {
  it('assigns an event to the member named in it', () => {
    expect(matchMember('Emma — dentist', MEMBERS)?.id).toBe('m-emma');
  });

  it('reads a possessive as the name', () => {
    expect(matchMember("Liam's football practice", MEMBERS)?.id).toBe('m-liam');
  });

  it('matches an accented name written without its accent', () => {
    expect(matchMember('Zoe piano lesson', MEMBERS)?.id).toBe('m-zoe');
  });

  it('takes the name that appears first when several members are mentioned', () => {
    expect(matchMember('Emma and Liam to the dentist', MEMBERS)?.id).toBe('m-emma');
    expect(matchMember('Liam and Emma to the dentist', MEMBERS)?.id).toBe('m-liam');
  });

  it('does not match a name that is only a substring of another word', () => {
    expect(matchMember('Emmanuel College open day', MEMBERS)).toBeNull();
    expect(matchMember('Team liaison meeting', MEMBERS)).toBeNull();
  });

  it('returns null when nobody is named, and when there are no members', () => {
    expect(matchMember('Bin day', MEMBERS)).toBeNull();
    expect(matchMember('Emma — dentist', [])).toBeNull();
  });
});

describe('inferEventCategory', () => {
  it('reads the obvious kinds off the title', () => {
    expect(inferEventCategory('Dentist appointment')).toBe('appointment');
    expect(inferEventCategory('Soccer practice')).toBe('sports');
    expect(inferEventCategory('Parent teacher evening')).toBe('school');
    expect(inferEventCategory("Emma's birthday")).toBe('birthday');
  });

  it('falls back to general rather than guessing', () => {
    expect(inferEventCategory('Dinner with the Ryans')).toBe('general');
    expect(inferEventCategory('')).toBe('general');
  });
});

describe('eventKey', () => {
  it('treats two spellings of the same instant and title as one event', () => {
    expect(eventKey('Soccer Practice', '2024-05-14T17:30:00+00:00'))
      .toBe(eventKey('  soccer practice ', '2024-05-14T17:30:00.000Z'));
  });

  it('keeps different starts apart', () => {
    expect(eventKey('Soccer', '2024-05-14T17:30:00Z')).not.toBe(eventKey('Soccer', '2024-05-15T17:30:00Z'));
  });
});

describe('resolveImportedItems', () => {
  it('proposes a member and a category per event', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      events: [event('Emma — dentist', '2024-05-14T09:00:00.000Z'), event('Bin day', '2024-05-15T07:00:00.000Z')],
    });
    expect(plan.events[0]).toMatchObject({ memberId: 'm-emma', memberName: 'Emma', category: 'appointment', duplicate: false });
    expect(plan.events[1]).toMatchObject({ memberId: null, category: 'general' });
    expect(plan.assignedEvents).toBe(1);
  });

  it('reads a member out of the event description too', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      events: [event('Swimming', '2024-05-14T09:00:00.000Z', 'Liam needs his goggles')],
    });
    expect(plan.events[0].memberId).toBe('m-liam');
  });

  it('flags an event the family already has', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      events: [event('Soccer Practice', '2024-05-14T17:30:00.000Z')],
      existingEvents: [{ title: 'soccer practice', startsAt: '2024-05-14T17:30:00+00:00' }],
    });
    expect(plan.events[0].duplicate).toBe(true);
    expect(plan.duplicateEvents).toBe(1);
  });

  it('flags the SECOND copy inside one import, not the first', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      events: [event('Swim', '2024-05-14T17:30:00.000Z'), event('Swim', '2024-05-14T17:30:00.000Z')],
    });
    expect(plan.events.map((e) => e.duplicate)).toEqual([false, true]);
  });

  it('proposes a member for a task from its name or its extra text', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      tasks: [{ name: 'Emma: tidy room' }, { name: 'Take the bins out', extra: 'Liam does this' }, { name: 'Hoover' }],
    });
    expect(plan.tasks.map((t) => t.memberId)).toEqual(['m-emma', 'm-liam', null]);
    expect(plan.assignedTasks).toBe(2);
  });

  it('flags a contact the family already holds, matching on email or phone', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      contacts: [
        { name: 'Grandma Rose', emails: ['ROSE@example.com'], phones: [], organization: null, notes: null },
        { name: 'Coach Dani', emails: [], phones: ['+1 555 010 9999'], organization: null, notes: null },
        { name: 'New Neighbour', emails: ['new@example.com'], phones: [], organization: null, notes: null },
      ],
      existingContacts: [
        { name: 'Rose', email: 'rose@example.com', phone: null },
        { name: 'Dani Alvarez', email: null, phone: '(555) 010-9999' },
      ],
    });
    expect(plan.contacts.map((c) => c.duplicate)).toEqual([true, true, false]);
    expect(plan.duplicateContacts).toBe(2);
  });

  it('matches a contact with no email or phone by exact name only', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      contacts: [{ name: 'Babysitter', emails: [], phones: [], organization: null, notes: null }],
      existingContacts: [{ name: 'babysitter', email: null, phone: null }],
    });
    expect(plan.contacts[0].duplicate).toBe(true);
  });

  it('links a contact to the member it is named after', () => {
    const plan = resolveImportedItems({
      members: MEMBERS,
      contacts: [{ name: 'Emma School Office', emails: [], phones: ['5550101111'], organization: null, notes: null }],
    });
    expect(plan.contacts[0].memberId).toBe('m-emma');
    expect(plan.assignedContacts).toBe(1);
  });

  it('never proposes a member the caller did not list', () => {
    const plan = resolveImportedItems({
      members: [{ id: 'm-emma', displayName: '   ' }],
      events: [event('Emma — dentist', '2024-05-14T09:00:00.000Z')],
    });
    expect(plan.events[0].memberId).toBeNull();
  });

  it('is empty for an empty import', () => {
    const plan = resolveImportedItems({ members: MEMBERS });
    expect(plan).toMatchObject({ events: [], tasks: [], contacts: [], duplicateEvents: 0, duplicateContacts: 0 });
  });
});

// ── The commit honours the review ────────────────────────────────────────────

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { commitImport, prepareImport } from '@/app/(app)/dashboard/migrate/actions';

const FAMILY = 'family-1';
const USER = 'user-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

/**
 * Make every query against one table answer like a transport failure. The
 * in-memory client has no fault injection of its own, and "the read failed"
 * is exactly the case these actions have to get right, so the builder is
 * swapped for a chainable stub that resolves to a PostgREST error.
 */
function failReadsOn(table: string) {
  const original = db.from.bind(db) as (name: string) => unknown;
  const failing: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown) =>
          resolve({ data: null, error: { code: '08006', message: 'connection failed', details: null, hint: null }, count: null });
      }
      return () => failing;
    },
  });
  vi.spyOn(db, 'from').mockImplementation(((name: string) => (name === table ? failing : original(name))) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: { assignee_id: null, ends_at: null, all_day: false, category: 'general', description: null, location: null },
      family_contacts: { email: null, phone: null, phone_alt: null, organization: null, notes: null, linked_member_id: null },
      chore_assignments: { status: 'todo' },
    },
  });
  db.seed('family_members', [
    { id: 'm-emma', family_id: FAMILY, display_name: 'Emma', is_active: true },
    { id: 'm-liam', family_id: FAMILY, display_name: 'Liam', is_active: true },
    { id: 'm-other', family_id: 'family-2', display_name: 'Outsider', is_active: true },
  ]);
  mocks.requireUserContext.mockResolvedValue({ user: { id: USER }, active: { familyId: FAMILY } });
  mocks.createServer.mockResolvedValue(db);
});

describe('prepareImport', () => {
  it('resolves against the signed-in family only', async () => {
    db.seed('calendar_events', [{ id: 'e-1', family_id: FAMILY, title: 'Soccer Practice', starts_at: '2024-05-14T17:30:00.000Z' }]);
    const res = await prepareImport({
      source: 'cozi',
      events: [event('Soccer Practice', '2024-05-14T17:30:00.000Z'), event('Emma — dentist', '2024-05-20T09:00:00.000Z')],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.members.map((m) => m.id)).toEqual(['m-emma', 'm-liam']);
    expect(res.plan.events[0].duplicate).toBe(true);
    expect(res.plan.events[1].memberId).toBe('m-emma');
  });

  it('fails closed when the calendar cannot be read', async () => {
    failReadsOn('calendar_events');
    const res = await prepareImport({ source: 'cozi', events: [event('Soccer', '2024-05-14T17:30:00.000Z')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.retryable).toBe(true);
  });
});

describe('commitImport', () => {
  it('writes the reviewer’s member onto the event and infers its category', async () => {
    const res = await commitImport({
      source: 'cozi',
      events: [{ ...event('Dentist', '2024-05-20T09:00:00.000Z'), memberId: 'm-emma', category: 'appointment' }],
    });
    expect(res.ok).toBe(true);
    const [row] = db.table('calendar_events');
    expect(row).toMatchObject({ family_id: FAMILY, assignee_id: 'm-emma', category: 'appointment' });
    if (res.ok) expect(res.assigned).toBe(1);
  });

  it('refuses a member id from another family', async () => {
    await commitImport({
      source: 'cozi',
      events: [{ ...event('Dentist', '2024-05-20T09:00:00.000Z'), memberId: 'm-other' }],
    });
    expect(db.table('calendar_events')[0].assignee_id).toBeNull();
  });

  it('leaves out an event the reviewer skipped', async () => {
    const res = await commitImport({
      source: 'cozi',
      events: [
        { ...event('Keep me', '2024-05-20T09:00:00.000Z') },
        { ...event('Skip me', '2024-05-21T09:00:00.000Z'), skip: true },
      ],
    });
    expect(db.table('calendar_events').map((r) => r.title)).toEqual(['Keep me']);
    if (res.ok) expect(res.counts.events).toBe(1);
  });

  it('skips an event the family already has, whatever case the export used', async () => {
    // The instant is written the same way here because the fake compares
    // timestamps as text where Postgres compares them as instants; that the
    // KEY tolerates both spellings is pinned in the `eventKey` cases above.
    db.seed('calendar_events', [{ id: 'e-1', family_id: FAMILY, title: 'Soccer Practice', starts_at: '2024-05-14T17:30:00.000Z' }]);
    const res = await commitImport({ source: 'cozi', events: [event('soccer practice', '2024-05-14T17:30:00.000Z')] });
    expect(db.table('calendar_events')).toHaveLength(1);
    if (res.ok) expect(res.skipped).toBe(1);
  });

  it('writes contacts with the linked member, and de-dupes on phone', async () => {
    db.seed('family_contacts', [{ id: 'c-1', family_id: FAMILY, name: 'Rose', phone: '(555) 010-1234' }]);
    const res = await commitImport({
      source: 'cozi',
      contacts: [
        { name: 'Grandma Rose', emails: [], phones: ['+1 555 010 1234'] },
        { name: 'Emma School Office', emails: ['office@school.example'], phones: [], memberId: 'm-emma' },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.counts.contacts).toBe(1);
    expect(res.skipped).toBe(1);
    const added = db.table('family_contacts').find((r) => r.name === 'Emma School Office');
    expect(added).toMatchObject({ linked_member_id: 'm-emma', email: 'office@school.example', family_id: FAMILY });
  });

  it('assigns an imported task to the reviewed member', async () => {
    await commitImport({
      source: 'ourhome',
      tasks: [{ name: 'Tidy room', memberId: 'm-liam' }, { name: 'Hoover' }],
    });
    const chores = db.table('chores');
    expect(chores).toHaveLength(2);
    const assignments = db.table('chore_assignments');
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ member_id: 'm-liam', family_id: FAMILY });
    expect(assignments[0].chore_id).toBe(chores.find((c) => c.title === 'Tidy room')!.id);
  });

  it('records the import in audit_logs with what it did', async () => {
    await commitImport({
      source: 'cozi',
      events: [{ ...event('Dentist', '2024-05-20T09:00:00.000Z'), memberId: 'm-emma' }],
      contacts: [{ name: 'Coach Dani', emails: ['dani@soccer.example'], phones: [] }],
    });
    const [log] = db.table('audit_logs');
    expect(log).toMatchObject({ family_id: FAMILY, actor_id: USER, action: 'import', resource: 'migration' });
    expect(log.metadata).toMatchObject({ source: 'cozi', assigned: 1 });
  });

  it('fails closed rather than importing a second copy when the duplicate check cannot run', async () => {
    failReadsOn('family_contacts');
    const res = await commitImport({ source: 'cozi', contacts: [{ name: 'Coach Dani', emails: ['dani@soccer.example'], phones: [] }] });
    expect(res.ok).toBe(false);
    expect(db.table('family_contacts')).toHaveLength(0);
  });
});
