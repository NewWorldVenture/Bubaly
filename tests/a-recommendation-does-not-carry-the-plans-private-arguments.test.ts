// A recommendation does not carry the plan's verbatim tool arguments.
//
// When the household has set a domain to "recommend only", `planRequest` does
// not save a plan: it writes ONE `family_ai_recommendations` row instead
// (lib/ai/planner/index.ts recordRecommendation). That table is every member's:
// 0022 gives it a single FOR ALL policy on `is_family_member`, and no later
// migration narrows it. The same steps, when a run is planned instead, land in
// `ai_plan_steps`, which 0264 narrowed to the requester or a manager because
// `input_json` is "the VERBATIM tool arguments — message bodies, announcement
// text, budget figures, document titles".
//
// The recommendation copied those verbatim arguments into `metadata.steps[].input`
// — and nothing reads them back. So a parent who asked Bubaly to message their
// partner privately, in a household that keeps messaging on "recommend only",
// left the draft in a row the children can select (family_messages in a
// private conversation are participant-only since 0475).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ContextBundle } from '@/lib/ai/context/builder';
import type { AIProvider } from '@/lib/ai/provider';
import type { Plan, PlanStep } from '@/lib/ai/planner/schema';
import type { ServiceScope } from '@/lib/services/types';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

const { planRequest } = await import('@/lib/ai/planner/index');

const NOW = new Date('2026-09-05T16:00:00Z');
const PRIVATE_DRAFT = 'The custody hearing moved to Friday at 9';

type Row = Record<string, unknown>;
type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'upsert' | 'delete'; payload?: unknown; filters: Record<string, unknown>; returning?: boolean };

