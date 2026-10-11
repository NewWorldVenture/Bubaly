// Three assistant-bridge defects, each pinned by a case that failed before its fix.
//
// 1. A key in someone else's name. 0283 grants `authenticated` INSERT/UPDATE
//    on every column of assistant_links and the policies test only
//    is_family_admin(family_id), so a parent could write, through PostgREST, a
//    key whose user_id is a CO-PARENT — minted fresh, or their own key
//    re-pointed. When that parent was removed, 0419 retired keys WHERE user_id
//    = them and the resolver checked user_id's standing, so the key kept
//    working, and everything it captured was filed as the co-parent's. The
//    only path that mints a key writes user_id and created_by from the same
//    session user, so a row where they differ is not one this product issued.
//    (The database half — withdrawing the client write grant — is a migration.)
//
// 2. An outage was "not linked". A failed read made the resolver answer null,
//    and the Alexa route spoke "link your Bubaly account" to a parent whose key
//    was fine, sending them to re-link when they only needed to try again.
//
// 3. Two first captures raced. The speaker's find-or-create read, then
//    inserted, with nothing between, so two captures a moment apart gave the
//    family two "Groceries" lists; and a list made for an item that then
//    failed to save was left behind, while the speaker said nothing changed.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { hashAssistantToken } from '@/lib/assistant/link-token';
import { classifyAssistantUtterance } from '@/lib/assistant/intent';
import { ERROR_SPEECH } from '@/lib/assistant/answers';
import { ALEXA_NOT_LINKED_SPEECH } from '@/lib/assistant/alexa';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), verifyAlexa: vi.fn(), answer: vi.fn(), record: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/assistant/alexa-verify', async (original) => ({
  ...await original<typeof import('@/lib/assistant/alexa-verify')>(), verifyAlexaRequest: mocks.verifyAlexa,
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const LEAVING = 'user-leaving-parent';
const STAYING = 'user-staying-parent';
const TOKEN = 'bub_asst_the-kitchen-speaker-secret-value';

let db: InMemorySupabase;

function seedKey(row: { user_id: string; created_by: string | null }) {
  db.seed('families', [{ id: FAMILY, name: 'Home', timezone: 'Europe/London' }]);
  db.seed('family_members', [
    { id: 'm-leaving', family_id: FAMILY, user_id: LEAVING, display_name: 'A', role: 'parent', is_active: false },
    { id: 'm-staying', family_id: FAMILY, user_id: STAYING, display_name: 'B', role: 'parent', is_active: true },
  ]);
  db.seed('assistant_links', [{
    id: 'link-1', family_id: FAMILY, provider: 'alexa', label: 'Kitchen',
    token_hash: hashAssistantToken(TOKEN), token_prefix: 'bub_asst_the', scopes: ['ask', 'capture'],
    revoked_at: null, ...row,
  }]);
}

beforeEach(() => {
  db = createInMemorySupabase();
  vi.restoreAllMocks();
  mocks.admin.mockReset();
  mocks.verifyAlexa.mockReset().mockResolvedValue({ ok: true });
});

describe('a key resolves only for the parent who minted it for themselves', () => {
  it('still resolves a key minted the only way the product mints one', async () => {
    const { resolveAssistantLink } = await import('@/lib/assistant/service');
    seedKey({ user_id: STAYING, created_by: STAYING });
    expect(await resolveAssistantLink(db as never, TOKEN)).toMatchObject({ family_id: FAMILY, user_id: STAYING });
  });

  it('refuses a key the departed parent wrote in the co-parent\'s name (user_id re-pointed, created_by theirs)', async () => {
    const { resolveAssistantLink } = await import('@/lib/assistant/service');
    seedKey({ user_id: STAYING, created_by: LEAVING });
    expect(await resolveAssistantLink(db as never, TOKEN)).toBeNull();
  });

  it('refuses a key written with no minting parent at all', async () => {
    const { resolveAssistantLink } = await import('@/lib/assistant/service');
    seedKey({ user_id: STAYING, created_by: null });
    expect(await resolveAssistantLink(db as never, TOKEN)).toBeNull();
  });
});

