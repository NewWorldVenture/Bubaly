import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';

// Install hard network barriers before importing any action or provider module.
// These guards count ATTEMPTS, so a caught transport exception still fails.
const network = await vi.hoisted(async () => {
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const attempts = { fetch: 0, http: 0, https: 0, socket: 0, tls: 0 };
  const deny = (kind: keyof typeof attempts) => () => { attempts[kind]++; throw new Error(`Unexpected ${kind} network attempt`); };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(deny('fetch'));
  const guards = [
    vi.spyOn(http, 'request').mockImplementation(deny('http')),
    vi.spyOn(http, 'get').mockImplementation(deny('http')),
    vi.spyOn(https, 'request').mockImplementation(deny('https')),
    vi.spyOn(https, 'get').mockImplementation(deny('https')),
    vi.spyOn(net, 'connect').mockImplementation(deny('socket')),
    vi.spyOn(net, 'createConnection').mockImplementation(deny('socket')),
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(deny('socket')),
    vi.spyOn(tls, 'connect').mockImplementation(deny('tls')),
  ];
  return { attempts, restore() { guards.forEach(guard => guard.mockRestore()); globalThis.fetch = originalFetch; } };
});


const mock = vi.hoisted(() => ({
  auth: vi.fn(), serviceFactory: vi.fn(), capabilities: vi.fn(), translations: vi.fn(),
  cardholder: vi.fn(), issue: vi.fn(), audit: vi.fn(), revalidate: vi.fn(),
  ledgerWriter: vi.fn(), ledgerFrom: vi.fn(), ledgerInsert: vi.fn(),
  forbiddenFactory: vi.fn(), forbiddenProvider: vi.fn(), forbiddenWriter: vi.fn(),
  stripeModuleLoads: 0, stripeInitializations: 0, sdkModuleLoads: 0,
}));
// Install every I/O replacement before importing the actual action and Trust bridge.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mock.auth }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mock.serviceFactory, createServer: mock.forbiddenFactory }));
vi.mock('@/lib/supabase/service-writer', () => ({ serverWriter: mock.forbiddenWriter }));
vi.mock('@/lib/trust/ledger', () => ({ ledgerWriter: mock.ledgerWriter, recordTrustChange: mock.forbiddenWriter }));
vi.mock('@/lib/stripe/capabilities', () => ({ getMoneyCapabilities: mock.capabilities }));
vi.mock('@/lib/stripe/connect', () => ({ ensureConnectedAccount: mock.forbiddenProvider, createOnboardingLink: mock.forbiddenProvider, syncConnectedAccount: mock.forbiddenProvider }));
vi.mock('@/lib/stripe/treasury', () => ({ ensureFinancialAccount: mock.forbiddenProvider }));
vi.mock('@/lib/stripe/issuing', () => ({ ensureCardholder: mock.cardholder, issueCard: mock.issue, setCardFrozen: mock.forbiddenProvider, updateCardControls: mock.forbiddenProvider }));
vi.mock('@/lib/stripe', () => ({ getStripe: mock.forbiddenProvider }));
vi.mock('@/lib/stripe/settings', () => ({ effectivePublishableKey: mock.forbiddenProvider }));
vi.mock('@/lib/server/audit', () => ({ logWalletAudit: mock.audit }));
vi.mock('next/headers', () => ({ headers: mock.forbiddenProvider }));
vi.mock('next/cache', () => ({ revalidatePath: mock.revalidate }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: mock.translations }));
vi.mock('@supabase/supabase-js', () => { mock.sdkModuleLoads++; return { createClient: mock.forbiddenFactory }; });
vi.mock('@supabase/ssr', () => { mock.sdkModuleLoads++; return { createServerClient: mock.forbiddenFactory, createBrowserClient: mock.forbiddenFactory }; });
vi.mock('stripe', () => {
  mock.stripeModuleLoads++;
  return { default: class { constructor() { mock.stripeInitializations++; throw new Error('Stripe SDK forbidden'); } } };
});
// Deliberately NOT mocked: real server bridge, real pure engine, roles, settle, errors.
import { issueCardAction } from '@/app/(app)/money/actions';
import { evaluateTrust } from '@/lib/trust/server';
import { evaluateAction } from '@/lib/trust/engine';

