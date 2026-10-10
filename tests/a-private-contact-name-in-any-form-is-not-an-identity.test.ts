import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';
import { resolveInboundEntityContext } from '@/lib/graph/resolve-server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A PRIVATE CONTACT NAME, IN ANY FORM, IS NOT A HOUSEHOLD IDENTITY (AI-001).
 *
 * Inbound mail is matched against the family's confirmed contacts, and a
 * contact whose name says health or money (`PRIVATE_NAME` in
 * lib/graph/resolve-server.ts) is never used: that match would label a
 * letter with who the family's psychiatrist or bank is. The word list matched
 * whole words in the singular, with one stem — `psychiatr` — that matched
 * nothing, so "Northside Psychiatry" and "Chase accounts" were identities.
 */
const NOW = new Date('2026-09-09T12:00:00Z');
const FAMILY = 'ours';
let db: ReturnType<typeof createInMemorySupabase>;
const scope = (): ServiceScope => ({ db: db as never, familyId: FAMILY, role: 'system', actorKind: 'system', userId: null, memberId: null, tz: 'UTC', now: NOW });
const contact = (id: string, label: string, value: string) => ({
  id, family_id: FAMILY, label, value, category: 'contact', source: 'user', expires_at: null,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
});
afterEach(() => vi.restoreAllMocks());

describe('confirmed contacts with a private name are not matched', () => {
  it.each([
    ['Northside Psychiatry', 'office@northside.example'],
    ['Chase accounts', 'alerts@chase.example'],
    ['Lakeside Clinics', 'front@lakeside.example'],
    ['Valley Pediatricians', 'desk@valley.example'],
  ])('%s', async (label, mailbox) => {
    db.seed('family_facts', [contact('private', label, mailbox)]);
    const byName = await resolveInboundEntityContext(scope(), { text: `A letter from ${label}` });
    expect(byName.ok && byName.data.matches).toEqual([]);
    const bySender = await resolveInboundEntityContext(scope(), { text: 'Please read', sender: mailbox });
    expect(bySender.ok && bySender.data.matches).toEqual([]);
  });

  it('control: an ordinary confirmed contact is still matched', async () => {
    db.seed('family_facts', [contact('coach', 'Coach Casey', 'coach@example.com')]);
    const result = await resolveInboundEntityContext(scope(), { text: 'Please read', sender: 'coach@example.com' });
    expect(result.ok && result.data.matches[0]).toMatchObject({ label: 'Coach Casey', matchedBy: 'sender' });
  });
});
