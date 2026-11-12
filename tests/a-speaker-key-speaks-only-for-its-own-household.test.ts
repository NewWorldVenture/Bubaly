// POST /api/assistant, driven end to end against two households.
//
// The route takes no session: the `bub_asst_…` key IS the authorization, and
// everything after it runs on the service client scoped to the family the key
// resolved to (the route's header note). So the questions are: what a request
// with no key, a key nobody issued, or a key minted by someone who could never
// mint one reaches; what a good key writes and where; whether anything in the
// body can point it at another household; and what the speaker hears when a
// read fails.
//
// Already proved elsewhere, and not repeated here:
//   tests/a-closed-familys-speaker-key-answers-nothing.test.ts — a closed family's key is 401.
//   tests/an-assistant-key-belongs-to-the-parent-who-minted-it.test.ts — a key whose
//     user_id and created_by differ is refused; a failed link read is `unavailable`.
//   tests/assistant-bridge.test.ts — token parsing, the IP limiter's placement (source).
//   tests/middleware-assistant-boundary.test.ts — the middleware leaves this route to its token.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { hashAssistantToken } from '@/lib/assistant/link-token';
import { ERROR_SPEECH } from '@/lib/assistant/answers';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));

const ID = 'API-C8B72ACE022A';

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const PARENT_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const PARENT_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const LINK_A = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const LINK_B = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const LIST_A = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const LIST_B = 'bbbbbbbb-0000-4000-8000-0000000000d1';
const KEY_A = 'bub_asst_test-fake-key-household-a-kitchen';
const KEY_B = 'bub_asst_test-fake-key-household-b-hallway';
const ROLES = ['adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const userFor = (role: (typeof ROLES)[number]) => `aaaaaaaa-0000-4000-8000-0000000000e${ROLES.indexOf(role)}`;
const keyFor = (role: string) => `bub_asst_test-fake-key-household-a-${role}`;

let db: InMemorySupabase;
let ip = 0;

function link(id: string, family: string, user: string, key: string) {
  return {
    id, family_id: family, user_id: user, created_by: user, provider: 'generic', label: 'Kitchen',
    token_hash: hashAssistantToken(key), token_prefix: key.slice(0, 12), scopes: ['ask', 'capture'],
    revoked_at: null, last_used_at: null,
  };
}

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  mocks.admin.mockReset().mockReturnValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', closed_at: null },
  ]);
  db.seed('family_members', [
    { family_id: FAMILY_A, user_id: PARENT_A, role: 'parent', is_active: true, display_name: 'Parent A' },
    { family_id: FAMILY_B, user_id: PARENT_B, role: 'parent', is_active: true, display_name: 'Parent B' },
    ...ROLES.map((role) => ({ family_id: FAMILY_A, user_id: userFor(role), role, is_active: true, display_name: role })),
  ]);
  db.seed('assistant_links', [
    link(LINK_A, FAMILY_A, PARENT_A, KEY_A),
    link(LINK_B, FAMILY_B, PARENT_B, KEY_B),
    ...ROLES.map((role) => link(`aaaaaaaa-0000-4000-8000-0000000000f${ROLES.indexOf(role)}`, FAMILY_A, userFor(role), keyFor(role))),
  ]);
  db.seed('grocery_lists', [
    { id: LIST_A, family_id: FAMILY_A, name: 'Groceries', is_archived: false, archived_at: null },
    { id: LIST_B, family_id: FAMILY_B, name: 'Groceries', is_archived: false, archived_at: null },
  ]);
  db.seed('grocery_items', [
    { family_id: FAMILY_A, list_id: LIST_A, name: 'Bread', quantity: null, is_checked: false },
    { family_id: FAMILY_B, list_id: LIST_B, name: 'Diapers', quantity: null, is_checked: false },
  ]);
});

