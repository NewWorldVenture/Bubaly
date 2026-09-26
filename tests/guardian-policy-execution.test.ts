import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { GuardianPolicyUnavailableError, runDecisionPipeline } from '@/lib/guardian/pipeline';
import * as scam from '@/lib/guardian/scam';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const RULE = '44444444-4444-4444-8444-444444444444';
const INPUT = { callerPhone: '+15555550200', callerName: null, familyId: FAMILY, memberId: MEMBER };
const TABLES = ['guardian_contacts', 'guardian_member_profiles', 'guardian_routing_rules'] as const;
type Table = typeof TABLES[number];
type Row = Record<string, unknown>;
type Read = { url: URL; signal?: AbortSignal | null; headers: Headers };
const STAGE = { guardian_contacts: 'contact', guardian_member_profiles: 'profile', guardian_routing_rules: 'rules' } as const;
function contact(overrides: Row = {}): Row {
  return { id: CONTACT, family_id: FAMILY, phone: INPUT.callerPhone, name: 'Synthetic contact', trust_level: 'blocked', spam_score: 90, ...overrides };
}
function profile(overrides: Row = {}): Row {
  return {
    id: MEMBER, family_id: FAMILY, member_id: MEMBER, is_active: true, ai_persona_name: 'Synthetic Guardian', ai_greeting_template: null,
    current_context: 'normal', guardian_phone: '+15555550100', voicemail_greeting: null, context_overrides: {},
    default_mode_immediate: 'immediate_ring', default_mode_close: 'immediate_ring', default_mode_trusted: 'immediate_ai_summary',
    default_mode_known: 'ai_handle_first', default_mode_unknown: 'voicemail_first', default_mode_suspected_spam: 'silent_handling', default_mode_blocked: 'blocked',
    ...overrides,
  };
}
function rule(overrides: Row = {}): Row {
  return {
    id: RULE, family_id: FAMILY, member_id: MEMBER, name: 'Synthetic block rule', priority: 1, is_active: true,
    condition_contact_id: null, condition_trust_levels: null, condition_time_start: null, condition_time_end: null,
    condition_days_of_week: null, condition_contexts: null, condition_caller_pattern: null, action_routing_mode: 'blocked', action_notify_members: null,
    ...overrides,
  };
}

