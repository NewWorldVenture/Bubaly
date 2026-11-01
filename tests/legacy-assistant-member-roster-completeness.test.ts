// Actual caller preparation, synthetic counted projections. No tool execution,
// model generation, Auth, SDK, coordinator, Storage or native database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
type Mode = 'healthy' | 'capped' | 'later-error' | 'missing-count' | 'changed-count' | 'duplicate' | 'no-progress' | 'over-ceiling';
const h = vi.hoisted(() => ({
  db: null as unknown, captured: [] as Array<{ members: Array<{ id: string; display_name: string }>; role: unknown; memberId: unknown }>,
  captureOnlyChat: false,
  forbidden: vi.fn((boundary: string): never => { throw new Error(`Forbidden roster boundary: ${boundary}`); }),
  resolved: vi.fn(), generated: vi.fn(),
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'actor-user' }, active: {
    familyId: 'family-own', role: 'parent', member: { id: 'a-actor' }, family: { name: 'Synthetic', timezone: 'UTC' },
  } }), getUserContext: () => h.forbidden('Auth reentry'),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.forbidden('service client') }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.forbidden('SDK') }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => h.forbidden('SSR'), createBrowserClient: () => h.forbidden('browser') }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-access', () => ({ AI_ASSISTANT_FEATURE_KEY: 'ai-assistant', assertAIAccess: async () => ({ ok: true }), accessDeniedResponse: () => h.forbidden('allowance refusal') }));
vi.mock('@/lib/services/scope', () => ({ scopeFromUserContext: () => ({ db: h.db, familyId: 'family-own' }) }));
vi.mock('@/lib/calendar/occurrences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/calendar/occurrences')>()),
  readCalendarOccurrences: async () => ({ data: [], error: null }),
}));
vi.mock('@/lib/assistant/tools', () => ({ buildAssistantTools: (_db: unknown, ctx: { members: Array<{ id: string; display_name: string }>; role: unknown; memberId: unknown }) => {
  h.captured.push({ members: ctx.members.map(row => ({ ...row })), role: ctx.role, memberId: ctx.memberId });
  if (h.captureOnlyChat) throw new Error('SYNTHETIC_CAPTURE_COMPLETE');
  return [];
} }));
vi.mock('@/lib/assistant/trust-wrapper', () => ({ wrapToolsWithTrust: (tools: unknown[]) => tools }));
vi.mock('@/lib/ai/action-tools', () => ({ buildActionTools: () => [], mergeToolSets: (...sets: unknown[][]) => sets.flat() }));
vi.mock('@/lib/ai/context/builder', () => ({ buildContext: async () => ({ ok: true, data: { text: 'Synthetic context', header: { currency: 'USD' } } }) }));
vi.mock('@/lib/ai/context/intents', () => ({ classifyIntent: () => h.forbidden('classifier') }));
vi.mock('@/lib/ai/tools/legacy-adapter', () => ({ toToolSpecs: () => [] }));
vi.mock('@/lib/ai/tools/registry', () => ({ getTool: () => undefined, toolNames: () => [] }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: async () => true,
  resolveProvider: async () => { h.resolved(); return {
    model: 'synthetic-never-generated', runTools: () => h.forbidden('model'),
    async *runToolsStream() { h.generated(); h.forbidden('model stream'); yield { type: 'delta', text: '' }; },
  }; }, describeAIError: () => ({ message: 'Synthetic refusal' }),
}));
vi.mock('@/lib/ai/voice-exchange', () => ({ ASSISTANT_TURN_FEATURES: ['chat.assistant'] }));
vi.mock('@/lib/ai/observability', () => ({
  AiRequestDuplicate: class extends Error {}, AiRequestNotFiled: class extends Error {},
  withAiRequest: () => h.forbidden('request recording/model execution'),
}));

const importFetch = vi.fn(() => h.forbidden('import fetch'));
vi.stubGlobal('fetch', importFetch);
const { prepareAssistantTurn } = await import('@/lib/ai/assistant-engine');
const { POST } = await import('@/app/api/ai/chat/route');
const importedCalls = { fetch: [...importFetch.mock.calls], forbidden: [...h.forbidden.mock.calls] };

let mode: Mode;
let reads: Array<{ table: string; columns: string; count: unknown; filters: Array<[string, unknown]>; range: [number, number] | null }>;
let fetchGuard: ReturnType<typeof vi.fn>;
const ownRows = () => [
  { id: 'a-actor', user_id: 'actor-user', display_name: 'Samantha', role: 'parent', family_id: 'family-own', is_active: true },
  { id: 'b-exact', user_id: 'sam-user', display_name: 'Sam', role: 'teen', family_id: 'family-own', is_active: true },
  { id: 'c-inactive', user_id: 'inactive-user', display_name: 'Hidden', role: 'adult', family_id: 'family-own', is_active: false },
  { id: 'd-foreign', user_id: 'foreign-user', display_name: 'Foreign', role: 'parent', family_id: 'family-other', is_active: true },
];

