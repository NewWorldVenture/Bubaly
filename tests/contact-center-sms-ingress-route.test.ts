import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';

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

describe('signed SMS ingress route with installed PostgREST transport', () => {
  it.each(['production', 'development', 'test'] as const)('rejects forged signatures before any family access in %s', async environment => {
    vi.stubEnv('NODE_ENV', environment);
    expect((await deliver({}, 'forged')).status).toBe(401);
    expect((await deliver({}, 'missing')).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(f.state.calls).toEqual([]);
  });

  it('captures the signed original before context and AI, then emits once through the existing reply reservation', async () => {
    const first = await deliver(); expect(first.status).toBe(200); expect(await first.text()).toContain('>A frozen reply</Message>');
    expect(ingressRows()).toHaveLength(1); expect(replyRows()).toHaveLength(1);
    expect((replyRows()[0].outputs as Row).phase).toBe('emission_reserved');
    const ingress = clone(ingressRows()[0]);
    const captureAt = f.state.events.indexOf('POST:ai_tool_calls');
    expect(captureAt).toBeLessThan(f.state.events.indexOf('GET:families'));
    expect(captureAt).toBeLessThan(f.state.events.indexOf('concierge'));
    expect(captureAt).toBeLessThan(f.state.events.indexOf('locale'));
    expect(f.state.events[0]).toBe('GET:ai_tool_calls');
    resetCalls();
    const replay = await deliver(); expect(replay.status).toBe(200); expect(await replay.text()).not.toContain('<Message');
    expect(ingressRows()).toEqual([ingress]); expect(writes()).toEqual([]);
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(mocks.planner).not.toHaveBeenCalled();
    expect(f.state.tables.family_inbox_messages.map(row => row.direction).sort()).toEqual(['inbound', 'outbound']);
  });

  it('retains ingress when the family-label read fails, then completes the exact retry', async () => {
    f.state.fail = call => call.table === 'families';
    expect((await deliver()).status).toBe(503); expect(ingressRows()).toHaveLength(1);
    const saved = clone(ingressRows()[0]);
    expect(replyRows()).toEqual([]); expect(f.state.tables.family_inbox_messages).toEqual([]);
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(mocks.locale).not.toHaveBeenCalled();
    f.state.fail = undefined;
    const retried = await deliver(); expect(retried.status).toBe(200); expect(await retried.text()).toContain('<Message');
    expect(ingressRows()).toEqual([saved]);
  });

  it('retains ingress and files deterministic intake after locale failure without emitting a reply', async () => {
    mocks.locale.mockRejectedValueOnce(new Error('Synthetic locale unavailable'));
    const response = await deliver();
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('<Message');
    expect(ingressRows()).toHaveLength(1); expect(replyRows()).toEqual([]);
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
    expect(f.state.tables.family_inbox_messages[0]).toMatchObject({ direction: 'inbound', body: BASE.Body, ai_handled: true });
    const retained = clone(ingressRows()[0]), intake = clone(f.state.tables.family_inbox_messages);
    const replay = await deliver(); expect(replay.status).toBe(200); expect(await replay.text()).not.toContain('<Message');
    expect(ingressRows()).toEqual([retained]); expect(f.state.tables.family_inbox_messages).toEqual(intake);
    expect(replyRows()[0].outputs).toMatchObject({ phase: 'legacy_unknown' });
  });

  it('retains ingress on the real candidate timeout and rejects an ignored-abort late result before a valid retry', async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => originalTimeout(ms === 15_000 ? 30 : ms));
    let release!: () => void;
    mocks.concierge.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(CANDIDATE); }));
    const response = await deliver(); expect(response.status).toBe(200); expect(await response.text()).not.toContain('<Message');
    expect(ingressRows()).toHaveLength(1); expect(replyRows()).toEqual([]); expect(f.state.tables.family_inbox_messages).toHaveLength(1);
    const intake = clone(f.state.tables.family_inbox_messages);
    const retained = clone(ingressRows()[0]);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(ingressRows()).toEqual([retained]); expect(replyRows()).toEqual([]); expect(f.state.tables.family_inbox_messages).toEqual(intake);
    const retry = await deliver(); expect(retry.status).toBe(200); expect(await retry.text()).not.toContain('<Message');
    expect(ingressRows()).toEqual([retained]); expect(replyRows()).toHaveLength(1);
    expect(replyRows()[0].outputs).toMatchObject({ phase: 'legacy_unknown' });
    expect(f.state.tables.family_inbox_messages).toEqual(intake);
  });

  it.each([
    ['different body', BASE.Body, 'A different signed note'],
    ['same stored truncation', 'x'.repeat(4096) + ' original tail', 'x'.repeat(4096) + ' altered tail'],
    ['same normalized scalar', 'A\0B', 'A\ufffdB'],
  ])('rejects an altered signed replay with %s before routing or new writes', async (_name, original, altered) => {
    f.state.fail = call => call.table === 'families';
    expect((await deliver({ Body: original })).status).toBe(503);
    const saved = clone(ingressRows()); expect(saved).toHaveLength(1);
    f.state.fail = undefined; resetCalls();
    expect((await deliver({ Body: altered })).status).toBe(503);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.concierge).not.toHaveBeenCalled();
    expect(writes()).toEqual([]); expect(ingressRows()).toEqual(saved); expect(replyRows()).toEqual([]);
  });

  const envelopeChanges: Record<string, string>[] = [{ From: '+15555550300' }, { To: '+15555550400' }, { AccountSid: `AC${'d'.repeat(32)}` }];
  it.each(envelopeChanges)(
    'rejects a signed replay with changed provider envelope %j before family routing', async changes => {
      f.state.fail = call => call.table === 'families'; expect((await deliver()).status).toBe(503);
      resetCalls(); expect((await deliver(changes)).status).toBe(503);
      expect(mocks.resolve).not.toHaveBeenCalled(); expect(writes()).toEqual([]); expect(ingressRows()).toHaveLength(1);
    });

  it('does not grant the reassigned family an ingress or reply for the old signed SID', async () => {
    f.state.fail = call => call.table === 'families'; expect((await deliver()).status).toBe(503);
    const saved = clone(ingressRows()); f.state.fail = undefined; reassign(); resetCalls();
    expect((await deliver()).status).toBe(503); expect(ingressRows()).toEqual(saved); expect(writes()).toEqual([]);
    expect(mocks.channel).not.toHaveBeenCalled(); expect(mocks.concierge).not.toHaveBeenCalled();
  });

  it('holds a retained message while its original number is no longer assigned', async () => {
    f.state.fail = call => call.table === 'families'; expect((await deliver()).status).toBe(503);
    mocks.resolve.mockResolvedValue({ familyId: null, error: null }); resetCalls();
    expect((await deliver()).status).toBe(503); expect(writes()).toEqual([]); expect(ingressRows()).toHaveLength(1);
  });

  it('recovers an ingress insert whose committed response was lost without duplicating authority', async () => {
    let lost = false;
    f.state.after = call => {
      if (!lost && call.method === 'POST' && call.body?.tool_name === 'contact_center.sms_ingress') {
        lost = true; throw new Error('Synthetic committed response loss');
      }
    };
    const response = await deliver(); expect(response.status).toBe(200); expect(await response.text()).toContain('<Message');
    expect(lost).toBe(true); expect(ingressRows()).toHaveLength(1); expect(replyRows()).toHaveLength(1);
    expect(f.state.calls.filter(call => call.body?.tool_name === 'contact_center.sms_ingress')).toHaveLength(1);
    expect(await (await deliver()).text()).not.toContain('<Message');
  });

  it('fails closed on an initial authority read error without routing or intake', async () => {
    f.state.fail = call => call.table === 'ai_tool_calls';
    expect((await deliver()).status).toBe(503); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });

  it('rejects a malformed row occupying the global SID identity rather than treating it as absence', async () => {
    const { smsIngressReceiptId } = await import('@/lib/contact-center/sms-ingress');
    f.state.tables.ai_tool_calls.push({ id: smsIngressReceiptId(SID), family_id: OTHER, tool_name: 'foreign.namespace' });
    expect((await deliver()).status).toBe(503); expect(mocks.resolve).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });

  it('continues an exact old reply with case-equivalent SID without inventing its lost original-body digest', async () => {
    const legacy = await oldReply('x'.repeat(4096), SID.toLowerCase()); const inputs = clone(replyRows()[0].inputs);
    resetCalls();
    const response = await deliver({ Body: 'x'.repeat(4096) + ' historical tail cannot be reconstructed' });
    expect(response.status).toBe(200); expect(await response.text()).toContain('>A frozen reply</Message>');
    expect(ingressRows()).toEqual([]); expect(replyRows()[0]).toMatchObject({ id: legacy.id, inputs });
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(mocks.locale).not.toHaveBeenCalled();
    expect((f.state.tables.family_inbox_messages.find(row => row.direction === 'inbound'))?.provider_ref).toBe(SID.toLowerCase());
  });

  it('rejects an old reply from the previous family before creating replacement-family history', async () => {
    await oldReply(); const saved = clone(replyRows()); reassign(); resetCalls();
    expect((await deliver()).status).toBe(503); expect(ingressRows()).toEqual([]); expect(replyRows()).toEqual(saved);
    expect(writes()).toEqual([]); expect(mocks.channel).not.toHaveBeenCalled(); expect(mocks.concierge).not.toHaveBeenCalled();
  });

  it.each(['read failure', 'malformed receipt', 'duplicate receipt'] as const)('holds a pre-ingress legacy %s before effects', async fault => {
    await oldReply();
    if (fault === 'read failure') f.state.fail = call => call.url.searchParams.get('tool_name') === 'eq.contact_center.sms_reply';
    if (fault === 'malformed receipt') replyRows()[0].actor_kind = 'user';
    if (fault === 'duplicate receipt') f.state.tables.ai_tool_calls.push(clone(replyRows()[0]));
    resetCalls(); expect((await deliver()).status).toBe(503); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(ingressRows()).toEqual([]); expect(writes()).toEqual([]);
  });

  it('restores older urgent-only intake with its original SID case while retaining automatic-reply suppression', async () => {
    const urgent = await oldUrgent(); mocks.urgent.mockResolvedValue('in_app_only'); resetCalls();
    const response = await deliver(); expect(response.status).toBe(200); expect(await response.text()).not.toContain('<Message');
    expect(ingressRows()).toEqual([]); expect(replyRows()).toHaveLength(1);
    expect(replyRows()[0].outputs).toMatchObject({ phase: 'legacy_unknown', emissionToken: null });
    expect(f.state.tables.family_inbox_messages).toHaveLength(1);
    expect(f.state.tables.family_inbox_messages[0]).toMatchObject({ family_id: FAMILY, provider_ref: SID.toLowerCase(),
      direction: 'inbound', body: BASE.Body, ai_summary: 'An older urgent note', ai_intent: 'urgent', ai_handled: true });
    expect(f.state.tables.ai_tool_calls.find(row => row.id === urgent.id)).toEqual(urgent);
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(mocks.locale).not.toHaveBeenCalled();
    expect(mocks.urgent).toHaveBeenCalledExactlyOnceWith(f.client, urgent.id, FAMILY);
    expect(mocks.planner).toHaveBeenCalledOnce();
    resetCalls(); expect(await (await deliver()).text()).not.toContain('<Message');
    expect(writes()).toEqual([]); expect(mocks.planner).not.toHaveBeenCalled(); expect(mocks.concierge).not.toHaveBeenCalled();
  });

  it('holds a foreign older urgent-only receipt before intake or a new-family candidate', async () => {
    const urgent = await oldUrgent(); reassign(); resetCalls();
    expect((await deliver()).status).toBe(503); expect(writes()).toEqual([]);
    expect(ingressRows()).toEqual([]); expect(replyRows()).toEqual([]);
    expect(f.state.tables.ai_tool_calls).toEqual([urgent]); expect(f.state.tables.family_inbox_messages).toEqual([]);
    expect(mocks.concierge).not.toHaveBeenCalled(); expect(mocks.urgent).not.toHaveBeenCalled();
  });

  it.each(['read failure', 'malformed receipt', 'duplicate receipt', 'altered body'] as const)(
    'holds an older urgent-only %s before household effects', async fault => {
      await oldUrgent();
      if (fault === 'read failure') f.state.fail = call => call.url.searchParams.get('tool_name') === 'eq.contact_center.urgent_delivery';
      if (fault === 'malformed receipt') f.state.tables.ai_tool_calls[0].actor_kind = 'user';
      if (fault === 'duplicate receipt') f.state.tables.ai_tool_calls.push(clone(f.state.tables.ai_tool_calls[0]));
      resetCalls(); expect((await deliver(fault === 'altered body' ? { Body: 'Altered signed urgent note' } : {})).status).toBe(503);
      expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.concierge).not.toHaveBeenCalled();
      expect(ingressRows()).toEqual([]); expect(replyRows()).toEqual([]); expect(writes()).toEqual([]);
    });

  it('allows a signed unknown number acknowledgment without inventing a household', async () => {
    mocks.resolve.mockResolvedValue({ familyId: null, error: null });
    const response = await deliver(); expect(response.status).toBe(200); expect(await response.text()).not.toContain('<Message');
    expect(writes()).toEqual([]); expect(mocks.concierge).not.toHaveBeenCalled();
  });

  it('keeps signed opt-out controls outside intake and automatic reply', async () => {
    const response = await deliver({ OptOutType: 'STOP' }); expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('<Message'); expect(mocks.admin).not.toHaveBeenCalled();
  });
});
