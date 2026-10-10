// Magic Import's confirm step runs what the CLIENT sends. Phase 2 used to map
// any name outside its five legacy actions to a 'tasks' trust domain
// (`ACTION_DOMAIN[item.name] ?? 'tasks'`), gate it there, and then run it
// through `runAction(..., { alreadyAuthorized: true })` — the registry's own
// gate skipped. So an authenticated parent could POST
// `{confirm:[{name:'finances.createTransaction', …}]}` and have a finance
// write evaluated as a task: allowed for an automation-trusted role where the
// real domain is high-stakes and would have asked, and ledgered as 'tasks'.
//
// Phase 2 now accepts only the actions Magic Import proposes, and gates each
// under the domain the registry declares for it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  gateAiAction: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { name: 'Hughen', timezone: 'America/Los_Angeles' } },
}) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}), createServiceClient: () => ({}) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: vi.fn() }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/trust/ai-gate', () => ({ gateAiAction: mocks.gateAiAction }));
vi.mock('@/lib/ai/actions', () => ({ AI_TOOLS: [], runAction: mocks.runAction }));

import { POST } from '@/app/api/ai/import/route';

const post = (confirm: unknown) => POST(new NextRequest('http://localhost/api/ai/import', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }),
}));

beforeEach(() => {
  mocks.gateAiAction.mockReset().mockResolvedValue({ effect: 'allow' });
  mocks.runAction.mockReset().mockResolvedValue({ ok: true });
});

describe('Magic Import phase 2', () => {
  it.each([
    'finances.createTransaction', 'documents.linkToVacation', 'messages.sendFamilyMessage', 'trips.buildPlan', 'calendar.updateEvent', 'calendar.createEvent',
  ])('refuses %s — a registry tool Magic Import never proposed — before gating or running anything', async (name) => {
    const res = await post([{ name, args: { title: 'x' }, summary: 'x' }]);
    expect(res.status).toBe(400);
    expect(mocks.gateAiAction).not.toHaveBeenCalled();
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it('refuses the whole list when one item is not a Magic Import action', async () => {
    const res = await post([
      { name: 'create_reminder', args: { title: 'Permission slip', remind_at: '2026-09-14T09:00:00' }, summary: 'r' },
      { name: 'finances.createTransaction', args: { amount: 500 }, summary: 'f' },
    ]);
    expect(res.status).toBe(400);
    expect(mocks.gateAiAction).not.toHaveBeenCalled();
    expect(mocks.runAction).not.toHaveBeenCalled();
  });

  it('refuses a malformed item rather than reading a domain off it', async () => {
    expect((await post([null])).status).toBe(400);
    expect((await post(['create_reminder'])).status).toBe(400);
    expect((await post([{ name: 'constructor', args: {}, summary: 'x' }])).status).toBe(400);
    expect(mocks.gateAiAction).not.toHaveBeenCalled();
  });

  it('gates a proposed action under the domain the registry declares, then runs it', async () => {
    const res = await post([{ name: 'create_reminder', args: { title: 'Permission slip', remind_at: '2026-09-14T09:00:00' }, summary: 'r' }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1, queued: 0 });
    expect(mocks.gateAiAction).toHaveBeenCalledTimes(1);
    expect(mocks.gateAiAction.mock.calls[0][2]).toMatchObject({ toolName: 'create_reminder', domain: 'scheduling', agent: 'Magic Import' });
    expect(mocks.runAction).toHaveBeenCalledWith(expect.anything(), { name: 'create_reminder', args: { title: 'Permission slip', remind_at: '2026-09-14T09:00:00' } }, { alreadyAuthorized: true });
  });

  it('never falls back to a tasks domain for any proposed action', async () => {
    const items = [
      ['create_calendar_event', 'calendar'], ['create_chore', 'chores'], ['create_reminder', 'scheduling'],
      ['add_grocery_item', 'shopping'], ['create_meal_plan_entry', 'meal_planning'],
    ] as const;
    const res = await post(items.map(([name]) => ({ name, args: { title: 'x', name: 'x', meal_name: 'x' }, summary: name })));
    expect(res.status).toBe(200);
    const gated = mocks.gateAiAction.mock.calls.map((call) => [call[2].toolName, call[2].domain]);
    expect(gated.sort()).toEqual(items.map((pair) => [...pair]).sort());
    expect(gated.some(([, domain]) => domain === 'tasks')).toBe(false);
  });
});
