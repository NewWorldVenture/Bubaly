// POST /api/assistant/alexa, driven end to end against two households, with
// Amazon's request signature checked FOR REAL.
//
// The route calls verifyAlexaRequest({ headers, rawBody, body }), which would
// fetch Amazon's certificate chain and anchor it to the platform trust store.
// That seam is the one thing replaced: the real function runs with a chain
// minted here (leaf → intermediate → root, as tests/alexa-request-verification
// does) and that root as the only trust anchor. Everything else — the
// timestamp, the skill id, the RSA-SHA256 signature over the bytes that
// arrived — is the production check.
//
// Already proved elsewhere, and not repeated here:
//   tests/alexa-request-verification.test.ts — every verifier refusal reason, and
//     (by source) that the route verifies before the token or the database.
//   tests/a-closed-familys-speaker-key-answers-nothing.test.ts — a closed family's key.
//   tests/an-assistant-key-belongs-to-the-parent-who-minted-it.test.ts — a failed
//     link read speaks ERROR_SPEECH, not the linking prompt.
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { hashAssistantToken } from '@/lib/assistant/link-token';
import { ERROR_SPEECH } from '@/lib/assistant/answers';
import { ALEXA_NOT_LINKED_SPEECH } from '@/lib/assistant/alexa';

const certs = vi.hoisted(() => ({ chain: '', root: '' }));
const mocks = vi.hoisted(() => ({ admin: vi.fn(), fetchChain: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/assistant/alexa-verify', async (original) => {
  const real = await original<typeof import('@/lib/assistant/alexa-verify')>();
  return {
    ...real,
    verifyAlexaRequest: (args: Parameters<typeof real.verifyAlexaRequest>[0]) =>
      real.verifyAlexaRequest({ ...args, fetchChain: mocks.fetchChain, trustAnchors: [certs.root] }),
  };
});

const ID = 'API-A2C5302CAE88';
const SKILL = 'amzn1.ask.skill.test-fake-skill';
const CERT_URL = 'https://s3.amazonaws.com/echo.api/echo-api-cert-test.pem';

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

let dir = '';
let leafKey = '';
let otherKey = '';
let db: InMemorySupabase;
let ip = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bubaly-alexa-route-'));
  const ssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2',
    '-subj', '/CN=Bubaly Test root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  writeFileSync(join(dir, 'int.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'int.key', '-out', 'int.csr', '-subj', '/CN=Bubaly Test Intermediate']);
  ssl(['x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-out', 'int.pem', '-days', '2',
    '-CAcreateserial', '-extfile', 'int.ext']);
  writeFileSync(join(dir, 'leaf.ext'), 'subjectAltName=DNS:echo-api.amazon.com\nbasicConstraints=critical,CA:FALSE\n');
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=echo-api.amazon.com']);
  ssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'int.pem', '-CAkey', 'int.key', '-out', 'leaf.pem', '-days', '2',
    '-CAcreateserial', '-extfile', 'leaf.ext']);
  ssl(['genrsa', '-out', 'other.key', '2048']);
  certs.root = read('root.pem');
  certs.chain = [read('leaf.pem'), read('int.pem'), certs.root].join('\n');
  leafKey = read('leaf.key');
  otherKey = read('other.key');
}, 60_000);

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function link(id: string, family: string, user: string, key: string, revokedAt: string | null = null) {
  return {
    id, family_id: family, user_id: user, created_by: user, provider: 'alexa', label: 'Echo',
    token_hash: hashAssistantToken(key), token_prefix: key.slice(0, 12), scopes: ['ask', 'capture'],
    revoked_at: revokedAt, last_used_at: null,
  };
}

