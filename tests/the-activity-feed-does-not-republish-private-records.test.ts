import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { forgetFact, rememberFact, updateFact } from '@/lib/services/memory';
import { linkToVacation, readDocument } from '@/lib/services/documents';
import { setActivityStatus } from '@/lib/services/activity';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// #771 comment 5984161890. `agent_activity` is readable by every member
// (0127) and the agents page lists it to all of them, while the tables it
// reports on are narrower: 0264 keeps medical and account facts from anyone
// who is not a manager, and `documents_select` does the same for sensitive
// documents. The feed titles carried the very thing those rules hide —
// "Remembered Medication: Sertraline 50mg", "Opened \"Custody agreement\"" —
// so a child read it on the agents page. And any member could close any
// entry, though "done" counts toward the time Bubaly saved the household.

const FAMILY = 'fam-1';
let db: ReturnType<typeof createInMemorySupabase>;

function client(): SupabaseClient<Database> {
  return {
    from: (table: string) => db.from(table),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://files.example/signed' }, error: null }) }) },
  } as unknown as SupabaseClient<Database>;
}
// Bubaly acting for a parent: the feed records only what Bubaly does (a
// person's own changes go to the managers-only household trail instead).
const scope = (over: Partial<ServiceScope> = {}): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: 'parent-user', memberId: 'parent-member', role: 'parent',
  actorKind: 'ai', tz: 'UTC', now: new Date('2026-10-04T12:00:00Z'), ...over,
});
const child = () => scope({ userId: 'child-user', memberId: 'child-member', role: 'child', actorKind: 'member' });
const feed = () => (db.table('agent_activity') as Record<string, unknown>[]).map((r) => String(r.title));

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: {
      family_facts: { is_pinned: false, source: 'user', expires_at: null, notes: null, confidence: null },
      agent_activity: { status: 'active', kind: 'action', severity: 'info', detail: null, member_id: null },
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a memory the table hides is not named in the feed', () => {
  beforeEach(() => {
    db.seed('family_facts', [
      { id: 'fact-medical', family_id: FAMILY, member_id: null, category: 'medical', label: 'Medication', value: 'Sertraline 50mg', created_by: 'parent-user' },
      { id: 'fact-pin', family_id: FAMILY, member_id: null, category: 'other', label: 'Bank PIN', value: '4321', created_by: 'parent-user' },
    ]);
  });

  it('Bubaly pinning, editing and forgetting a medical fact for a parent never names it', async () => {
    expect((await updateFact(scope(), 'fact-medical', { pinned: true })).ok).toBe(true);
    expect((await updateFact(scope(), 'fact-medical', { value: 'Sertraline 100mg' })).ok).toBe(true);
    expect((await forgetFact(scope(), 'fact-medical', { kind: 'fact' })).ok).toBe(true);
    expect(feed()).toEqual(['Pinned a private detail', 'Updated a private detail', 'Forgot a private detail']);
    expect(feed().join(' ')).not.toMatch(/Medication|Sertraline/);
  });

  it('a fact the sensitive terms catch, in an ordinary category, is not named either', async () => {
    expect((await forgetFact(scope(), 'fact-pin', { kind: 'fact' })).ok).toBe(true);
    expect(feed()).toEqual(['Forgot a private detail']);
  });

  it('control: an ordinary fact is still announced in full', async () => {
    const res = await rememberFact(scope(), { key: 'Pickup time', content: '3:15pm', category: 'other', source: 'user' });
    expect(res.ok).toBe(true);
    expect(feed()).toEqual(['Remembered Pickup time: 3:15pm']);
  });
});

describe('a sensitive document is not named in the feed', () => {
  beforeEach(() => {
    db.seed('documents', [
      { id: 'doc-private', family_id: FAMILY, title: 'Custody agreement', category: 'legal', is_secure: true, storage_path: 'fam-1/a.pdf', member_id: null, expires_at: null },
      { id: 'doc-plain', family_id: FAMILY, title: 'Soccer schedule', category: 'school', is_secure: false, storage_path: 'fam-1/b.pdf', member_id: null, expires_at: null },
    ]);
    db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Lisbon' }]);
  });

  it('opening or attaching a private document leaves its title out', async () => {
    expect((await readDocument(scope(), 'doc-private')).ok).toBe(true);
    expect((await linkToVacation(scope(), { documentId: 'doc-private', vacationId: 'trip-1' })).ok).toBe(true);
    expect(feed()).toEqual(['Opened a private document', 'Attached a private document to Lisbon']);
  });

  it('control: an ordinary document is still named', async () => {
    expect((await readDocument(scope(), 'doc-plain')).ok).toBe(true);
    expect(feed()).toEqual(['Opened "Soccer schedule"']);
  });
});

describe('who may close a feed entry', () => {
  beforeEach(() => {
    db.seed('agent_activity', [
      { id: 'household', family_id: FAMILY, agent: 'scheduler', title: 'Planned the week', member_id: null, status: 'active' },
      { id: 'about-child', family_id: FAMILY, agent: 'tutor', title: 'Homework due', member_id: 'child-member', status: 'active' },
    ]);
  });
  const status = (id: string) => (db.table('agent_activity') as Record<string, unknown>[]).find((r) => r.id === id)?.status;

  it('a child cannot mark a household entry done', async () => {
    const res = await setActivityStatus(child(), 'household', 'done');
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(status('household')).toBe('active');
  });

  it('a child may close an entry about themselves', async () => {
    expect((await setActivityStatus(child(), 'about-child', 'dismissed')).ok).toBe(true);
    expect(status('about-child')).toBe('dismissed');
  });

  it('a parent may close any entry', async () => {
    expect((await setActivityStatus(scope(), 'household', 'done')).ok).toBe(true);
    expect((await setActivityStatus(scope(), 'about-child', 'done')).ok).toBe(true);
  });
});
