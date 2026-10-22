// "Export my family's data" says when a service's cap may have cut a section (U4).
//
// `listMemories` reads 500 facts and 200 pending suggestions, `listDocuments`
// 500 documents, and both then drop the sensitive rows for a non-manager. The
// export counted the rows AFTER that filter against the cap, so a teen's file
// with 490 of 500 facts said `truncated: false`; and the pending suggestions
// were written into the section but never counted at all, so 200 of them —
// the cap — said complete for every role. Truncation is now decided by exact
// counts of the family's rows, taken before any filter.
//
// Driven through the real export builder and the real services against an
// in-memory database.
import { describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => null }));
const { buildFamilyExport } = await import('@/lib/privacy/export');

const FAMILY = 'fam-1';
const NOW = new Date('2026-10-14T12:00:00.000Z');

function household(): InMemorySupabase {
  const db = createInMemorySupabase({ userId: 'user-parent' });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: 'teal', avatar_url: null },
    { id: 'mem-teen', family_id: FAMILY, user_id: 'user-teen', display_name: 'Sam', role: 'teen', is_active: true, birthday: '2011-04-02', color: 'amber', avatar_url: null },
  ]);
  return db;
}
const scopeFor = (db: InMemorySupabase, role: 'parent' | 'teen'): ServiceScope => ({
  db: db as unknown as ServiceScope['db'], familyId: FAMILY,
  userId: role === 'parent' ? 'user-parent' : 'user-teen', memberId: role === 'parent' ? 'mem-parent' : 'mem-teen',
  role, actorKind: 'member', tz: 'America/New_York', now: NOW,
});
const fact = (i: number, category: string) => ({
  id: `fact-${i}`, family_id: FAMILY, member_id: null, category, label: `Fact ${i}`, value: `Value ${i}`, notes: null, evidence: null,
  is_pinned: false, source: 'user', confidence: null, expires_at: null, created_by: 'user-parent', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
});
const suggestion = (i: number) => ({
  id: `sug-${i}`, family_id: FAMILY, member_id: null, category: 'preference', label: `Suggestion ${i}`, value: 'noted', notes: null, evidence: null,
  confidence: 0.8, status: 'suggested', expires_at: null, source: 'ai_inferred', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
});
const document = (i: number, secure: boolean) => ({
  id: `doc-${i}`, family_id: FAMILY, title: `Document ${i}`, category: secure ? 'identity' : 'school', mime_type: 'application/pdf', size_bytes: 10,
  expires_at: null, member_id: null, asset_id: null, is_secure: secure, storage_path: `${FAMILY}/${i}.pdf`, created_at: '2026-01-01T00:00:00.000Z',
});
async function section(db: InMemorySupabase, role: 'parent' | 'teen', key: string) {
  const built = await buildFamilyExport(scopeFor(db, role));
  expect(built.ok, built.ok ? '' : JSON.stringify(built.failed)).toBe(true);
  if (!built.ok) throw new Error('export failed');
  const found = built.data.sections.find((s) => s.key === key);
  expect(found).toBeDefined();
  return found!;
}

describe('a capped export section is honest about the cap', () => {
  it('memories, a teen: 500 facts of which 10 are hidden from them is still a capped read', async () => {
    const db = household();
    db.seed('family_facts', Array.from({ length: 500 }, (_, i) => fact(i, i < 10 ? 'medical' : 'preference')));
    const s = await section(db, 'teen', 'memories');
    expect(s.count).toBe(490);
    expect(s.truncated).toBe(true);
  });

  it('memories, any role: 200 pending suggestions is the cap, and the section says so', async () => {
    const db = household();
    db.seed('family_playbook_suggestions', Array.from({ length: 200 }, (_, i) => suggestion(i)));
    const s = await section(db, 'parent', 'memories');
    expect(s.count).toBe(0);
    expect((s.data as { pending: unknown[] }).pending).toHaveLength(200);
    expect(s.truncated).toBe(true);
  });

  it('documents, a teen: 500 documents of which 10 are the Vault\'s is still a capped read', async () => {
    const db = household();
    db.seed('documents', Array.from({ length: 500 }, (_, i) => document(i, i < 10)));
    const s = await section(db, 'teen', 'documents');
    expect(s.count).toBe(490);
    expect(s.truncated).toBe(true);
  });

  it('under every cap the sections are complete and say so', async () => {
    const db = household();
    db.seed('family_facts', Array.from({ length: 499 }, (_, i) => fact(i, i < 10 ? 'medical' : 'preference')));
    db.seed('family_playbook_suggestions', Array.from({ length: 199 }, (_, i) => suggestion(i)));
    db.seed('documents', Array.from({ length: 499 }, (_, i) => document(i, i < 10)));
    expect(await section(db, 'teen', 'memories')).toMatchObject({ count: 489, truncated: false });
    expect(await section(db, 'teen', 'documents')).toMatchObject({ count: 489, truncated: false });
    expect(await section(db, 'parent', 'memories')).toMatchObject({ count: 499, truncated: false });
  });
});
