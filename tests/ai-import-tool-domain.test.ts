// Real import route → registry lookup → AI settings reader → shared gate/pure
// Trust engine → action bridge. Auth, entitlement, rate limit, approval storage
// and the executor are inert seams. No tool/service mutation is executed;
// this does not prove SQL/RLS, provider behavior or deployed authorization.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ai/import/route';
import { getTool } from '@/lib/ai/tools/registry';
import { evaluateAction, type EvaluateInput, type Policy } from '@/lib/trust/engine';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as InMemorySupabase | null,
  policies: [] as Policy[],
  evaluate: vi.fn(), approval: vi.fn(), execute: vi.fn(), provider: vi.fn(),
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    active: { familyId: 'synthetic-import-family', role: 'parent', family: { name: 'Synthetic household' } },
    user: { id: 'synthetic-import-parent' },
  }),
}));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: () => state.provider() }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: () => { throw new Error('Extraction is outside this confirmation test'); } }));
vi.mock('@/lib/ai/tools/execute', () => ({ executeTool: (...args: unknown[]) => state.execute(...args) }));
vi.mock('@/lib/trust/server', () => ({
  roleOf: () => 'parent',
  evaluateTrust: (...args: unknown[]) => state.evaluate(...args),
  openApprovalRequest: (...args: unknown[]) => state.approval(...args),
}));

const FAMILY = 'synthetic-import-family';
const FOREIGN = 'synthetic-import-other-family';
const SPELLINGS = [
  'create_calendar_event', 'calendar.createEvent', 'add_calendar_event',
  'calendar_createEvent', 'CALENDAR.CREATEEVENT', '  CREATE_CALENDAR_EVENT  ',
];
const LEGACY = [
  ['create_calendar_event', 'calendar'], ['create_chore', 'chores'],
  ['create_reminder', 'scheduling'], ['add_grocery_item', 'shopping'],
  ['create_meal_plan_entry', 'meal_planning'],
] as const;
type Proposal = { name: string; args: Record<string, unknown>; summary: string };
type Result = { summary: string; ok: boolean; blocked?: boolean; pendingApproval?: boolean; error?: string };

function item(name: string): Proposal {
  return { name, args: { title: 'Synthetic event', starts_at: '2026-10-05T12:00:00Z' }, summary: `Synthetic ${name}` };
}

function settings(categoryBehavior: Record<string, string> = {}, enabled = true) {
  state.db!.replace('family_ai_settings', [
    { family_id: FAMILY, enabled, behavior: 'execute', category_behavior: categoryBehavior },
    // An unrelated household's permissive settings must not win this read.
    { family_id: FOREIGN, enabled: true, behavior: 'execute', category_behavior: {} },
  ]);
}

function denyPolicy(domain: string, tags?: string[]): Policy {
  return {
    id: 'synthetic-domain-policy', domain, capability: 'all', subjectKind: 'everyone',
    effect: 'deny', conditions: tags ? { tags } : {}, approvalModel: 'single',
    requiredApprovals: 1, priority: 100, enabled: true,
  };
}

async function confirm(items: Proposal[]) {
  const response = await POST(new NextRequest('https://synthetic.invalid/api/ai/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: items }),
  }));
  expect(response.status).toBe(200);
  expect(state.provider).not.toHaveBeenCalled();
  return await response.json() as { created: number; queued: number; results: Result[] };
}

function settingsReads() {
  return state.db!.log.filter(({ table }) => table === 'family_ai_settings');
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = createInMemorySupabase();
  state.db.seed('family_members', [{ id: 'synthetic-import-member', family_id: FAMILY, user_id: 'synthetic-import-parent', role: 'parent', is_active: true }]);
  state.db.seed('families', [{ id: FAMILY, timezone: 'America/New_York' }]);
  state.policies = [];
  settings();
  state.provider.mockImplementation(() => { throw new Error('Live provider is forbidden'); });
  state.evaluate.mockImplementation(async (_db: unknown, familyId: string, request: Pick<EvaluateInput, 'actor' | 'domain' | 'capability' | 'context'>) => {
    expect(familyId).toBe(FAMILY);
    return { decision: evaluateAction({ ...request, policies: state.policies, grants: [], delegations: [], emergencyDomains: [] }) };
  });
  state.approval.mockResolvedValue({ id: 'synthetic-import-approval' });
  state.execute.mockResolvedValue({ status: 'ok', data: { synthetic: true }, summary: 'Synthetic inert operation', toolCallId: 'synthetic-import-call' });
});

