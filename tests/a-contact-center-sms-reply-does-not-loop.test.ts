import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { at } from './helpers/source-order';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), resolve: vi.fn(), channel: vi.fn(), planner: vi.fn(),
  concierge: vi.fn(), locale: vi.fn(), translations: vi.fn(), urgent: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/contact-center/server', async original => ({
  ...await original<typeof import('@/lib/contact-center/server')>(),
  resolveFamilyByNumberResult: mocks.resolve, getOrCreateChannelResult: mocks.channel, routeInboundToPlanner: mocks.planner,
}));
vi.mock('@/lib/contact-center/urgent-delivery', async original => ({
  ...await original<typeof import('@/lib/contact-center/urgent-delivery')>(), attemptUrgentDelivery: mocks.urgent,
}));
vi.mock('@/lib/contact-center/concierge', () => ({ runConcierge: mocks.concierge }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: mocks.locale, getTranslations: mocks.translations }));

// #771 comment 5983521433. Every inbound SMS is a new SID and got its own
// acknowledgement, so a long-code autoresponder — or another family's own
// Contact Center number — and a family number could trade texts forever: a
// paid SMS and a concierge call each pass. A family now acknowledges one
// number at most SMS_REPLIES_PER_SENDER_PER_DAY times a day, and never a
// Contact Center number; intake is unchanged.
// Real route, HMAC, ingress/reply helpers, intake and installed PostgREST client.
// Family routing, locale, AI, planner and urgent provider execution are isolated boundaries.
const ORIGIN = 'https://sms-ingress-route.example', PATH = '/api/contact-center/sms';
const TOKEN = 'synthetic-contact-center-ingress-token', ACCOUNT = `AC${'c'.repeat(32)}`;
const FAMILY = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const SID = `SM${'a'.repeat(32)}`, NOW = '2026-09-12T12:00:00.000Z';
const BASE = { From: '+15555550200', To: '+15555550100', Body: 'Synthetic appointment note', MessageSid: SID, AccountSid: ACCOUNT };
const CANDIDATE = { summary: 'A routine note', intent: 'appointment' as const, reply: 'A frozen reply', aiUsed: false };
type Row = Record<string, unknown>;
type Call = { table: string; method: string; url: URL; body: Row | null; signal: AbortSignal | null | undefined };
const clone = <T>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function matches(row: Row, url: URL): boolean {
  return [...url.searchParams].every(([key, filter]) => {
    const value = key.split(/->>?/).reduce<unknown>((current, part) =>
      current && typeof current === 'object' ? (current as Row)[part] : undefined, row);
    if (filter.startsWith('eq.')) {
      const wanted = filter.slice(3);
      return typeof value === 'object' && value !== null ? equal(value, JSON.parse(wanted)) : String(value) === wanted;
    }
    if (filter.startsWith('ilike.')) return String(value).toLowerCase() === filter.slice(6).toLowerCase();
    if (filter === 'is.null') return value === null;
    return true;
  });
}
function fixture() {
  const state = {
    tables: { ai_tool_calls: [], family_inbox_messages: [], families: [{ id: FAMILY, name: 'Ours' }],
      family_contact_channels: [{ family_id: FAMILY, phone_number: BASE.To, ai_concierge_enabled: true }] } as Record<string, Row[]>,
    calls: [] as Call[], events: [] as string[],
    before: undefined as ((call: Call) => void | Promise<void>) | undefined,
    after: undefined as ((call: Call, found: Row[]) => void | Promise<void>) | undefined,
    fail: undefined as ((call: Call) => boolean) | undefined,
    response: undefined as ((call: Call, found: Row[]) => unknown) | undefined,
  };
  const client = createClient<Database>('https://sms-ingress-route-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').pop()!;
      if (url.origin !== 'https://sms-ingress-route-fixture.invalid' || !(table in state.tables)) throw new Error('Unexpected fixture request');
      const call: Call = { table, method: init.method ?? 'GET', url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal };
      state.calls.push(call); state.events.push(`${call.method}:${table}`); await state.before?.(call);
      if (state.fail?.(call)) return Response.json({ code: '42501', message: 'Synthetic unavailable' }, { status: 403 });
      let found: Row[];
      if (call.method === 'POST') {
        const body = clone(call.body!);
        if (state.tables[table].some(row => body.id && row.id === body.id
          || table === 'ai_tool_calls' && row.family_id === body.family_id && row.idempotency_key === body.idempotency_key
          || table === 'family_inbox_messages' && body.provider_ref && row.channel === body.channel && row.provider_ref === body.provider_ref)) {
          return Response.json({ code: '23505', message: 'Synthetic unique conflict' }, { status: 409 });
        }
        const saved = { id: randomUUID(), created_at: NOW, updated_at: NOW,
          ...(table === 'ai_tool_calls' ? { locked_at: null, duration_ms: null, finished_at: null } : {}),
          ...(table === 'family_inbox_messages' ? { occurred_at: NOW, ai_handled: false, status: 'new' } : {}), ...body };
        state.tables[table].push(saved); found = [saved];
      } else {
        found = state.tables[table].filter(row => matches(row, url));
        if (call.method === 'PATCH') for (const row of found) Object.assign(row, clone(call.body));
        else if (call.method !== 'GET') throw new Error('Unexpected fixture method');
      }
      await state.after?.(call, found);
      const result = state.response ? state.response(call, found) : clone(found);
      return Response.json(result, { status: call.method === 'POST' ? 201 : 200,
        headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` } });
    } },
  });
  return { client, state };
}
let f: ReturnType<typeof fixture>;
function request(changes: Record<string, string> = {}, signature: 'valid' | 'forged' | 'missing' = 'valid') {
  const fields: Record<string, string> = { ...BASE, ...changes };
  const signed = ORIGIN + PATH + Object.keys(fields).sort().map(key => key + fields[key]).join('');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== 'missing') headers['x-twilio-signature'] = signature === 'valid'
    ? createHmac('sha1', TOKEN).update(signed).digest('base64') : 'forged';
  return new NextRequest(ORIGIN + PATH, { method: 'POST', headers, body: new URLSearchParams(fields) });
}
async function deliver(changes: Record<string, string> = {}, signature: 'valid' | 'forged' | 'missing' = 'valid') {
  return (await import('@/app/api/contact-center/sms/route')).POST(request(changes, signature));
}
const ingressRows = () => f.state.tables.ai_tool_calls.filter(row => row.tool_name === 'contact_center.sms_ingress');
const replyRows = () => f.state.tables.ai_tool_calls.filter(row => row.tool_name === 'contact_center.sms_reply');
const writes = () => f.state.calls.filter(call => call.method !== 'GET');
function resetCalls() { f.state.calls.length = 0; f.state.events.length = 0; vi.clearAllMocks(); }
async function oldReply(body = BASE.Body, smsSid = SID) {
  const { prepareSmsReply } = await import('@/lib/contact-center/sms-reply');
  return prepareSmsReply(f.client, { familyId: FAMILY, channelId: FAMILY, smsSid, from: BASE.From, to: BASE.To, body },
    async () => ({ summary: CANDIDATE.summary, intent: CANDIDATE.intent, reply: CANDIDATE.reply, locale: 'en-US', suppression: null }));
}
async function oldUrgent(smsSid = SID.toLowerCase()) {
  const { captureInboundWithUrgency } = await import('@/lib/contact-center/urgent-delivery');
  f.state.fail = call => call.table === 'family_inbox_messages' && call.method === 'POST';
  await expect(captureInboundWithUrgency(f.client, { familyId: FAMILY, channel: 'sms', providerRef: smsSid,
    from: BASE.From, to: BASE.To, body: BASE.Body, aiSummary: 'An older urgent note', aiIntent: 'urgent' })).rejects.toThrow();
  f.state.fail = undefined;
  expect(f.state.tables.family_inbox_messages).toEqual([]);
  const row = f.state.tables.ai_tool_calls.find(item => item.tool_name === 'contact_center.urgent_delivery');
  expect(row).toBeDefined();
  return clone(row!);
}
function reassign() {
  mocks.resolve.mockResolvedValue({ familyId: OTHER, error: null });
  f.state.tables.family_contact_channels[0].family_id = OTHER;
  f.state.tables.families = [{ id: OTHER, name: 'Other family' }];
}
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('TWILIO_AUTH_TOKEN', TOKEN); vi.stubEnv('TWILIO_ACCOUNT_SID', '');
  vi.stubEnv('TWILIO_PHONE_NUMBER', ''); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENAI_API_KEY', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  f = fixture(); mocks.admin.mockReturnValue(f.client);
  mocks.resolve.mockImplementation(async () => { f.state.events.push('routing'); return { familyId: FAMILY, error: null }; });
  mocks.channel.mockImplementation(async () => ({ data: clone(f.state.tables.family_contact_channels[0]), error: null }));
  mocks.concierge.mockImplementation(async () => { f.state.events.push('concierge'); return CANDIDATE; });
  mocks.locale.mockImplementation(async () => { f.state.events.push('locale'); return { locale: { code: 'en-US' } }; });
  mocks.translations.mockResolvedValue((key: string) => key);
  mocks.planner.mockImplementation(async (_admin, input: { messageId: string }) => {
    const row = f.state.tables.family_inbox_messages.find(item => item.id === input.messageId);
    if (row) row.ai_handled = true;
    return { routed: false, reason: 'not_actionable' };
  });
  mocks.urgent.mockRejectedValue(new Error('Unexpected urgent provider boundary'));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const sidN = (n: number) => `SM${n.toString(16).padStart(32, '0')}`;
const emitted = async (response: Response) => (await response.text()).includes('<Message');
const inboundRows = () => f.state.tables.family_inbox_messages.filter(row => row.direction === 'inbound');
const outboundRows = () => f.state.tables.family_inbox_messages.filter(row => row.direction === 'outbound');

describe('the SMS acknowledgement does not feed a loop', () => {
  it('an autoresponder answering every acknowledgement gets three replies a day, and every message is still filed', async () => {
    const replies: boolean[] = [];
    for (let n = 1; n <= 6; n++) replies.push(await emitted(await deliver({ MessageSid: sidN(n), Body: `Unrecognised reply ${n}` })));
    expect(replies).toEqual([true, true, true, false, false, false]);
    expect(inboundRows()).toHaveLength(6);
    expect(outboundRows()).toHaveLength(3);
    const reasons = replyRows().map(row => (row.outputs as Row).reason).filter(Boolean);
    expect(reasons).toEqual(['repeat_sender', 'repeat_sender', 'repeat_sender']);
  }, 20_000);

  it('another family\'s Contact Center number is filed and never acknowledged', async () => {
    f.state.tables.family_contact_channels.push({ family_id: OTHER, phone_number: BASE.From, ai_concierge_enabled: true });
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await emitted(response)).toBe(false);
    expect(inboundRows()).toHaveLength(1);
    expect(outboundRows()).toEqual([]);
    expect(replyRows()[0].outputs).toMatchObject({ phase: 'suppressed', reason: 'bubaly_sender' });
  });

  it('a count that cannot be read sends nothing rather than risk the loop', async () => {
    f.state.fail = call => call.table === 'family_inbox_messages' && call.method === 'GET' && call.url.searchParams.has('to_addr');
    const response = await deliver();
    expect(response.status).toBe(200);
    expect(await emitted(response)).toBe(false);
    expect(inboundRows()).toHaveLength(1);
    expect(outboundRows()).toEqual([]);
  });

  it('control: a number this family has not answered today is acknowledged', async () => {
    f.state.tables.family_inbox_messages.push(
      { id: randomUUID(), family_id: FAMILY, channel: 'sms', direction: 'outbound', from_addr: BASE.To, to_addr: '+15555550999', body: 'x', occurred_at: NOW },
    );
    expect(await emitted(await deliver())).toBe(true);
    expect(outboundRows()).toHaveLength(2);
  });
});
