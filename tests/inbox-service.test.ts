// lib/services/inbox: the write behind the "Archive" decision on a "Needs you"
// message card. `family_inbox_messages` has no client write policy, so the
// service runs on the service client — which is exactly why its family filter
// and its role check have to be proven rather than assumed.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { archiveInboxMessage, setInboxMessageStatus } from '@/lib/services/inbox';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

function household() {
  const db = createInMemorySupabase();
  db.seed('family_inbox_messages', [
    { id: 'msg-ours', family_id: 'fam-1', channel: 'sms', direction: 'inbound', ai_intent: 'appointment', status: 'new', body: 'Thursday?' },
    { id: 'msg-theirs', family_id: 'fam-2', channel: 'sms', direction: 'inbound', ai_intent: 'personal', status: 'new', body: 'Hi' },
  ]);
  const scope = (role: ServiceScope['role']): ServiceScope => ({
    db: db as unknown as SupabaseClient<Database>, familyId: 'fam-1', userId: 'user-1', memberId: 'member-1',
    role, actorKind: role === 'system' ? 'system' : 'member', tz: 'UTC',
  });
  const status = (id: string) => db.table('family_inbox_messages').find((r) => r.id === id)?.status;
  return { db, scope, status };
}

describe('archiveInboxMessage', () => {
  it('archives the family’s own message and reports the new status', async () => {
    const { scope, status } = household();
    const res = await archiveInboxMessage(scope('parent'), 'msg-ours');
    expect(res).toEqual({ ok: true, data: { id: 'msg-ours', status: 'archived' } });
    expect(status('msg-ours')).toBe('archived');
    expect(status('msg-theirs')).toBe('new');
  });

  it('never reaches another family’s message, even on the service client: not found, and nothing changes', async () => {
    const { scope, status } = household();
    const res = await archiveInboxMessage(scope('parent'), 'msg-theirs');
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(status('msg-theirs')).toBe('new');
  });

  it('refuses a child, teen or guest, and allows an adult or the system', async () => {
    const { scope, status } = household();
    for (const role of ['child', 'teen', 'guest', 'caregiver'] as const) {
      expect(await archiveInboxMessage(scope(role), 'msg-ours'), role).toMatchObject({ ok: false, code: 'denied' });
    }
    expect(status('msg-ours')).toBe('new');
    expect((await setInboxMessageStatus(scope('adult'), 'msg-ours', 'read')).ok).toBe(true);
    expect(status('msg-ours')).toBe('read');
    expect((await setInboxMessageStatus(scope('system'), 'msg-ours', 'archived')).ok).toBe(true);
    expect(status('msg-ours')).toBe('archived');
  });

  it('rejects a blank id before touching the database', async () => {
    const { db, scope } = household();
    expect(await archiveInboxMessage(scope('parent'), '  ')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(db.log).toEqual([]);
  });

  it('surfaces a database failure as a service error and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          update: () => chain, eq: () => chain, select: () => chain,
          maybeSingle: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
        });
        return chain;
      },
    } as unknown as SupabaseClient<Database>;
    const res = await archiveInboxMessage({ db: failing, familyId: 'fam-1', userId: 'u', memberId: 'm', role: 'parent', actorKind: 'member', tz: 'UTC' }, 'msg-ours');
    expect(res).toMatchObject({ ok: false, code: 'db' });
    expect(err).toHaveBeenCalledWith('[service:inbox] message status update failed', expect.objectContaining({ code: '42501' }));
    err.mockRestore();
  });
});