async function ask(body: Record<string, unknown>, key: string | null = KEY_A) {
  const { POST } = await import('@/app/api/assistant/route');
  ip += 1;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ip}` };
  if (key) headers.authorization = `Bearer ${key}`;
  return POST(new NextRequest('https://assistant-fixture.invalid/api/assistant', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
}

const itemsOf = (family: string) => db.table('grocery_items').filter((r) => r.family_id === family).map((r) => r.name);
const eventsOf = (family: string) => db.table('assistant_link_events').filter((r) => r.family_id === family);

describe('who may call POST /api/assistant', () => {
  it(`${ID} signed-out (no key) is refused 401 before a database client exists, and writes nothing`, async () => {
    const res = await ask({ utterance: 'add oat milk to the shopping list' }, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
  });

  it(`${ID} a key nobody issued is refused 401, with no event, no rate-limit row and no capture`, async () => {
    const res = await ask({ utterance: 'add oat milk to the shopping list' }, 'bub_asst_test-fake-key-never-issued');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(db.table('assistant_link_events')).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
  });

  it.each(ROLES)(`${ID} a key minted in a %s's name is refused 401 and files nothing (only a parent mints one)`, async (role) => {
    const res = await ask({ utterance: 'add oat milk to the shopping list' }, keyFor(role));
    expect(res.status).toBe(401);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
    expect(db.table('assistant_link_events')).toEqual([]);
    expect(db.table('assistant_links').every((l) => l.last_used_at === null)).toBe(true);
  });
});

describe('a parent\'s key, end to end', () => {
  it(`${ID} captures into its own household's list, records the event, stamps the key and counts a durable hit on the link`, async () => {
    const res = await ask({ utterance: 'add oat milk to the shopping list' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ speech: expect.stringContaining('shopping list'), intent: 'capture:shopping', outcome: 'captured' });

    expect(itemsOf(FAMILY_A)).toEqual(['Bread', expect.stringMatching(/^oat milk$/i)]);
    expect(db.table('grocery_items').find((r) => /oat milk/i.test(String(r.name)))).toMatchObject({ list_id: LIST_A, created_by: PARENT_A });
    expect(eventsOf(FAMILY_A)).toEqual([expect.objectContaining({ link_id: LINK_A, intent: 'capture:shopping', outcome: 'captured' })]);
    expect(db.table('assistant_links').find((l) => l.id === LINK_A)?.last_used_at).toEqual(expect.any(String));
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`assistant:${LINK_A}`]);
  });

  it(`${ID} answers 429 with Retry-After once the link's durable bucket is full, and reads and writes nothing more`, async () => {
    const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
    db.seed('rate_limits', [{ bucket_key: `assistant:${LINK_A}`, window_start: windowStart, count: 30 }]);
    const res = await ask({ utterance: 'add oat milk to the shopping list' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
    expect(db.table('assistant_link_events')).toEqual([]);
  });
});

describe('another household\'s ids', () => {
  it(`${ID} a body naming household B is ignored: household A's list is read, nothing of B's is spoken or touched`, async () => {
    const res = await ask({ utterance: "what's on the shopping list", family_id: FAMILY_B, familyId: FAMILY_B, link_id: LINK_B });
    expect(res.status).toBe(200);
    const body = await res.json() as { speech: string; outcome: string };
    expect(body.outcome).toBe('answered');
    expect(body.speech).toContain('Bread');
    expect(body.speech).not.toContain('Diapers');
    expect(eventsOf(FAMILY_B)).toEqual([]);
    expect(db.table('assistant_links').find((l) => l.id === LINK_B)?.last_used_at).toBeNull();
  });

  it(`${ID} household B's key captures into B only; household A's list and key are untouched`, async () => {
    const res = await ask({ utterance: 'add oat milk to the shopping list', family_id: FAMILY_A }, KEY_B);
    expect(res.status).toBe(200);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
    expect(itemsOf(FAMILY_B)).toEqual(['Diapers', expect.stringMatching(/^oat milk$/i)]);
    expect(eventsOf(FAMILY_A)).toEqual([]);
    expect(db.table('assistant_links').find((l) => l.id === LINK_A)?.last_used_at).toBeNull();
  });
});

describe('a read that fails', () => {
  it(`${ID} the shopping-list read failing is spoken as an error (outcome "error"), never as an empty list, and leaks no internal text`, async () => {
    mocks.admin.mockReturnValue(withFaults(db, (table, calls) =>
      table === 'grocery_items' && calls.some((c) => c.method === 'select') ? { message: 'relation grocery_items: connection reset by peer' } : null));
    const res = await ask({ utterance: "what's on the shopping list" });
    expect(res.status).toBe(200);
    const body = await res.json() as { speech: string; outcome: string; intent: string };
    expect(body).toEqual({ speech: ERROR_SPEECH, intent: 'list', outcome: 'error' });
    expect(JSON.stringify(body)).not.toMatch(/connection reset|grocery_items|nothing on the shopping list/);
    expect(eventsOf(FAMILY_A)).toEqual([expect.objectContaining({ link_id: LINK_A, outcome: 'error' })]);
  });
});