function fixture(overrides: Partial<Record<Table, (read: Read) => Response | Promise<Response>>> = {}) {
  const calls: Read[] = [];
  const client = createClient('https://guardian-policy-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const read = { url: new URL(String(raw)), signal: init.signal, headers: new Headers(init.headers) };
      calls.push(read);
      const table = read.url.pathname.split('/').at(-1) as Table;
      if (!TABLES.includes(table) || (init.method ?? 'GET') !== 'GET') throw new Error('Unexpected policy fixture request');
      return overrides[table]?.(read) ?? rows([]);
    } },
  });
  return { client, calls };
}
function rows(data: Row[], count: number | null = data.length) {
  return Response.json(data, { headers: count === null ? {} : { 'content-range': `0-${Math.max(0, data.length - 1)}/${count}` } });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Guardian policy reads through the installed PostgREST SDK', () => {
  it.each(TABLES)('does not route when %s returns a required-read failure', async table => {
    const { client, calls } = fixture({ [table]: () => Response.json({ code: '42501', message: 'Synthetic policy unavailable' }, { status: 503, headers: { 'retry-after': '0' } }) });
    const screening = vi.spyOn(scam, 'detectScamFromText');
    await expect(runDecisionPipeline(client, { ...INPUT, initialTranscript: 'emergency help me' })).rejects.toEqual(new GuardianPolicyUnavailableError(STAGE[table]));
    expect(screening).not.toHaveBeenCalled();
    expect(calls.filter(call => call.url.pathname.endsWith(table))).toHaveLength(1);
  });

  it.each(TABLES)('contains a thrown %s transport failure without routing', async table => {
    const { client } = fixture({ [table]: () => { throw new Error('Synthetic transport failed'); } });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError(STAGE[table]));
  });

  for (const [label, response] of [
    ['missing count', () => rows([], null)],
    ['unavailable row body', () => Response.json(null, { headers: { 'content-range': '*/0' } })],
    ['non-array row body', () => Response.json({}, { headers: { 'content-range': '*/0' } })],
    ['malformed row', () => Response.json([null], { headers: { 'content-range': '0-0/1' } })],
    ['incomplete receipt', () => rows([], 1)],
    ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json', 'content-range': '*/0' } })],
  ] as const) {
    it.each(TABLES)(`rejects ${label} from %s`, async table => {
      const { client } = fixture({ [table]: response });
      await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError(STAGE[table]));
    });
  }

  it.each([
    ['wrong family', { family_id: MEMBER }], ['wrong phone', { phone: '+15555550999' }], ['invalid id', { id: 'wrong' }],
    ['invalid trust', { trust_level: 'always_safe' }], ['invalid spam score', { spam_score: 101 }], ['missing spam score', { spam_score: undefined }],
  ])('rejects contact %s', async (_label, overrides) => {
    const { client } = fixture({ guardian_contacts: () => rows([contact(overrides as Row)]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('contact'));
  });
  it('rejects duplicate contact receipts', async () => {
    const { client } = fixture({ guardian_contacts: () => rows([contact(), contact({ id: RULE })]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('contact'));
  });

  it.each([
    ['wrong family', { family_id: MEMBER }], ['wrong member', { member_id: FAMILY }], ['inactive row', { is_active: false }],
    ['missing default', { default_mode_unknown: undefined }], ['invalid override', { context_overrides: { sleeping: 'ring_anyway' } }],
    ['missing overrides', { context_overrides: null }], ['invalid context', { current_context: 'anything' }],
  ])('rejects profile %s', async (_label, overrides) => {
    const { client } = fixture({ guardian_member_profiles: () => rows([profile(overrides as Row)]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('profile'));
  });
  it('rejects duplicate active profiles', async () => {
    const { client } = fixture({ guardian_member_profiles: () => rows([profile(), profile({ id: RULE })]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('profile'));
  });

  it.each([
    ['wrong family', { family_id: MEMBER }], ['wrong member', { member_id: FAMILY }], ['inactive row', { is_active: false }],
    ['invalid route', { action_routing_mode: 'ring_anyway' }], ['missing condition', { condition_contact_id: undefined }],
    ['invalid trust filter', { condition_trust_levels: ['always_safe'] }], ['invalid day', { condition_days_of_week: [7] }],
    ['invalid time', { condition_time_start: 'tomorrow' }], ['invalid priority', { priority: 'first' }],
    ['invalid notification member', { action_notify_members: ['wrong'] }],
  ])('rejects rule %s', async (_label, overrides) => {
    const { client } = fixture({ guardian_routing_rules: () => rows([rule(overrides as Row)]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('rules'));
  });
  it('rejects duplicate rule IDs rather than treating them as complete policy', async () => {
    const { client } = fixture({ guardian_routing_rules: () => rows([rule(), rule()]) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('rules'));
  });
  it('rejects a rule receipt truncated by the server row limit', async () => {
    const { client } = fixture({ guardian_routing_rules: () => rows([rule()], 1001) });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('rules'));
  });

  it('preserves verified absence and scopes every required query', async () => {
    const { client, calls } = fixture();
    await expect(runDecisionPipeline(client, INPUT)).resolves.toMatchObject({ routingMode: 'ai_handle_first', trustLevel: 'unknown', memberProfile: null });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);
      expect(call.headers.get('prefer')).toContain('count=exact');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.find(call => call.url.pathname.endsWith('guardian_contacts'))?.url.searchParams.get('phone')).toBe(`eq.${INPUT.callerPhone}`);
    expect(calls.find(call => call.url.pathname.endsWith('guardian_member_profiles'))?.url.searchParams.get('member_id')).toBe(`eq.${MEMBER}`);
    expect(calls.find(call => call.url.pathname.endsWith('guardian_routing_rules'))?.url.searchParams.get('or')).toBe(`(member_id.is.null,member_id.eq.${MEMBER})`);
  });
  it('skips absent caller/member lookups and still verifies family rules', async () => {
    const { client, calls } = fixture({ guardian_routing_rules: () => rows([rule({ member_id: null })]) });
    await expect(runDecisionPipeline(client, { ...INPUT, callerPhone: null, memberId: null })).resolves.toMatchObject({ routingMode: 'blocked', ruleId: RULE });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('or')).toBe('(member_id.is.null)');
  });
  it('preserves healthy blocked contacts and profile context overrides', async () => {
    const first = fixture({ guardian_contacts: () => rows([contact()]) });
    await expect(runDecisionPipeline(first.client, INPUT)).resolves.toMatchObject({ routingMode: 'blocked', trustLevel: 'blocked', contactId: CONTACT });
    const second = fixture({ guardian_member_profiles: () => rows([profile({ current_context: 'sleeping', context_overrides: { sleeping: 'silent_handling' } })]) });
    await expect(runDecisionPipeline(second.client, INPUT)).resolves.toMatchObject({ routingMode: 'silent_handling' });
  });
  it('preserves clean member/family rule priority over profile defaults', async () => {
    const { client } = fixture({
      guardian_member_profiles: () => rows([profile()]),
      guardian_routing_rules: () => rows([rule({ priority: 20, action_routing_mode: 'immediate_ring' }), rule({ id: CONTACT, member_id: null, priority: 1 })]),
    });
    await expect(runDecisionPipeline(client, INPUT)).resolves.toMatchObject({ routingMode: 'blocked', ruleId: CONTACT });
  });
  it('preserves schema-valid unset profile context and emergency behavior after healthy reads', async () => {
    const { client } = fixture({ guardian_member_profiles: () => rows([profile({ current_context: null })]) });
    await expect(runDecisionPipeline(client, INPUT)).resolves.toMatchObject({ routingMode: 'voicemail_first', memberProfile: { current_context: 'normal' } });
    await expect(runDecisionPipeline(client, { ...INPUT, initialTranscript: 'please help me this is an emergency' })).resolves.toMatchObject({ routingMode: 'immediate_ring', shouldEscalate: true });
  });

  it.each(TABLES)('aborts pending %s and ignores a late successful response', async table => {
    vi.useFakeTimers();
    let release!: (value: Response) => void;
    const { client, calls } = fixture({ [table]: () => new Promise<Response>(resolve => { release = resolve; }) });
    const screening = vi.spyOn(scam, 'detectScamFromText');
    const routed = vi.fn();
    const result = runDecisionPipeline(client, { ...INPUT, initialTranscript: 'emergency help me' }).then(routed, error => error);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toEqual(new GuardianPolicyUnavailableError(STAGE[table]));
    expect(calls.every(call => call.signal?.aborted)).toBe(true);
    release(rows([]));
    await vi.advanceTimersByTimeAsync(1);
    expect(routed).not.toHaveBeenCalled();
    expect(screening).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts other pending policy reads immediately when one read fails', async () => {
    const { client, calls } = fixture({
      guardian_contacts: () => Response.json({ message: 'Synthetic denial' }, { status: 403 }),
      guardian_routing_rules: ({ signal }) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    });
    await expect(runDecisionPipeline(client, INPUT)).rejects.toEqual(new GuardianPolicyUnavailableError('contact'));
    expect(calls.every(call => call.signal?.aborted)).toBe(true);
  });
});
