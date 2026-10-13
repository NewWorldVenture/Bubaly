import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { generateFamilyNotifications } from '@/lib/server/notifications';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const FAMILY = 'synthetic-notification-family';
const NOW = '2026-10-13T12:00:00.000Z';
const DUE = '2026-10-13T13:00:00.000Z';
const TITLE = 'Synthetic private reminder';
let db: ReturnType<typeof createInMemorySupabase<DB>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network is admitted in recipient qualification'); }));
  db = createInMemorySupabase<DB>();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC', name: 'Synthetic family' }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, user_id: 'user-parent', role: 'parent', is_active: true, display_name: 'Synthetic Parent', birthday: null },
    { id: 'member-adult', family_id: FAMILY, user_id: 'user-adult', role: 'adult', is_active: true, display_name: 'Synthetic Adult', birthday: null },
    { id: 'member-named', family_id: FAMILY, user_id: 'user-named', role: 'teen', is_active: true, display_name: 'Synthetic Named', birthday: null },
    { id: 'member-other', family_id: FAMILY, user_id: 'user-other', role: 'teen', is_active: true, display_name: 'Synthetic Other', birthday: null },
    { id: 'member-guest', family_id: FAMILY, user_id: 'user-guest', role: 'guest', is_active: true, display_name: 'Synthetic Guest', birthday: null },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function seedReminder(table: 'reminders' | 'family_reminders', memberId: string | null, generated = false, cardId: string | null = null) {
  const row = {
    id: 'synthetic-' + table, family_id: FAMILY, title: TITLE, remind_at: DUE,
    member_id: memberId, autopilot_origin: generated, autopilot_card_id: cardId,
    is_done: false, related_type: null, related_id: null,
    status: 'active', early_reminder_minutes: 0, recurrence: 'none', snoozed_until: null,
    idempotency_key: null, tags: [],
  };
  db.seed(table, [row]);
  return row;
}
function seedInsuranceCard() {
  db.seed('autopilot_suggestions', [{
    id: 'synthetic-insurance-card', family_id: FAMILY, member_id: 'member-named',
    source_id: 'synthetic-insurance-policy', source_kind: 'family_insurance_policies',
    kind: 'insurance', action_type: 'create_reminder', title: TITLE, detail: 'Synthetic private detail',
    urgency: 1, payload: {}, created_at: NOW,
  }]);
}
const byRecipient = (left: { user_id: unknown }, right: { user_id: unknown }) =>
  left.user_id === right.user_id ? 0 : left.user_id === null ? -1 : right.user_id === null ? 1
    : String(left.user_id).localeCompare(String(right.user_id));
const notices = () => db.table('notifications').map(n => ({
  related_type: n.related_type, related_id: n.related_id, user_id: n.user_id, title: n.title,
})).sort(byRecipient);
async function expectRecipients(table: 'reminders' | 'family_reminders', users: (string | null)[], client = db as unknown as DB) {
  expect(await generateFamilyNotifications(client, FAMILY)).toBe(users.length);
  const id = 'synthetic-' + table;
  const key = table === 'family_reminders' ? 'fr:' + id : id;
  expect(notices()).toEqual(users.map(user_id => ({ related_type: table, related_id: key, user_id, title: 'Reminder: ' + TITLE })).sort(byRecipient));
  expect(fetch).not.toHaveBeenCalled();
}

describe('manual reminder notification recipients use immutable origins', () => {
  it('a manual legacy member reminder reaches its original nonmanager member', async () => {
    seedReminder('reminders', 'member-named');
    await expectRecipients('reminders', ['user-named']);
  });
  it('a manual legacy family reminder retains its family recipient', async () => {
    seedReminder('reminders', null);
    await expectRecipients('reminders', [null]);
  });
  it('a manual family-table member reminder reaches its original nonmanager member', async () => {
    seedReminder('family_reminders', 'member-named');
    await expectRecipients('family_reminders', ['user-named']);
  });
  it('a manual family-table family reminder retains its family recipient', async () => {
    seedReminder('family_reminders', null);
    await expectRecipients('family_reminders', [null]);
  });
  it('a generated legacy insurance reminder with no copied member reaches only its live card audience', async () => {
    seedInsuranceCard();
    seedReminder('reminders', null, true, 'synthetic-insurance-card');
    await expectRecipients('reminders', ['user-parent', 'user-adult', 'user-named']);
  });
  it('a generated family-table insurance reminder with no copied member reaches only its live card audience', async () => {
    seedInsuranceCard();
    seedReminder('family_reminders', null, true, 'synthetic-insurance-card');
    await expectRecipients('family_reminders', ['user-parent', 'user-adult', 'user-named']);
  });
  it('a generated reminder whose card is absent retains only manager fallback', async () => {
    seedReminder('family_reminders', null, true, 'synthetic-missing-card');
    await expectRecipients('family_reminders', ['user-parent', 'user-adult']);
  });
  it('a generated reminder card read failure never becomes a family or other member notice', async () => {
    seedInsuranceCard();
    seedReminder('reminders', null, true, 'synthetic-insurance-card');
    const client = withFaults(db, table => table === 'autopilot_suggestions'
      ? { code: '08006', message: 'Synthetic card read failure' } : null);
    await expectRecipients('reminders', ['user-parent', 'user-adult'], client as unknown as DB);
    expect(console.error).toHaveBeenCalled();
  });
});

// Trusted manual recipients must survive an unrelated card-table outage.
describe('manual reminder notification card-read availability', () => {
  it('a manual legacy member notice keeps its recipient during a card read failure', async () => {
    seedReminder('reminders', 'member-named');
    let cardReads = 0;
    const client = withFaults(db, table => {
      if (table !== 'autopilot_suggestions') return null;
      cardReads += 1;
      return { code: '08006', message: 'Synthetic unrelated card read failure' };
    });
    await expectRecipients('reminders', ['user-named'], client as unknown as DB);
    expect(cardReads).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });
  it('a manual family-table member notice keeps its recipient during a card read failure', async () => {
    seedReminder('family_reminders', 'member-named');
    let cardReads = 0;
    const client = withFaults(db, table => {
      if (table !== 'autopilot_suggestions') return null;
      cardReads += 1;
      return { code: '08006', message: 'Synthetic unrelated card read failure' };
    });
    await expectRecipients('family_reminders', ['user-named'], client as unknown as DB);
    expect(cardReads).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });
});
