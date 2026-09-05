// The family's own answer to "what may Bubaly do?" — 0257 read through
// `lib/ai/family-settings.ts` and written through the service.
//
// Two promises are load-bearing here and each has a test that fails loudly if
// someone relaxes it: a missing or malformed row means the DEFAULTS (never
// "anything goes"), and a risk override may raise a tool's tier but may not
// drop money or documents below `medium`.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import {
  DEFAULT_AI_SETTINGS, behaviorForDomain, effectiveRisk, settingsFromRow,
} from '@/lib/ai/family-settings';
import { getAISettings, updateAISettings } from '@/lib/services/ai-settings';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown };

function makeDb(reply: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, limit: chain,
      eq: (column: string, value: unknown) => { call.filters[column] = value; return b; },
      upsert: (payload: unknown) => { call.kind = 'upsert'; call.payload = payload; return b; },
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => Promise.resolve(reply(call)),
      maybeSingle: () => Promise.resolve(reply(call)),
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(reply(call)),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: new Date('2026-09-05T12:00:00Z'), ...extra,
  };
}

const ROW = {
  family_id: 'fam-1', enabled: true, behavior: 'prepare' as const,
  category_behavior: { meals: 'execute', finances: 'recommend' },
  risk_overrides: { 'calendar.createEvent': 'high' },
  child_channels: { push: true, sms: false },
  memory_enabled: true, quiet_hours_start: 21, quiet_hours_end: 7,
  updated_by: 'auth-1', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};

describe('settingsFromRow', () => {
  it('answers the defaults when the family has no row', () => {
    expect(settingsFromRow('fam-1', null)).toEqual({ familyId: 'fam-1', ...DEFAULT_AI_SETTINGS });
  });

  it('reads a real row, dropping values it does not recognise', () => {
    const settings = settingsFromRow('fam-1', {
      ...ROW,
      category_behavior: { meals: 'execute', chores: 'whatever-it-wants' },
      risk_overrides: { 'calendar.createEvent': 'high', 'tasks.createTodo': 'catastrophic' },
      child_channels: { push: true, sms: 'sometimes' },
    } as never);
    expect(settings.categoryBehavior).toEqual({ meals: 'execute' });
    expect(settings.riskOverrides).toEqual({ 'calendar.createEvent': 'high' });
    expect(settings.childChannels).toEqual({ push: true });
    expect(settings.quietHours).toEqual({ start: 21, end: 7 });
  });

  it('treats anything but an explicit false as on', () => {
    // A row from an older schema must not read as "the family switched Bubaly off".
    const settings = settingsFromRow('fam-1', { ...ROW, enabled: undefined, memory_enabled: undefined } as never);
    expect(settings.enabled).toBe(true);
    expect(settings.memoryEnabled).toBe(true);
    expect(settingsFromRow('fam-1', { ...ROW, enabled: false } as never).enabled).toBe(false);
  });
});

describe('behaviorForDomain', () => {
  it('prefers the category the family set, then the family default', () => {
    const settings = settingsFromRow('fam-1', ROW as never);
    expect(behaviorForDomain(settings, 'meals')).toBe('execute');
    expect(behaviorForDomain(settings, 'finances')).toBe('recommend');
    expect(behaviorForDomain(settings, 'calendar')).toBe('prepare');
  });
});

describe('effectiveRisk', () => {
  const settings = (overrides: Record<string, string>) =>
    settingsFromRow('fam-1', { ...ROW, risk_overrides: overrides } as never);

  it('uses the tool’s own tier when the family set nothing', () => {
    expect(effectiveRisk(settings({}), { name: 'tasks.createTodo', domain: 'tasks', risk: 'low' })).toBe('low');
  });

  it('lets a family raise any tool', () => {
    expect(effectiveRisk(settings({ 'tasks.createTodo': 'high' }), { name: 'tasks.createTodo', domain: 'tasks', risk: 'low' })).toBe('high');
  });

  it('lets a family lower an ordinary tool', () => {
    expect(effectiveRisk(settings({ 'calendar.createEvent': 'low' }), { name: 'calendar.createEvent', domain: 'calendar', risk: 'medium' })).toBe('low');
  });

  it('refuses to make money or documents cheap, however the override is set', () => {
    for (const domain of ['finances', 'documents', 'medical']) {
      const tool = { name: `${domain}.write`, domain, risk: 'high' as const };
      expect(effectiveRisk(settings({ [tool.name]: 'low' }), tool), domain).toBe('medium');
      expect(effectiveRisk(settings({ [tool.name]: 'medium' }), tool), domain).toBe('medium');
    }
  });
});

describe('getAISettings', () => {
  it('is family-scoped and answers the defaults when the read fails', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: { message: 'relation does not exist' } }));
    const settings = await getAISettings(scopeWith(db));
    expect(settings).toEqual({ familyId: 'fam-1', ...DEFAULT_AI_SETTINGS });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1' });
  });

  it('reads the family’s row when there is one', async () => {
    const { db } = makeDb(() => ({ data: ROW, error: null }));
    const settings = await getAISettings(scopeWith(db));
    expect(settings.behavior).toBe('prepare');
    expect(settings.categoryBehavior.finances).toBe('recommend');
  });
});

describe('updateAISettings', () => {
  it('refuses a child, before it touches the database', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    const res = await updateAISettings(scopeWith(db, { role: 'child' }), { behavior: 'execute' });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a level Bubaly does not offer instead of storing it', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    const res = await updateAISettings(scopeWith(db), { categoryBehavior: { meals: 'yolo' as never } });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('saves a manager’s change, stamped with who made it', async () => {
    const { db, calls } = makeDb(() => ({ data: { ...ROW, behavior: 'recommend' }, error: null }));
    const res = await updateAISettings(scopeWith(db), { behavior: 'recommend', quietHours: { start: 21, end: 7 } });
    expect(res.ok).toBe(true);
    const write = calls.find((c) => c.kind === 'upsert');
    expect(write?.payload).toMatchObject({
      family_id: 'fam-1', behavior: 'recommend', quiet_hours_start: 21, quiet_hours_end: 7, updated_by: 'auth-1',
    });
    // Only what was asked for: an untouched field is not written back.
    expect(write?.payload).not.toHaveProperty('memory_enabled');
  });

  it('clears quiet hours when they are set to null', async () => {
    const { db, calls } = makeDb(() => ({ data: ROW, error: null }));
    await updateAISettings(scopeWith(db), { quietHours: null });
    expect(calls.find((c) => c.kind === 'upsert')?.payload).toMatchObject({ quiet_hours_start: null, quiet_hours_end: null });
  });
});
