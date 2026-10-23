// A closed family's speaker key answers nothing (N6-S1).
//
// closeAccountAction stamps families.closed_at. The bearer context refuses a
// closed family for every Supabase-JWT route (account_closed), but a speaker
// does not hold a JWT: POST /api/assistant and the Alexa route resolve a
// `bub_asst_…` link key with lookupAssistantLink and then read the family on
// the service client. That lookup read families(timezone) and never closed_at,
// so after the account closed, a linked speaker kept reading the family's day
// aloud — and, with `capture`, filing into it.
//
// Both routes are driven for real here; only the service client is the
// in-memory store and Amazon's signature check is stubbed.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { hashAssistantToken } from '@/lib/assistant/link-token';
import { ALEXA_NOT_LINKED_SPEECH } from '@/lib/assistant/alexa';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), verifyAlexa: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/assistant/alexa-verify', async (original) => ({
  ...await original<typeof import('@/lib/assistant/alexa-verify')>(), verifyAlexaRequest: mocks.verifyAlexa,
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = 'user-parent';
const TOKEN = 'bub_asst_the-kitchen-speaker-secret-value';
const TASK = 'Renew the passports';

let db: InMemorySupabase;
let tablesRead: string[];

function seed(closedAt: string | null) {
  db.seed('families', [{ id: FAMILY, name: 'Home', timezone: 'UTC', closed_at: closedAt }]);
  db.seed('family_members', [
    { id: 'm-parent', family_id: FAMILY, user_id: PARENT, display_name: 'Parent', role: 'parent', is_active: true },
  ]);
  db.seed('assistant_links', [{
    id: 'link-1', family_id: FAMILY, user_id: PARENT, created_by: PARENT, provider: 'alexa', label: 'Kitchen',
    token_hash: hashAssistantToken(TOKEN), token_prefix: 'bub_asst_the', scopes: ['ask', 'capture'], revoked_at: null,
  }]);
  db.seed('todo_lists', [{ id: 'list-1', family_id: FAMILY, name: 'To do', archived_at: null }]);
  db.seed('todo_items', [{
    id: 'todo-1', family_id: FAMILY, list_id: 'list-1', title: TASK, is_done: false, due_date: '2026-01-01',
  }]);
}

beforeEach(() => {
  db = createInMemorySupabase();
  tablesRead = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((table: string) => { tablesRead.push(table); return from(table); }) as typeof db.from);
  mocks.admin.mockReset().mockReturnValue(db);
  mocks.verifyAlexa.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function ask(utterance: string) {
  const { POST } = await import('@/app/api/assistant/route');
  return POST(new NextRequest('https://assistant-fixture.invalid/api/assistant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ utterance }),
  }));
}

async function askAlexa(): Promise<string> {
  const { POST } = await import('@/app/api/assistant/alexa/route');
  const envelope = {
    request: { type: 'IntentRequest', intent: { name: 'AMAZON.HelpIntent' } },
    session: { user: { accessToken: TOKEN } },
  };
  const res = await POST(new NextRequest('https://assistant-fixture.invalid/api/assistant/alexa', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope),
  }));
  expect(res.status).toBe(200);
  const body = await res.json() as { response: { outputSpeech: { text?: string; ssml?: string } } };
  return body.response.outputSpeech.text ?? body.response.outputSpeech.ssml ?? '';
}

describe('POST /api/assistant with a closed family\'s key', () => {
  it('answers 401 like any key that is not linked, and reads none of the family\'s data', async () => {
    seed('2026-10-01T09:00:00Z');
    const res = await ask('what am I forgetting');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(tablesRead).not.toContain('todo_items');
    expect(db.table('assistant_events')).toHaveLength(0);
  });

  it('still answers for the same family while it is open (control)', async () => {
    seed(null);
    const res = await ask('what am I forgetting');
    expect(res.status).toBe(200);
    const body = await res.json() as { speech: string; outcome: string };
    expect(body.outcome).toBe('answered');
    expect(body.speech).toContain(TASK);
  });
});

describe('the Alexa route with a closed family\'s key', () => {
  it('speaks the not-linked prompt, not the family\'s answer', async () => {
    seed('2026-10-01T09:00:00Z');
    expect(await askAlexa()).toContain(ALEXA_NOT_LINKED_SPEECH);
  });

  it('still answers for the same family while it is open (control)', async () => {
    seed(null);
    expect(await askAlexa()).not.toContain(ALEXA_NOT_LINKED_SPEECH);
  });
});

describe('lookupAssistantLink', () => {
  it('reports a closed family\'s key as not linked, the answer every other dead key gets', async () => {
    const { lookupAssistantLink } = await import('@/lib/assistant/service');
    seed('2026-10-01T09:00:00Z');
    expect(await lookupAssistantLink(db as never, TOKEN)).toEqual({ status: 'not_linked' });
  });
});