type Mode = 'allow' | 'deny' | 'policy_approval' | 'degraded_policy_error' | 'degraded_grants_rejection';
type Reply = { data: unknown; error: unknown; rejection?: unknown };
const family = 'family-bridge-synthetic';
const manager = 'manager-bridge-synthetic';
const input = { childWalletId: 'wallet-bridge-synthetic', type: 'virtual' as const, spendLimitCents: 5000, spendWindow: 'monthly' };
let replies: Record<string, Reply>;
let reads: { table: string; method: string; args: unknown[] }[];
let auditRows: Record<string, unknown>[];
let ledgerTables: string[];
let unexpectedTables: string[];
let events: string[];
const service = { from: (table: string) => {
  if (!(table in replies)) { unexpectedTables.push(table); throw new Error('Unexpected in-memory read table: ' + table); }
  reads.push({ table, method: 'from', args: [] });
  const result = () => {
    events.push('read:' + table);
    const reply = replies[table];
    return 'rejection' in reply ? Promise.reject(reply.rejection) : Promise.resolve({ data: reply.data, error: reply.error });
  };
  const query = {
    select(...args: unknown[]) { reads.push({ table, method: 'select', args }); return query; },
    eq(...args: unknown[]) { reads.push({ table, method: 'eq', args }); return query; },
    order(...args: unknown[]) { reads.push({ table, method: 'order', args }); return query; },
    is(...args: unknown[]) { reads.push({ table, method: 'is', args }); return query; },
    gt(...args: unknown[]) { reads.push({ table, method: 'gt', args }); return query; },
    maybeSingle() { reads.push({ table, method: 'maybeSingle', args: [] }); return result(); },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return result().then(resolve, reject); },
  };
  return query;
} };
const writer = { from: mock.ledgerFrom };
function policy(effect: 'allow' | 'deny' | 'require_approval') {
  return { id: 'policy-bridge-synthetic', family_id: family, domain: 'finances', capability: 'create', subject_kind: 'everyone', effect, conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100, enabled: true };
}
beforeEach(() => {
  vi.clearAllMocks(); reads = []; auditRows = []; ledgerTables = []; unexpectedTables = []; events = [];
  replies = {
    stripe_connected_accounts: { data: { stripe_account_id: 'acct_bridge_synthetic', card_issuing_enabled: true }, error: null },
    child_wallets: { data: { id: input.childWalletId, member_id: 'child-bridge-synthetic' }, error: null },
    family_members: { data: { display_name: 'Synthetic Child' }, error: null },
    trust_policies: { data: [], error: null }, permission_grants: { data: [], error: null },
    trust_delegations: { data: [], error: null }, emergency_sessions: { data: [], error: null },
  };
  mock.auth.mockResolvedValue({ user: { id: 'user-bridge-synthetic' }, active: { familyId: family, role: 'parent', member: { id: manager } } });
  mock.serviceFactory.mockImplementation(() => { events.push('synthetic-service'); return service; });
  mock.capabilities.mockResolvedValue({ issuing: true, physicalCards: true });
  mock.translations.mockResolvedValue((key: string) => 'translated:' + key);
  mock.ledgerWriter.mockImplementation(async (supplied: unknown) => {
    if (supplied !== service) throw new Error('Ledger received unexpected client');
    events.push('synthetic-ledger-writer'); return writer;
  });
  mock.ledgerFrom.mockImplementation((table: string) => {
    ledgerTables.push(table);
    if (table !== 'trust_audit_logs') throw new Error('Only synthetic trust audit inserts are allowed: ' + table);
    return { insert: mock.ledgerInsert };
  });
  mock.ledgerInsert.mockImplementation(async (row: Record<string, unknown>) => { events.push('trust-audit'); auditRows.push(row); return { error: null }; });
  mock.cardholder.mockImplementation(async () => { events.push('cardholder'); return { rowId: 'holder-bridge-row', stripeCardholderId: 'ich_bridge_synthetic' }; });
  mock.issue.mockImplementation(async () => { events.push('issue'); return { rowId: 'card-bridge-row', stripeCardId: 'ic_bridge_synthetic' }; });
  mock.audit.mockImplementation(async () => { events.push('wallet-audit'); });
  mock.revalidate.mockImplementation(() => { events.push('revalidate'); });
  for (const stub of [mock.forbiddenFactory, mock.forbiddenProvider, mock.forbiddenWriter]) stub.mockImplementation(() => { throw new Error('Unexpected real client/provider/writer path'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(network.attempts).toEqual({ fetch: 0, http: 0, https: 0, socket: 0, tls: 0 });
  expect(mock.sdkModuleLoads).toBe(0); expect(mock.stripeModuleLoads).toBe(0); expect(mock.stripeInitializations).toBe(0);
  expect(mock.forbiddenFactory).not.toHaveBeenCalled(); expect(mock.forbiddenProvider).not.toHaveBeenCalled(); expect(mock.forbiddenWriter).not.toHaveBeenCalled();
  expect(mock.serviceFactory).toHaveBeenCalledTimes(1);
  expect(mock.ledgerWriter).toHaveBeenCalledExactlyOnceWith(service);
  expect(ledgerTables).toEqual(['trust_audit_logs']); expect(mock.ledgerInsert).toHaveBeenCalledTimes(1); expect(unexpectedTables).toEqual([]);
  vi.mocked(console.error).mockRestore();
});
afterAll(() => network.restore());

async function exercise(selected: Mode) {
  if (selected === 'allow' || selected === 'deny') replies.trust_policies.data = [policy(selected)];
  if (selected === 'policy_approval') replies.trust_policies.data = [policy('require_approval')];
  if (selected === 'degraded_policy_error') replies.trust_policies = { data: null, error: { code: 'XX999', message: 'Synthetic policy lookup unavailable' } };
  if (selected === 'degraded_grants_rejection') replies.permission_grants = { data: null, error: null, rejection: new Error('Synthetic grants transport unavailable') };
  expect(vi.isMockFunction(evaluateTrust)).toBe(false);
  expect(vi.isMockFunction(evaluateAction)).toBe(false);
  const result = await issueCardAction(input);
  for (const table of ['stripe_connected_accounts', 'child_wallets', 'trust_policies', 'permission_grants', 'trust_delegations', 'emergency_sessions']) {
    expect(reads).toContainEqual({ table, method: 'eq', args: ['family_id', family] });
  }
  expect(auditRows).toHaveLength(1);
  expect(auditRows[0]).toMatchObject({ family_id: family, actor_id: manager, domain: 'finances', capability: 'create', approval_id: null });
  return result;
}
describe('real Trust bridge and engine with sealed synthetic I/O', () => {
  it('allow control permits issuance after the real policy decision', async () => {
    expect(await exercise('allow')).toEqual({ ok: true, data: { cardId: 'card-bridge-row' } });
    expect(auditRows[0]).toMatchObject({ decision: 'allow', context: { basis: 'policy' } });
    expect(mock.cardholder).toHaveBeenCalledTimes(1); expect(mock.issue).toHaveBeenCalledTimes(1);
    expect(mock.audit).toHaveBeenCalledTimes(1); expect(mock.revalidate).toHaveBeenCalledExactlyOnceWith('/wallet');
    expect(at(events, 'trust-audit')).toBeLessThan(at(events, 'cardholder'));
  });
  it('deny control blocks issuance after the real policy decision', async () => {
    expect(await exercise('deny')).toEqual({ ok: false, error: 'translated:trust.blockedByHouseholdPolicy' });
    expect(auditRows[0]).toMatchObject({ decision: 'deny', context: { basis: 'policy' } });
    expect(mock.cardholder).not.toHaveBeenCalled(); expect(mock.issue).not.toHaveBeenCalled();
    expect(mock.audit).not.toHaveBeenCalled(); expect(mock.revalidate).not.toHaveBeenCalled();
    expect(reads.some(read => read.table === 'family_members')).toBe(false);
  });
  // Approval requirements, including unreadable rules, must stop before card effects.
  it.each(['policy_approval', 'degraded_policy_error', 'degraded_grants_rejection'] as const)('requires verified allow before issuance: %s', async selected => {
    const result = await exercise(selected);
    expect(auditRows[0]).toMatchObject({ decision: 'require_approval', context: { basis: selected === 'policy_approval' ? 'policy' : 'degraded' } });
    expect.soft(result).toEqual({ ok: false, error: 'translated:trust.blockedByHouseholdPolicy' });
    expect.soft(mock.cardholder).not.toHaveBeenCalled(); expect.soft(mock.issue).not.toHaveBeenCalled();
    expect.soft(mock.audit).not.toHaveBeenCalled(); expect.soft(mock.revalidate).not.toHaveBeenCalled();
    expect.soft(reads.some(read => read.table === 'family_members')).toBe(false);
  });
});
