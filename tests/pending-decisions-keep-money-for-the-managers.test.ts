// The assistant toolbox's `list_pending_decisions` read `parent_approvals` for
// whoever was talking, and it is not a trust-gated tool (reads pass the chat
// wrapper untouched). So a child asking "what needs me?" was handed every
// pending wallet approval in the family as "Card purchase to approve · $45",
// and the count of chores waiting on a parent's sign-off — both of which Home,
// Needs-you and the dashboard show only to a parent or adult.
//
// Driven as POST /api/ai/chat builds it: the real toolbox, wrapped by the real
// trust wrapper, over an in-memory household.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';

const FAMILY = 'fam-1';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

async function pendingDecisionsAs(role: string): Promise<string[]> {
  const ctx = { familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role, members: [{ id: 'mem-1', display_name: 'Sam' }], tz: 'UTC' };
  const tools = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, role, 'mem-1');
  const tool = tools.find((t) => t.name === 'list_pending_decisions');
  if (!tool) throw new Error('list_pending_decisions is not in the toolbox');
  const result = await tool.execute({}) as { ok: boolean; items?: { title: string }[]; error?: string };
  expect(result.ok, result.error).toBe(true);
  return (result.items ?? []).map((i) => i.title);
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>() as DB;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('parent_approvals', [
    { id: 'pa-1', family_id: FAMILY, kind: 'card_spend', amount_cents: 4500, status: 'pending', created_at: inDays(-1) },
    { id: 'pa-2', family_id: FAMILY, kind: 'withdrawal', amount_cents: 12000, status: 'pending', created_at: inDays(-1) },
  ]);
  db.seed('chore_assignments', [{ id: 'ca-1', family_id: FAMILY, status: 'submitted' }]);
  db.seed('renewals', [{ id: 'r-1', family_id: FAMILY, title: 'Car registration', expires_at: inDays(5), reminder_days: 14, status: 'active' }]);
});

describe('list_pending_decisions keeps money decisions for the people who make them', () => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is not handed the money approvals or the sign-off count', async (role) => {
    const titles = await pendingDecisionsAs(role);
    expect(titles.join('\n')).not.toMatch(/\$45\b|\$120\b/);
    expect(titles.join('\n')).not.toMatch(/to approve/i);
    expect(titles.join('\n')).not.toMatch(/awaiting approval/i);
    // Nothing was even asked of the table.
    expect(db.log.some((c) => c.table === 'parent_approvals'), 'parent_approvals was read for a non-manager').toBe(false);
  });

  it('a child still sees what the dashboard shows every member, such as a renewal coming due', async () => {
    const titles = await pendingDecisionsAs('child');
    expect(titles.some((t) => t.startsWith('Renew Car registration'))).toBe(true);
  });

  it('an unknown role is not a manager', async () => {
    const titles = await pendingDecisionsAs('owner');
    expect(titles.join('\n')).not.toMatch(/to approve|\$45\b/i);
  });

  it.each(['parent', 'adult'])('a %s still gets every money approval, with its amount, and the sign-off count', async (role) => {
    const titles = await pendingDecisionsAs(role);
    // The exact titles the cases above prove a non-manager is never handed.
    expect(titles).toContain('Card purchase to approve · $45');
    expect(titles).toContain('Withdrawal to approve · $120');
    expect(titles).toContain('1 chore awaiting approval');
  });
});