/** A PostgREST fake that records every write and answers reads from a table map. */
function makeLedger(tables: Record<string, Row[]> = {}) {
  const calls: Call[] = [];
  let counter = 0;
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const rows = () => tables[table] ?? [];
    const one = () => {
      if (call.kind === 'select') return { data: rows()[0] ?? null, error: null };
      const payload = call.payload as Row | Row[];
      const first = Array.isArray(payload) ? payload[0] : payload;
      return { data: { id: (first?.id as string) ?? `${table}-${++counter}` }, error: null };
    };
    const proxy: unknown = new Proxy({}, {
      get(_target, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(
          call.kind === 'select' ? { data: rows(), error: null }
            : call.kind === 'update' && call.returning ? { data: [{ id: call.filters['eq:id'] ?? 'row-1' }], error: null }
              : { data: null, error: null },
        ).then(resolve, reject);
        if (prop === 'select') return () => { call.returning = true; return proxy; };
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(one());
        if (prop === 'insert' || prop === 'update' || prop === 'upsert') return (payload: unknown) => { call.kind = prop; call.payload = payload; return proxy; };
        if (prop === 'delete') return () => { call.kind = 'delete'; return proxy; };
        return (...args: unknown[]) => {
          if (['eq', 'in', 'is', 'gt', 'gte', 'lt', 'lte'].includes(prop) && typeof args[0] === 'string') call.filters[`${prop}:${args[0]}`] = args[args.length - 1];
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-parent', memberId: 'mem-parent', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW };
}

function bundle(): ContextBundle {
  return {
    header: { familyName: 'The Riveras', tz: 'America/New_York', locale: 'en-US', currency: 'USD', nowIso: NOW.toISOString(), todayKey: '2026-09-05', viewerRole: 'parent', viewerName: 'Dana' },
    slices: { people: { members: [{ id: 'mem-parent', name: 'Dana', role: 'parent', canManage: true }, { id: 'mem-alex', name: 'Alex', role: 'adult', canManage: true }, { id: 'mem-child', name: 'Maya', role: 'child', canManage: false }] } },
    stats: { people_count: 3 },
    sensitiveOmitted: [],
    text: 'Family: The Riveras\nMembers: Dana (parent), Alex (adult), Maya (child)',
  };
}

function step(partial: Partial<PlanStep> & { key: string }): PlanStep {
  return {
    step_type: 'retrieve', tool_name: null, description: partial.key, input: '{}', depends_on: [], condition: null, approval_required: null, verify: null,
    ...partial,
  };
}

/** The model's reply: one private message to Alex, described without quoting it. */
const reply: Plan = {
  objective: 'Let Alex know about the schedule change',
  reasoning_summary: 'Dana asked Bubaly to pass on an update.',
  risk_level: 'low',
  steps: [
    step({
      key: 'tell_alex',
      step_type: 'act',
      tool_name: 'messages.sendFamilyMessage',
      description: 'Message Alex about the schedule change',
      input: JSON.stringify({ conversation_id: 'conv-dana-alex', content: PRIVATE_DRAFT }),
    }),
  ],
  followups: [],
  clarification: null,
  answer: null,
};

function provider(): AIProvider {
  return {
    id: 'fake', model: 'gpt-4.1',
    complete: async () => { throw new Error('unused'); },
    runTools: async () => { throw new Error('unused'); },
    runToolsStream: async function* () { throw new Error('unused'); },
    structuredCompletion: async () => ({ text: JSON.stringify(reply), refusal: null, usage: null }),
  } as unknown as AIProvider;
}

/** Messaging on "recommend only": the household's AI policy denies the domain. */
const RECOMMEND_MESSAGING = [{
  id: 'p-msg', family_id: 'fam-1', name: 'AI autonomy: messaging', domain: 'messaging', capability: 'all', subject_kind: 'ai',
  effect: 'deny', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 10, enabled: true,
}];

async function recommend() {
  const ledger = makeLedger({ ai_requests: [{ id: 'req-1', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
  const trust = makeLedger({ trust_policies: RECOMMEND_MESSAGING });
  const result = await planRequest(scopeWith(trust.db), {
    requestId: 'req-1', requestText: 'Tell Alex privately about the hearing', intent: 'other', context: bundle(),
  }, { provider: provider(), db: ledger.db, now: NOW });
  const rec = ledger.calls.find((c) => c.table === 'family_ai_recommendations' && c.kind === 'insert');
  return { result, rec: rec?.payload as Row | undefined };
}

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');

describe('the two audiences, as the migrations state them', () => {
  it('family_ai_recommendations is readable by every member, and nothing later narrows it', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const naming = files.filter((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8').includes('family_ai_recommendations'));
    expect(naming).toEqual(['0022_family_os.sql']);
    const sql = readFileSync(path.join(MIGRATIONS, '0022_family_os.sql'), 'utf8');
    expect(sql).toMatch(/'family_ai_recommendations'/);
    expect(sql).toMatch(/FOR ALL TO authenticated USING \(is_family_member\(family_id\)\)/);
  });

  it('ai_plan_steps — where the same arguments go when a run is planned — is the requester\'s or a manager\'s', () => {
    const sql = readFileSync(path.join(MIGRATIONS, '0264_ai_surface_role_privacy.sql'), 'utf8');
    const policy = sql.slice(sql.indexOf('create policy ai_plan_steps_select'));
    expect(policy).toMatch(/public\.can_manage_family\(family_id\)\s+or exists \(/);
    expect(policy).toMatch(/r\.requested_by = auth\.uid\(\)/);
  });
});

describe('recordRecommendation', () => {
  it('writes the recommendation without the verbatim message the plan would have sent', async () => {
    const { result, rec } = await recommend();
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.data.kind).toBe('recommendation');
    expect(rec).toBeDefined();
    // The family-readable row must not hold the private draft anywhere.
    expect(JSON.stringify(rec)).not.toContain(PRIVATE_DRAFT);
    expect(JSON.stringify(rec)).not.toContain('conv-dana-alex');
  });

  it('still says what Bubaly would do, and keeps the request it came from', async () => {
    const { rec } = await recommend();
    expect(rec).toMatchObject({ family_id: 'fam-1', member_id: 'mem-parent', status: 'pending', source: 'concierge', title: 'Let Alex know about the schedule change' });
    expect(String(rec!.body)).toContain('What Bubaly would do');
    expect(String(rec!.body)).toContain('Message Alex about the schedule change');
    const metadata = rec!.metadata as { request_id: string; steps: Row[] };
    expect(metadata.request_id).toBe('req-1');
    expect(metadata.steps).toEqual([
      { key: 'tell_alex', step_type: 'act', tool_name: 'messages.sendFamilyMessage', description: 'Message Alex about the schedule change' },
    ]);
  });
});
