// A child cannot file away a message that arrived at the family's own number
// or address.
//
// `family_inbox_messages` gives members SELECT and nothing else (0214); every
// status change is a service-role write, so the role check in front of it is
// the whole authorization. lib/services/inbox says who that is — "Filing is a
// manager's act ... a child archiving a message about a dentist appointment
// would make it vanish from 'Needs you' without anyone having answered it" —
// and the Needs-you and Inbox actions go through it. The Contact Center's
// Mark read / Archive went straight to the service client with no role check,
// so any member, a child or a guest included, could archive any message in
// the household.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mock = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => mock.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages('en-US'), key) };
});

const { setMessageStatusAction } = await import('@/app/(app)/dashboard/contact-center/actions');

const familyId = '20000000-0000-4000-8000-0000000000f1';
const otherFamilyId = '20000000-0000-4000-8000-0000000000f2';

function contextFor(role: string) {
  return {
    user: { id: `user-${role}`, email: null },
    active: { familyId, role, member: { id: `member-${role}` }, family: { id: familyId, name: 'Family', timezone: 'UTC' } },
    memberships: [],
  };
}

let db: InMemorySupabase;
const status = (id: string) => db.table('family_inbox_messages').find((row) => row.id === id)?.status;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mock.db = db;
  db.seed('family_inbox_messages', [
    { id: 'school-note', family_id: familyId, channel: 'email', direction: 'inbound', subject: 'Detention on Friday', status: 'new' },
    { id: 'elsewhere', family_id: otherFamilyId, channel: 'sms', direction: 'inbound', body: 'Not yours', status: 'new' },
  ]);
});

describe('filing a Contact Center message', () => {
  it.each(['child', 'teen', 'guest', 'caregiver'])('is refused to a %s, and the message stays where the parents will see it', async (role) => {
    mock.ctx = contextFor(role);

    const archived = await setMessageStatusAction('school-note', 'archived');
    const read = await setMessageStatusAction('school-note', 'read');

    expect(archived.ok).toBe(false);
    expect(read.ok).toBe(false);
    expect(status('school-note')).toBe('new');
  });

  it.each(['parent', 'adult'])('is a %s\'s to do', async (role) => {
    mock.ctx = contextFor(role);

    expect(await setMessageStatusAction('school-note', 'archived')).toEqual({ ok: true });
    expect(status('school-note')).toBe('archived');
  });

  it('never reaches another household\'s message, even for a parent', async () => {
    mock.ctx = contextFor('parent');

    expect((await setMessageStatusAction('elsewhere', 'archived')).ok).toBe(false);
    expect(status('elsewhere')).toBe('new');
  });
});