function query(table: string) {
  if (!['family_members', 'ai_messages', 'ai_conversations', 'chore_assignments', 'meals'].includes(table)) return h.forbidden('table ' + table);
  let columns = '', counted: unknown, maximum = Infinity, range: [number, number] | null = null;
  const filters: Array<[string, unknown]> = [];
  const q = {
    select(value: string, options?: { count?: string }) { columns = value; counted = options?.count; return q; },
    eq(key: string, value: unknown) { filters.push([key, value]); return q; },
    in(_key: string, _value: unknown) { return q; },
    order(key: string) { if (table === 'family_members' && key !== 'id') return h.forbidden('roster order'); return q; },
    limit(value: number) { maximum = value; return q; },
    range(first: number, last: number) { range = [first, last]; return q; },
    maybeSingle: async () => ({ data: { id: 'conversation-own', family_id: 'family-own', user_id: 'actor-user', title: 'Own' }, error: null }),
    insert: () => h.forbidden('insert'), update: () => h.forbidden('update'), delete: () => h.forbidden('delete'),
    upsert(value: { id: string; family_id: string; user_id: string }, options: { onConflict: string; ignoreDuplicates: boolean }) {
      // The POST's existing admission asks to create its conversation before
      // reading context. This synthetic receipt neither mutates nor calls a DB.
      if (table !== 'ai_conversations' || value.id !== '00000000-0000-4000-8000-000000000021' || value.family_id !== 'family-own' || value.user_id !== 'actor-user' || options.onConflict !== 'id' || !options.ignoreDuplicates) return h.forbidden('upsert');
      return Promise.resolve({ error: null });
    },
    then(resolve: (value: { data: Row[] | null; count: number | null; error: { message: string } | null }) => unknown) {
      reads.push({ table, columns, count: counted, filters: [...filters], range });
      if (table !== 'family_members') return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
      if (!['id, display_name, role', 'id, user_id, display_name, role'].includes(columns)) return h.forbidden('projection');
      const all = mode === 'over-ceiling' ? Array.from({ length: 2001 }, (_, index) => ({ ...ownRows()[0], id: `member-${String(index).padStart(4, '0')}` })) : ownRows();
      let rows = all.filter(row => filters.every(([key, value]) => row[key as keyof typeof row] === value)).sort((a, b) => a.id.localeCompare(b.id));
      let count: number | null = mode === 'missing-count' ? null : rows.length;
      if (range && mode === 'later-error') return Promise.resolve({ data: null, count, error: { message: 'Synthetic later page refused' } }).then(resolve);
      if (range && mode === 'changed-count') count = (count ?? 0) + 1;
      if (range && mode === 'duplicate') rows = rows.slice(0, 1);
      else if (range && mode === 'no-progress') rows = [];
      else if (range) rows = rows.slice(range[0], range[1] + 1);
      const cap = mode === 'healthy' || mode === 'over-ceiling' ? Infinity : 1;
      rows = rows.slice(0, Math.min(maximum, cap));
      const selected = columns.split(',').map(column => column.trim());
      return Promise.resolve({ data: rows.map(row => Object.fromEntries(selected.map(column => [column, row[column as keyof typeof row]]))), count, error: null }).then(resolve);
    },
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks(); mode = 'healthy'; reads = []; h.captured = []; h.captureOnlyChat = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchGuard = vi.fn(() => h.forbidden('runtime fetch')); vi.stubGlobal('fetch', fetchGuard);
  h.db = { from: query, rpc: () => h.forbidden('RPC'), storage: new Proxy({}, { get: () => h.forbidden('Storage') }), auth: new Proxy({}, { get: () => h.forbidden('Auth') }) };
});
afterEach(() => {
  expect(importedCalls).toEqual({ fetch: [], forbidden: [] }); expect(fetchGuard).not.toHaveBeenCalled();
  expect(h.generated).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function prepare(caller: 'engine' | 'chat') {
  if (caller === 'engine') return prepareAssistantTurn({ supabase: h.db as never, familyId: 'family-own', userId: 'actor-user', role: 'parent', familyName: 'Synthetic', tz: 'UTC', conversationId: 'conversation-own', message: 'List chores for Sam', intent: 'other' });
  // A known test sentinel stops the actual POST at captured tool construction,
  // before any response stream/model/observation execution. Its healthy capture
  // returns500 due to that sentinel; no successful complete chat claim follows.
  h.captureOnlyChat = true;
  return POST(new NextRequest('http://synthetic.invalid/api/ai/chat', { method: 'POST', body: JSON.stringify({ conversationId: '00000000-0000-4000-8000-000000000021', message: 'List chores for Sam' }), headers: { 'Content-Type': 'application/json' } }));
}

describe.each(['engine', 'chat'] as const)('%s complete legacy member snapshot', caller => {
  it('keeps the full healthy active same-family projection and actor', async () => {
    await prepare(caller);
    expect(h.captured).toEqual([{ members: [{ id: 'a-actor', display_name: 'Samantha' }, { id: 'b-exact', display_name: 'Sam' }], role: 'parent', memberId: 'a-actor' }]);
    const roster = reads.filter(read => read.table === 'family_members');
    expect(roster[0].filters).toEqual([['family_id', 'family-own'], ['is_active', true]]);
    expect(roster[0].columns).toBe(caller === 'engine' ? 'id, user_id, display_name, role' : 'id, display_name, role');
  });
  it('keeps the later exact member when the actor and fuzzy name fill the first page', async () => {
    mode = 'capped'; await prepare(caller);
    expect(h.captured[0]?.members).toEqual([{ id: 'a-actor', display_name: 'Samantha' }, { id: 'b-exact', display_name: 'Sam' }]);
    expect(reads.filter(read => read.table === 'family_members').map(read => read.range)).toEqual([null, [1, 1]]);
  });
  it.each(['later-error', 'missing-count', 'changed-count', 'duplicate', 'no-progress', 'over-ceiling'] as const)('refuses %s before tools or model preparation', async failure => {
    mode = failure; const result = await prepare(caller);
    expect(h.captured).toEqual([]); expect(h.resolved).not.toHaveBeenCalled();
    if (caller === 'engine') expect(result).toMatchObject({ ok: false });
    else expect((result as Response).status).toBe(500);
  });
});