beforeEach(async () => {
  const { clearAlexaCertCache } = await import('@/lib/assistant/alexa-verify');
  clearAlexaCertCache();
  vi.stubEnv('ALEXA_SKILL_ID', SKILL);
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  mocks.admin.mockReset().mockReturnValue(db);
  mocks.fetchChain.mockReset().mockResolvedValue(certs.chain);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    link(LINK_B, FAMILY_B, PARENT_B, KEY_B, '2026-10-01T00:00:00.000Z'),
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

function envelope(query: string, token: string | null = KEY_A) {
  return {
    version: '1.0',
    session: { application: { applicationId: SKILL }, ...(token ? { user: { accessToken: token } } : {}) },
    request: {
      type: 'IntentRequest', timestamp: new Date().toISOString(),
      intent: { name: 'AskBubaly', slots: { query: { name: 'query', value: query } } },
    },
  };
}

type Signing = 'unsigned' | 'genuine' | 'other-key' | 'tampered';

async function send(body: object, signing: Signing = 'genuine') {
  const { POST } = await import('@/app/api/assistant/alexa/route');
  const raw = JSON.stringify(body);
  ip += 1;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${ip}` };
  if (signing !== 'unsigned') {
    headers['signature-256'] = createSign('RSA-SHA256').update(raw).sign(signing === 'other-key' ? otherKey : leafKey, 'base64');
    headers.signaturecertchainurl = CERT_URL;
  }
  const sent = signing === 'tampered' ? raw.replace('oat milk', 'oat milk and a television') : raw;
  return POST(new NextRequest('https://assistant-fixture.invalid/api/assistant/alexa', { method: 'POST', headers, body: sent }));
}

const speechOf = async (res: Response) =>
  ((await res.json()) as { response: { outputSpeech?: { text: string } } }).response.outputSpeech?.text ?? '';
const itemsOf = (family: string) => db.table('grocery_items').filter((r) => r.family_id === family).map((r) => r.name);
const CAPTURE = 'add oat milk to the shopping list';

describe('only a request Amazon signed is answered', () => {
  it.each(['unsigned', 'other-key', 'tampered'] as const)(`${ID} a %s request is a bare 403 with no speech, no database client and nothing written`, async (signing) => {
    const res = await send(envelope(CAPTURE), signing);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
  });

  it(`${ID} a genuinely signed request with no linked key speaks the linking prompt and touches no table`, async () => {
    const res = await send(envelope(CAPTURE, null));
    expect(res.status).toBe(200);
    expect(await speechOf(res)).toBe(ALEXA_NOT_LINKED_SPEECH);
    expect(String(mocks.fetchChain.mock.calls[0][0])).toBe(CERT_URL);
    expect(db.log).toEqual([]);
  });

  it.each(ROLES)(`${ID} a signed request carrying a key minted in a %s's name speaks the linking prompt and files nothing`, async (role) => {
    const res = await send(envelope(CAPTURE, keyFor(role)));
    expect(res.status).toBe(200);
    expect(await speechOf(res)).toBe(ALEXA_NOT_LINKED_SPEECH);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
    expect(db.table('assistant_link_events')).toEqual([]);
    expect(db.table('rate_limits')).toEqual([]);
  });
});

describe('a signed request with a parent\'s key, end to end', () => {
  it(`${ID} captures into its own household, records the event, stamps the key and counts a durable hit on the link`, async () => {
    const res = await send(envelope(CAPTURE));
    expect(res.status).toBe(200);
    const body = await res.json() as { version: string; response: { outputSpeech: { type: string; text: string }; shouldEndSession: boolean } };
    expect(body).toMatchObject({ version: '1.0', response: { outputSpeech: { type: 'PlainText' }, shouldEndSession: true } });
    expect(body.response.outputSpeech.text).toContain('shopping list');

    expect(itemsOf(FAMILY_A)).toEqual(['Bread', expect.stringMatching(/^oat milk$/i)]);
    expect(itemsOf(FAMILY_B)).toEqual(['Diapers']);
    expect(db.table('assistant_link_events')).toEqual([expect.objectContaining({ link_id: LINK_A, family_id: FAMILY_A, outcome: 'captured' })]);
    expect(db.table('assistant_links').find((l) => l.id === LINK_A)?.last_used_at).toEqual(expect.any(String));
    expect(db.table('rate_limits').map((r) => r.bucket_key)).toEqual([`assistant-alexa:${LINK_A}`]);
  });

  it(`${ID} speaks "too many requests" (200, not 429) once the link's durable bucket is full, and writes nothing`, async () => {
    const windowStart = Math.floor(Date.now() / 1000 / 60) * 60;
    db.seed('rate_limits', [{ bucket_key: `assistant-alexa:${LINK_A}`, window_start: windowStart, count: 60 }]);
    const res = await send(envelope(CAPTURE));
    expect(res.status).toBe(200);
    expect(await speechOf(res)).toMatch(/too many requests/i);
    expect(itemsOf(FAMILY_A)).toEqual(['Bread']);
    expect(db.table('assistant_link_events')).toEqual([]);
  });
});

describe('another household\'s key', () => {
  it(`${ID} household B's revoked key speaks the linking prompt; nothing of B's is spoken and nothing in B changes`, async () => {
    const res = await send(envelope("what's on the shopping list", KEY_B));
    expect(res.status).toBe(200);
    const speech = await speechOf(res);
    expect(speech).toBe(ALEXA_NOT_LINKED_SPEECH);
    expect(speech).not.toContain('Diapers');
    expect(itemsOf(FAMILY_B)).toEqual(['Diapers']);
    expect(db.table('assistant_link_events')).toEqual([]);
    expect(db.table('assistant_links').find((l) => l.id === LINK_B)?.last_used_at).toBeNull();
  });

  it(`${ID} household A's key reads A's list only, never B's items`, async () => {
    const speech = await speechOf(await send(envelope("what's on the shopping list")));
    expect(speech).toContain('Bread');
    expect(speech).not.toContain('Diapers');
  });
});

describe('a read that fails', () => {
  it(`${ID} the shopping-list read failing is spoken as the error sentence, never an empty list, and leaks no internal text`, async () => {
    mocks.admin.mockReturnValue(withFaults(db, (table, calls) =>
      table === 'grocery_items' && calls.some((c) => c.method === 'select') ? { message: 'relation grocery_items: connection reset by peer' } : null));
    const res = await send(envelope("what's on the shopping list"));
    expect(res.status).toBe(200);
    const speech = await speechOf(res);
    expect(speech).toBe(ERROR_SPEECH);
    expect(speech).not.toMatch(/connection reset|grocery_items|nothing on the shopping list/);
    expect(db.table('assistant_link_events')).toEqual([expect.objectContaining({ link_id: LINK_A, outcome: 'error' })]);
  });
});