describe('a failed read is "try again", not "link your account"', () => {
  function failing(table: 'assistant_links' | 'family_members') {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((name: string) => {
      const q = from(name);
      if (name !== table) return q;
      return Object.assign(q, {
        maybeSingle: async () => ({ data: null, error: { message: 'connection reset', code: '08006' } }),
      });
    }) as typeof db.from);
  }

  it.each(['assistant_links', 'family_members'] as const)('reports %s read failure as unavailable, and still refuses', async (table) => {
    const { lookupAssistantLink, resolveAssistantLink } = await import('@/lib/assistant/service');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedKey({ user_id: STAYING, created_by: STAYING });
    failing(table);
    expect(await lookupAssistantLink(db as never, TOKEN)).toEqual({ status: 'unavailable' });
    expect(await resolveAssistantLink(db as never, TOKEN)).toBeNull();
  });

  it('keeps "not linked" for an unknown key', async () => {
    const { lookupAssistantLink } = await import('@/lib/assistant/service');
    seedKey({ user_id: STAYING, created_by: STAYING });
    expect(await lookupAssistantLink(db as never, `${TOKEN}-other`)).toEqual({ status: 'not_linked' });
  });

  async function speak(): Promise<string> {
    mocks.admin.mockReturnValue(db);
    const { POST } = await import('@/app/api/assistant/alexa/route');
    const envelope = {
      request: { type: 'IntentRequest', intent: { name: 'AMAZON.HelpIntent' } },
      session: { user: { accessToken: TOKEN } },
    };
    const res = await POST(new NextRequest('https://alexa-fixture.invalid/api/assistant/alexa', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { response: { outputSpeech: { text?: string; ssml?: string } } };
    return body.response.outputSpeech.text ?? body.response.outputSpeech.ssml ?? '';
  }

  it('Alexa says something went wrong, not "link your account", when the key lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedKey({ user_id: STAYING, created_by: STAYING });
    failing('assistant_links');
    const speech = await speak();
    expect(speech).toContain(ERROR_SPEECH);
    expect(speech).not.toContain(ALEXA_NOT_LINKED_SPEECH);
  });

  it('Alexa still says "not linked" for a key the product did not issue', async () => {
    seedKey({ user_id: STAYING, created_by: LEAVING });
    expect(await speak()).toContain(ALEXA_NOT_LINKED_SPEECH);
  });
});

// ---------------------------------------------------------------------------
// The default list: one, even when two captures arrive together.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * A store whose plain reads yield before answering (so two requests interleave
 * between read and insert, as two lambdas do), and whose get-or-create RPC is
 * one step, as 0443's per-family advisory lock makes it.
 */