describe('Magic Import authorizes the registered tool identity', () => {
  for (const scenario of ['deny', 'recommend', 'prepare', 'execute'] as const) {
    it.each(SPELLINGS)(`${scenario} calendar policy applies to %s before alreadyAuthorized execution`, async (name) => {
      expect(getTool(name)).toBe(getTool('calendar.createEvent'));
      settings({ calendar: scenario === 'deny' ? 'execute' : scenario });
      if (scenario === 'deny') state.policies = [denyPolicy('calendar')];
      const proposal = item(name);
      const body = await confirm([proposal]);
      expect(settingsReads()).toHaveLength(1);
      expect(state.evaluate).toHaveBeenCalledTimes(1);
      expect(body.results[0].summary).toBe(proposal.summary);
      if (scenario === 'execute') {
        expect(body).toMatchObject({ created: 1, queued: 0, results: [{ ok: true }] });
        expect(state.approval).not.toHaveBeenCalled();
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.execute.mock.calls[0]).toMatchObject([
          { familyId: FAMILY, memberId: 'synthetic-import-member', role: 'parent', actorKind: 'ai', tz: 'America/New_York' },
          name, proposal.args, { skipTrust: true },
        ]);
      } else if (scenario === 'prepare') {
        expect(body).toMatchObject({ created: 0, queued: 1, results: [{ ok: false, pendingApproval: true }] });
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.approval).toHaveBeenCalledTimes(1);
        expect(state.approval.mock.calls[0][2]).toMatchObject({ domain: 'calendar', payload: { name, args: proposal.args } });
      } else {
        expect(body).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.approval).not.toHaveBeenCalled();
      }
      expect(state.evaluate.mock.calls[0][2]).toMatchObject({ domain: 'calendar', payload: { name, args: proposal.args } });
    });
  }

  for (const [name, domain] of LEGACY) {
    it(`${name} retains its ${domain} restriction`, async () => {
      expect(getTool(name)?.domain).toBe(domain);
      settings({ [domain]: 'recommend' });
      expect(await confirm([item(name)])).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
      expect(state.evaluate.mock.calls[0][2].domain).toBe(domain);
      expect(state.execute).not.toHaveBeenCalled();
      expect(state.approval).not.toHaveBeenCalled();
    });

    it(`${name} still reaches the bridge when ${domain} execution is allowed`, async () => {
      expect(await confirm([item(name)])).toMatchObject({ created: 1, queued: 0, results: [{ ok: true }] });
      expect(state.evaluate.mock.calls[0][2].domain).toBe(domain);
      expect(state.execute).toHaveBeenCalledTimes(1);
      expect(state.execute.mock.calls[0][1]).toBe(name);
      expect(state.execute.mock.calls[0][3]).toEqual({ skipTrust: true });
      expect(state.approval).not.toHaveBeenCalled();
    });
  }

  it.each(['execute', 'prepare'])('an unknown action is refused before settings, Trust, approvals or executor (%s)', async (behavior) => {
    settings({ tasks: behavior });
    expect(getTool('synthetic.unknownAction')).toBeNull();
    expect(await confirm([item('synthetic.unknownAction')])).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
    expect(settingsReads()).toHaveLength(0);
    expect(state.evaluate).not.toHaveBeenCalled();
    expect(state.approval).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('counts one permitted task and one calendar approval without counting an unknown action', async () => {
    settings({ calendar: 'prepare', tasks: 'execute' });
    const proposals = [item('calendar.createEvent'), item('add_todo'), item('synthetic.unknownAction')];
    expect(await confirm(proposals)).toMatchObject({ created: 1, queued: 1, results: [
      { ok: false, pendingApproval: true }, { ok: true }, { ok: false, blocked: true },
    ] });
    expect(settingsReads()).toHaveLength(2);
    expect(state.evaluate.mock.calls.map((call) => call[2].domain).sort()).toEqual(['calendar', 'tasks']);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0][1]).toBe('add_todo');
    expect(state.approval).toHaveBeenCalledTimes(1);
    expect(state.approval.mock.calls[0][2].domain).toBe('calendar');
  });

  it('the family switch still blocks a recognized canonical action before engine or bridge', async () => {
    settings({}, false);
    expect(await confirm([item('calendar.createEvent')])).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
    expect(settingsReads()).toHaveLength(1);
    expect(state.evaluate).not.toHaveBeenCalled();
    expect(state.approval).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('the real settings reader selects this family even when foreign settings appear first', async () => {
    state.db!.replace('family_ai_settings', [
      { family_id: FOREIGN, enabled: true, behavior: 'execute', category_behavior: {} },
      { family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: { calendar: 'recommend' } },
    ]);
    expect(await confirm([item('calendar.createEvent')])).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('keeps the legacy input tag so a policy targeting that alias still blocks', async () => {
    state.policies = [denyPolicy('calendar', ['tool:create_calendar_event'])];
    expect(await confirm([item('create_calendar_event')])).toMatchObject({ created: 0, queued: 0, results: [{ ok: false, blocked: true }] });
    expect(state.evaluate.mock.calls[0][2].context.tags).toContain('tool:create_calendar_event');
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.approval).not.toHaveBeenCalled();
  });
});
