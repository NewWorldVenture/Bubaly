// POST /api/contact-center/voice/transcription (Register B API-B4E47347CDDF),
// the Twilio transcribeCallback for a Contact Center voicemail, driven through
// the real exported handler over the in-memory database seeded with two
// households.
//
// The caller is Twilio, so member roles are n/a (public webhook). The household
// is the `familyId` query parameter the voice route wrote into the TwiML, and
// Twilio signs the full URL, so the signature is what binds the voicemail to a
// household. Already proven elsewhere: tests/contact-center-callback-boundary.
// test.ts → invalid signature 401 through middleware, file-once and replay,
// handled-state read failure 503, dedupe against a foreign-family row 503,
// urgent escalation once, empty acknowledgements; tests/an-inbound-text-or-
// voicemail-is-budgeted.test.ts → concierge budgets; tests/an-outside-sender-
// cannot-run-bubaly.test.ts → a voicemail is never planned.
// Added here: an UNSIGNED callback, a signature under another token, a callback
// signed for household B whose familyId was rewritten to A, the filed row read
// back across both households, and a failed household read.
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), concierge: vi.fn(), submit: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/ai/runs/intake', () => ({ submitRequest: mocks.submit }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));

const ORIGIN = 'https://bubaly.example';
const PATH = '/api/contact-center/voice/transcription';
const TOKEN = 'test-fake-twilio-token';
const A = { family: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Household Alpha', number: '+15555550100' };
const B = { family: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Household Bravo', number: '+15555550110' };
const CALLER = '+15555550123';
const RECORDING = `RE${'1'.repeat(32)}`;
let db: ReturnType<typeof createInMemorySupabase>;

function form(fields: Record<string, string> = {}) {
  return { To: A.number, From: CALLER, RecordingSid: RECORDING, TranscriptionText: 'Please call back about the school pickup.', ...fields };
}
/** `family` is the familyId in the URL sent; `signedFamily` the one inside the signed URL. */
function request(params: Record<string, string>, family: string, options: { signWith?: string | null; signedFamily?: string } = {}) {
  const signWith = options.signWith === undefined ? TOKEN : options.signWith;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const signedUrl = `${ORIGIN}${PATH}?familyId=${options.signedFamily ?? family}`;
  if (signWith) headers['x-twilio-signature'] = createHmac('sha1', signWith)
    .update(signedUrl + Object.keys(params).sort().map(key => key + params[key]).join('')).digest('base64');
  return new NextRequest(`${ORIGIN}${PATH}?familyId=${family}`, { method: 'POST', headers, body: new URLSearchParams(params) });
}
async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/contact-center/voice/transcription/route');
  return POST(req);
}
const householdRows = (family: string) => ['family_inbox_messages', 'ai_tool_calls', 'notifications', 'family_contact_channels']
  .flatMap(table => db.table(table).filter(row => row.family_id === family).map(row => ({ table, row: structuredClone(row) })));

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN);
  vi.stubEnv('INTERNAL_SECRET', 'test-fake-internal-secret');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db = createInMemorySupabase({
    uniques: { notifications: [['id']], ai_tool_calls: [['id'], ['family_id', 'idempotency_key']], family_inbox_messages: [['channel', 'provider_ref']] },
    defaults: { family_inbox_messages: { ai_handled: false, direction: 'inbound', status: 'new', occurred_at: '2026-09-12T00:00:00.000Z' } },
    rpc: { rate_limit_hit: rateLimitHit },
  });
  db.seed('families', [{ id: A.family, name: A.name, timezone: 'UTC' }, { id: B.family, name: B.name, timezone: 'UTC' }]);
  db.seed('family_contact_channels', [
    { id: 'channel-a', family_id: A.family, phone_number: A.number, email_local: 'alpha', ai_concierge_enabled: true, forward_to_phone: null },
    { id: 'channel-b', family_id: B.family, phone_number: B.number, email_local: 'bravo', ai_concierge_enabled: true, forward_to_phone: null },
  ]);
  db.seed('family_inbox_messages', [{ id: 'bbbbbbbb-0000-4000-8000-0000000000b1', family_id: B.family, channel: 'voice', direction: 'inbound',
    from_addr: CALLER, to_addr: B.number, body: 'Bravo private voicemail', subject: 'Voicemail', ai_summary: 'Bravo summary', ai_intent: 'other',
    ai_handled: false, status: 'new', provider_ref: `RE${'b'.repeat(32)}`, occurred_at: '2026-09-11T00:00:00.000Z' }]);
  mocks.admin.mockReturnValue(db);
  mocks.concierge.mockResolvedValue({ intent: 'school', summary: 'School pickup call-back', reply: 'Thanks', aiUsed: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('who may call it: only a callback Twilio signed (roles n/a, public webhook)', () => {
  it.each([
    ['API-B4E47347CDDF an unsigned transcription callback is refused with 401 and files nothing', () => request(form(), A.family, { signWith: null })],
    ['API-B4E47347CDDF a transcription signed with another auth token is refused with 401 and files nothing', () => request(form(), A.family, { signWith: 'test-fake-other-token' })],
    ['API-B4E47347CDDF a callback signed for household B whose familyId was rewritten to household A is refused with 401', () => request(form(), A.family, { signedFamily: B.family })],
  ])('%s', async (_title, build) => {
    const beforeA = householdRows(A.family), beforeB = householdRows(B.family);
    const response = await post(build());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(householdRows(A.family)).toEqual(beforeA);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(db.table('rate_limits')).toHaveLength(0);
  });
});

describe('a correctly signed transcription end to end', () => {
  it('API-B4E47347CDDF files the voicemail for the household its signed callback names, answers a bodyless 204, and leaves household B untouched', async () => {
    const beforeB = householdRows(B.family);
    const response = await post(request(form(), A.family));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const filed = db.table('family_inbox_messages').filter(row => row.family_id === A.family);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ channel: 'voice', direction: 'inbound', subject: 'Voicemail', from_addr: CALLER, to_addr: A.number,
      body: 'Please call back about the school pickup.', provider_ref: RECORDING, ai_summary: 'School pickup call-back', ai_intent: 'school', ai_handled: false });
    expect(mocks.concierge).toHaveBeenCalledOnce();
    expect(mocks.concierge.mock.calls[0][0]).toMatchObject({ channel: 'voice', from: CALLER, familyLabel: A.name });
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('another household’s ids', () => {
  it('API-B4E47347CDDF a signed callback for household A carrying household B’s RecordingSid answers 503, files nothing for A and leaves B’s voicemail as it was', async () => {
    const beforeB = householdRows(B.family);
    const response = await post(request(form({ RecordingSid: `RE${'b'.repeat(32)}` }), A.family));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toBe('Inbox temporarily unavailable');
    expect(db.table('family_inbox_messages').filter(row => row.family_id === A.family)).toHaveLength(0);
    expect(householdRows(B.family)).toEqual(beforeB);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('API-B4E47347CDDF a failed household read answers 503 without its error text and files nothing', async () => {
    mocks.admin.mockReturnValue(withFaults(db, table => (table === 'families' ? { message: 'test-fake private family diagnostic' } : null)));
    const response = await post(request(form(), A.family));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Contact Center temporarily unavailable');
    expect(db.table('family_inbox_messages').filter(row => row.family_id === A.family)).toHaveLength(0);
    expect(mocks.concierge).not.toHaveBeenCalled();
  });
});