function listStore(opts: { failItems?: boolean; seedItemOnCreate?: boolean } = {}) {
  const tables: Record<string, Row[]> = { grocery_lists: [], todo_lists: [], grocery_items: [], todo_items: [], family_ai_settings: [] };
  let n = 0;
  const createList = (table: string, familyId: string, name: string) => {
    n += 1;
    const row = { id: `${table}-${n}`, family_id: familyId, name, is_archived: false, archived_at: null, created_at: `2026-01-01T00:00:0${n}Z` };
    tables[table].push(row);
    if (opts.seedItemOnCreate) {
      // Someone else's capture landed on the list between ours being made and ours failing.
      tables[table === 'todo_lists' ? 'todo_items' : 'grocery_items'].push({ id: 'theirs', family_id: familyId, list_id: row.id });
    }
    return row;
  };
  const live = (table: string, familyId: string) => tables[table]
    .filter((r) => r.family_id === familyId && !r.is_archived && r.archived_at == null)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let op: 'select' | 'insert' | 'delete' = 'select';
    let payload: Row | Row[] | null = null;
    const rows = () => tables[table].filter((r) => filters.every(([c, v]) => (r[c] ?? null) === v));
    const run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (op === 'delete') {
        const doomed = new Set(rows());
        tables[table] = tables[table].filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
      if (op === 'insert') {
        if (opts.failItems && table.endsWith('_items')) return { data: null, error: { message: 'insert failed' } };
        const list = Array.isArray(payload) ? payload : [payload!];
        if (table.endsWith('_lists')) return { data: createList(table, String(list[0].family_id), String(list[0].name)), error: null };
        tables[table].push(...list);
        return { data: list, error: null };
      }
      return { data: rows(), error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      is: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      order: () => chain,
      limit: () => chain,
      insert: (value: Row | Row[]) => { op = 'insert'; payload = value; return chain; },
      delete: () => { op = 'delete'; return chain; },
      maybeSingle: async () => { const r = await run(); return { data: (r.data as Row[])[0] ?? null, error: r.error }; },
      single: async () => run(),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return chain;
  };
  const rpc = async (fn: string, args: { p_family_id: string; p_name: string }) => {
    const table = fn === 'ensure_default_grocery_list' ? 'grocery_lists' : 'todo_lists';
    const found = live(table, args.p_family_id)[0] ?? createList(table, args.p_family_id, args.p_name);
    return { data: found.id, error: null };
  };
  return { db: { from, rpc } as never, tables };
}

const link = {
  id: 'link-1', family_id: FAMILY, user_id: STAYING, provider: 'alexa', scopes: ['ask', 'capture'], timezone: 'UTC',
};
const NOW = new Date('2026-09-14T12:00:00Z');

async function capture(db: never, utterance: string) {
  const { answerAssistant } = await import('@/lib/assistant/service');
  return answerAssistant(db, link, classifyAssistantUtterance(utterance, NOW, 'UTC'), NOW);
}

describe('two first captures at once give the family one list', () => {
  it.each([
    ['grocery_lists', 'grocery_items', 'add milk to the shopping list', 'add eggs to the shopping list'],
    ['todo_lists', 'todo_items', 'remind me to call the dentist', 'remind me to renew the passports'],
  ])('%s', async (lists, items, first, second) => {
    const { db, tables } = listStore();
    await Promise.all([capture(db, first), capture(db, second)]);
    expect(tables[lists]).toHaveLength(1);
    expect(tables[items]).toHaveLength(2);
    expect(new Set(tables[items].map((r) => r.list_id))).toEqual(new Set([tables[lists][0].id]));
  });
});

describe('a list made for an item that was not saved is not left behind', () => {
  it.each([
    ['grocery_lists', 'add milk to the shopping list'],
    ['todo_lists', 'remind me to call the dentist'],
  ])('%s', async (lists, utterance) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, tables } = listStore({ failItems: true });
    await expect(capture(db, utterance)).rejects.toThrow('capture write failed');
    expect(tables[lists]).toEqual([]);
  });

  it('keeps a list that already existed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, tables } = listStore({ failItems: true });
    tables.grocery_lists.push({ id: 'theirs', family_id: FAMILY, name: 'Groceries', is_archived: false, archived_at: null, created_at: '2020-01-01' });
    await expect(capture(db, 'add milk to the shopping list')).rejects.toThrow('capture write failed');
    expect(tables.grocery_lists.map((r) => r.id)).toEqual(['theirs']);
  });

  it('keeps a list someone else has already put an item on — deleting it would cascade to their item', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, tables } = listStore({ failItems: true, seedItemOnCreate: true });
    await expect(capture(db, 'add milk to the shopping list')).rejects.toThrow('capture write failed');
    expect(tables.grocery_lists).toHaveLength(1);
    expect(tables.grocery_items).toHaveLength(1);
  });
});
