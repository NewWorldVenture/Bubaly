// Documents: listings carry metadata only and hide sensitive rows from
// non-managers; `readDocument` hands out a short signed URL and refuses
// sensitive files to anyone but a parent/adult; linking to a trip is
// family-checked on both sides and idempotent.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { expiringBefore, inferDocKind, isSensitiveDocument, linkToVacation, listDocuments, readDocument } from '@/lib/services/documents';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply, storage?: { url?: string | null; error?: unknown }) {
  const calls: Call[] = [];
  const signed: { path: string; ttl: number }[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter, in: filter,
      ilike: (c: string, v: unknown) => filter(`ilike:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      not: (c: string, op: string, v: unknown) => filter(`not:${c}:${op}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  const db = {
    from,
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, ttl: number) => {
          signed.push({ path: `${bucket}:${path}`, ttl });
          return Promise.resolve(storage?.error ? { data: null, error: storage.error } : { data: { signedUrl: storage?.url ?? 'https://signed.example/x' }, error: null });
        },
      }),
    },
  } as unknown as SupabaseClient<Database>;
  return { db, calls, signed };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

const doc = (over: Partial<{ id: string; title: string; category: string | null; is_secure: boolean; expires_at: string | null; member_id: string | null }>) => ({
  id: over.id ?? 'd-1', family_id: 'fam-1', title: over.title ?? 'School calendar', category: over.category ?? 'school', storage_path: `fam-1/general/${over.id ?? 'd-1'}.pdf`,
  mime_type: 'application/pdf', size_bytes: 1024, expires_at: over.expires_at ?? null, member_id: over.member_id ?? null, asset_id: null,
  is_favorite: false, is_secure: over.is_secure ?? false, created_by: 'auth-1', created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
});

describe('sensitivity', () => {
  it('treats vault documents and private categories as sensitive', () => {
    expect(isSensitiveDocument({ is_secure: true, category: 'school' })).toBe(true);
    expect(isSensitiveDocument({ is_secure: false, category: 'Medical' })).toBe(true);
    expect(isSensitiveDocument({ is_secure: false, category: 'passport' })).toBe(true);
    expect(isSensitiveDocument({ is_secure: false, category: 'school' })).toBe(false);
    expect(isSensitiveDocument({ is_secure: false, category: null })).toBe(false);
  });

  it('infers a travel-document kind from category and title', () => {
    expect(inferDocKind({ category: 'passport', title: 'Ava' })).toBe('passport');
    expect(inferDocKind({ category: null, title: 'Delta boarding pass' })).toBe('boarding_pass');
    expect(inferDocKind({ category: 'travel', title: 'Hotel confirmation' })).toBe('hotel_confirmation');
    expect(inferDocKind({ category: 'misc', title: 'Recipe' })).toBe('other');
  });
});

describe('listDocuments / expiringBefore', () => {
  const rows = [doc({ id: 'd-1' }), doc({ id: 'd-2', title: 'Will', category: 'legal' }), doc({ id: 'd-3', title: 'Vault thing', is_secure: true })];

  it('returns metadata only, family-scoped, with every row for a parent', async () => {
    const { db, calls } = makeDb(() => ({ data: rows, error: null }));
    const res = await listDocuments(scopeWith(db));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((d) => d.id)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(res.data[1].sensitive).toBe(true);
    expect(Object.keys(res.data[0])).not.toContain('storage_path');
    expect(calls[0].filters.family_id).toBe('fam-1');
  });

  it('hides sensitive rows entirely from a teen or child', async () => {
    const { db } = makeDb(() => ({ data: rows, error: null }));
    const teen = await listDocuments(scopeWith(db, { role: 'teen' }));
    expect(teen.ok && teen.data.map((d) => d.id)).toEqual(['d-1']);
    const child = await expiringBefore(scopeWith(db, { role: 'child' }), '2026-12-31');
    expect(child.ok && child.data.map((d) => d.id)).toEqual(['d-1']);
  });

  it('queries expiry with a bound and includes already-expired documents', async () => {
    const { db, calls } = makeDb(() => ({ data: [doc({ id: 'old', expires_at: '2026-08-01' })], error: null }));
    const res = await expiringBefore(scopeWith(db), '2026-10-01');
    expect(res.ok && res.data[0].id).toBe('old');
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', 'not:expires_at:is': null, 'lte:expires_at': '2026-10-01' });
  });

  it('rejects a malformed date and fails closed on a database error', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: { message: 'boom' } }));
    expect(await expiringBefore(scopeWith(db), 'next month')).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
    expect(await listDocuments(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
  });
});