// The legacy read bypasses the documents service, so it must preserve the
// same metadata boundary before titles are handed to the model. The original
// money/renewal cases above remain unchanged.
async function pendingDocumentResult(client: SupabaseClient<Database>, role: string | null) {
  const ctx = { familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role, members: [{ id: 'mem-1', display_name: 'Sam' }], tz: 'UTC' };
  const tools = wrapToolsWithTrust(buildAssistantTools(client, ctx), client, FAMILY, role, 'mem-1');
  const tool = tools.find((entry) => entry.name === 'list_pending_decisions');
  if (!tool) throw new Error('list_pending_decisions is not in the toolbox');
  return await tool.execute({}) as { ok: boolean; count?: number; items?: { title: string; urgency: string }[]; error?: string };
}
function documentRows() {
  return [
    { id: 'secure-own', family_id: FAMILY, member_id: 'mem-1', title: 'Synthetic private diagnosis', category: 'Kids Activities', is_secure: true, expires_at: inDays(4) },
    { id: 'category-own', family_id: FAMILY, member_id: 'mem-1', title: 'Synthetic private passport', category: 'Passports & IDs', is_secure: false, expires_at: inDays(5) },
    { id: 'public-own', family_id: FAMILY, member_id: 'mem-1', title: 'Synthetic public library card', category: 'Kids Stories', is_secure: false, expires_at: inDays(6) },
    { id: 'other-public', family_id: 'other-family', member_id: 'other-member', title: 'Synthetic other family card', category: null, is_secure: false, expires_at: inDays(4) },
    { id: 'other-secure', family_id: 'other-family', member_id: 'other-member', title: 'Synthetic other private passport', category: 'passport', is_secure: true, expires_at: inDays(4) },
  ];
}
describe('legacy pending decisions preserve the existing document metadata boundary', () => {
  it.each(['child', 'teen', 'caregiver', 'guest', 'owner', 'system', 'PARENT', null])('withholds sensitive document titles for %s without hiding a public own document', async (role) => {
    const rows = documentRows();
    db.seed('documents', rows);
    const storedRows = structuredClone(db.table('documents'));
    const result = await pendingDocumentResult(db, role);
    expect(result.ok, result.error).toBe(true);
    const titles = (result.items ?? []).map((item) => item.title).join('\n');
    expect(titles).not.toContain('Synthetic private diagnosis');
    expect(titles).not.toContain('Synthetic private passport');
    expect(titles).toContain('Synthetic public library card');
    expect(titles).not.toContain('Synthetic other');
    expect(result.count).toBe(result.items?.length);
    // Owning the private row does not grant the manager-only metadata policy.
    expect(db.table('documents')).toEqual(storedRows);
  });
  it.each(['parent', 'adult'])('preserves secure and category-sensitive metadata for the existing manager role %s', async (role) => {
    db.seed('documents', documentRows());
    const result = await pendingDocumentResult(db, role);
    expect(result.ok, result.error).toBe(true);
    const titles = (result.items ?? []).map((item) => item.title).join('\n');
    expect(titles).toContain('Synthetic private diagnosis');
    expect(titles).toContain('Synthetic private passport');
    expect(titles).toContain('Synthetic public library card');
    expect(titles).not.toContain('Synthetic other');
    expect(titles).toContain('Card purchase to approve');
  });
  it.each([
    ['Tax Returns', false], ['Bank Statements', false], ['Medical Records', false],
    ['Social Security', false], ['Passports & IDs', false], ['Kids Stories', true],
  ] as const)('uses the existing category-token rule for %s', async (category, visible) => {
    db.seed('documents', [{ id: 'category-case', family_id: FAMILY, title: 'Synthetic category card', category, is_secure: false, expires_at: inDays(5) }]);
    const result = await pendingDocumentResult(db, 'guest');
    expect(result.ok, result.error).toBe(true);
    expect((result.items ?? []).some((item) => item.title.includes('Synthetic category card'))).toBe(visible);
  });
  it('keeps an expired public document with null category and null secure flag actionable', async () => {
    db.seed('documents', [{ id: 'expired-public', family_id: FAMILY, title: 'Synthetic expired public card', category: null, is_secure: null, expires_at: inDays(-2) }]);
    const result = await pendingDocumentResult(db, 'child');
    expect(result.ok, result.error).toBe(true);
    expect(result.items).toContainEqual({ title: 'Synthetic expired public card — expired', urgency: 'urgent' });
  });
  it('does not show a public document outside the original expiry window', async () => {
    db.seed('documents', [{ id: 'future-public', family_id: FAMILY, title: 'Synthetic future public card', category: null, is_secure: false, expires_at: inDays(60) }]);
    const result = await pendingDocumentResult(db, 'guest');
    expect(result.ok, result.error).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Synthetic future public card');
  });
  it('keeps missing documents as a healthy empty source while preserving renewals', async () => {
    db.seed('documents', []);
    const result = await pendingDocumentResult(db, 'guest');
    expect(result.ok, result.error).toBe(true);
    expect(result.items?.some((item) => item.title.startsWith('Renew Car registration'))).toBe(true);
  });
  it('preserves the refused-read error instead of treating unavailable documents as empty', async () => {
    const { withFaults } = await import('./helpers/in-memory-supabase');
    const faulty = withFaults(db, (table) => table === 'documents' ? { message: 'Synthetic document read unavailable' } : null);
    const result = await pendingDocumentResult(faulty, 'guest');
    expect(result).toEqual({ ok: false, error: 'Could not load pending decisions.' });
  });
  it.each(['guest', 'child', 'parent'])('enforces metadata omission through actual installed SDK projection for %s', async (role) => {
    const { createClient } = await import('@supabase/supabase-js');
    const allowedTables = new Set(['documents', 'parent_approvals', 'renewals', 'family_reminders', 'calendar_events', 'chore_assignments', 'grocery_items', 'todo_items']);
    const requests: { table: string; select: string | null; family: string | null }[] = [];
    const client = createClient<Database>('https://synthetic-pending-documents.invalid', 'synthetic-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const table = url.pathname.split('/').at(-1) ?? '';
        expect(url.origin).toBe('https://synthetic-pending-documents.invalid');
        expect(allowedTables.has(table), 'unexpected synthetic request table').toBe(true);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        expect(['GET', 'HEAD']).toContain(method);
        requests.push({ table, select: url.searchParams.get('select'), family: url.searchParams.get('family_id') });
        expect(requests.length).toBeLessThanOrEqual(12);
        expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
        const rows = table === 'documents'
          ? documentRows().filter((row) => row.family_id === url.searchParams.get('family_id')?.slice(3)).map((row) => {
            const columns = (url.searchParams.get('select') ?? '*').split(',');
            return Object.fromEntries(columns.map((column) => [column, row[column as keyof typeof row]]));
          }) : [];
        return new Response(method === 'HEAD' ? null : JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/' + rows.length } });
      } },
    });
    const result = await pendingDocumentResult(client, role);
    expect(result.ok, result.error).toBe(true);
    const titles = (result.items ?? []).map((item) => item.title).join('\n');
    expect(titles).toContain('Synthetic public library card');
    expect(titles).not.toContain('Synthetic other');
    expect(titles.includes('Synthetic private diagnosis')).toBe(role === 'parent');
    expect(titles.includes('Synthetic private passport')).toBe(role === 'parent');
    expect(requests.filter((request) => request.table === 'documents')).toEqual([
      { table: 'documents', select: 'id,title,expires_at,category,is_secure', family: 'eq.' + FAMILY },
    ]);
  });
});