describe('readDocument', () => {
  it('signs a two-minute URL for a parent and records the read', async () => {
    const { db, signed, calls } = makeDb(() => ({ data: doc({ id: 'd-2', title: 'Will', category: 'legal' }), error: null }));
    const res = await readDocument(scopeWith(db, { actorKind: 'ai' }), 'd-2');
    expect(res).toMatchObject({ ok: true, data: { url: 'https://signed.example/x', document: { id: 'd-2', sensitive: true } } });
    expect(signed).toEqual([{ path: 'documents:fam-1/general/d-2.pdf', ttl: 120 }]);
    expect(calls[0].filters).toMatchObject({ id: 'd-2', family_id: 'fam-1' });
    expect(calls.some((c) => c.table === 'agent_activity' && c.kind === 'insert')).toBe(true);
  });

  it('refuses a sensitive document to a teen, a caregiver and a system actor, without signing', async () => {
    for (const role of ['teen', 'caregiver', 'system'] as const) {
      const { db, signed } = makeDb(() => ({ data: doc({ id: 'd-2', category: 'legal' }), error: null }));
      const res = await readDocument(scopeWith(db, { role }), 'd-2');
      expect(res).toMatchObject({ ok: false, code: 'denied' });
      expect(signed).toHaveLength(0);
    }
  });

  it('lets a teen open an ordinary document', async () => {
    const { db } = makeDb(() => ({ data: doc({ id: 'd-1' }), error: null }));
    expect(await readDocument(scopeWith(db, { role: 'teen' }), 'd-1')).toMatchObject({ ok: true });
  });

  it('reports a foreign id as not found and a storage failure as a db error', async () => {
    const missing = makeDb(() => ({ data: null, error: null }));
    expect(await readDocument(scopeWith(missing.db), 'someone-elses')).toMatchObject({ ok: false, code: 'not_found' });
    const broken = makeDb(() => ({ data: doc({}), error: null }), { error: { message: 'Object not found' } });
    expect(await readDocument(scopeWith(broken.db), 'd-1')).toMatchObject({ ok: false, code: 'db' });
  });

  it('clamps the requested lifetime', async () => {
    const { db, signed } = makeDb(() => ({ data: doc({}), error: null }));
    await readDocument(scopeWith(db), 'd-1', { expiresInSeconds: 999_999 });
    expect(signed[0].ttl).toBe(900);
  });
});

describe('linkToVacation', () => {
  const respond = (existing: unknown) => (call: Call): Reply => {
    if (call.table === 'documents') return { data: doc({ id: 'd-5', title: 'Ava passport', category: 'passport', expires_at: '2028-01-01', member_id: 'member-2' }), error: null };
    if (call.table === 'vacations') return { data: { id: 'v-1', title: 'Paris' }, error: null };
    if (call.table === 'vacation_documents' && call.kind === 'select') return { data: existing, error: null };
    if (call.table === 'vacation_documents' && call.kind === 'insert') return { data: { ...(call.payload as object), id: 'vd-1', created_at: '', updated_at: '', file_url: null, number: null, issued_on: null, notes: null }, error: null };
    return { data: null, error: null };
  };

  it('creates the link with kind inferred, member and expiry copied from the document', async () => {
    const { db, calls } = makeDb(respond(null));
    const res = await linkToVacation(scopeWith(db), { documentId: 'd-5', vacationId: 'v-1' });
    expect(res).toMatchObject({ ok: true, data: { created: true, link: { kind: 'passport', member_id: 'member-2', expires_on: '2028-01-01', title: 'Ava passport' } } });
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.payload).toMatchObject({ family_id: 'fam-1', vacation_id: 'v-1', document_id: 'd-5', created_by: 'auth-1' });
    expect(calls.filter((c) => c.kind === 'select').every((c) => c.filters.family_id === 'fam-1')).toBe(true);
  });

  it('returns the existing link instead of a second one', async () => {
    const { db, calls } = makeDb(respond({ id: 'vd-0', vacation_id: 'v-1', document_id: 'd-5', kind: 'passport', title: 'Ava passport' }));
    const res = await linkToVacation(scopeWith(db), { documentId: 'd-5', vacationId: 'v-1' });
    expect(res).toMatchObject({ ok: true, data: { created: false, link: { id: 'vd-0' } } });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('refuses a child linking a sensitive document and a foreign trip', async () => {
    const { db } = makeDb(respond(null));
    expect(await linkToVacation(scopeWith(db, { role: 'child' }), { documentId: 'd-5', vacationId: 'v-1' })).toMatchObject({ ok: false, code: 'denied' });
    const noTrip = makeDb((call) => (call.table === 'vacations' ? { data: null, error: null } : respond(null)(call)));
    expect(await linkToVacation(scopeWith(noTrip.db), { documentId: 'd-5', vacationId: 'v-other' })).toMatchObject({ ok: false, code: 'not_found' });
  });
});
