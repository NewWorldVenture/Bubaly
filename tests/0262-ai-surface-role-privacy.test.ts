import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Bubaly refuses to read a family's finances or medical detail to a child:
// `riskToDecision`'s view rule denies it, the memory slice filters by category,
// and 0250 deliberately narrowed `ai_tool_calls` because "inputs/outputs can
// hold finance rows, document text or another member's medical detail".
//
// Four tables around it kept the family-wide rule, and an ordinary session
// reads them directly — most sharply `ai_plan_steps.input_json`, which is the
// verbatim tool arguments. 0262 gives the database the boundary the AI layer
// was enforcing alone.
//
// The behavioural proof is docs/audit/ai-surface-role-privacy-check.sql, which
// runs as a real `authenticated` session under RLS and fails on the old
// policies. This locks the shape.
const raw = readFileSync('supabase/migrations/0262_ai_surface_role_privacy.sql', 'utf8');
const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
const proof = readFileSync('docs/audit/ai-surface-role-privacy-check.sql', 'utf8');

describe('0262 AI-surface role privacy', () => {
  it('narrows the plan ledger to the requester or a manager', () => {
    for (const table of ['ai_plans', 'ai_plan_steps', 'ai_run_events']) {
      const policy = sql.slice(sql.indexOf(`create policy ${table}_select`));
      expect(policy, table).toContain('public.can_manage_family(family_id)');
      expect(policy, table).toContain('r.requested_by = auth.uid()');
      expect(policy.slice(0, policy.indexOf(');')), `${table} still family-wide`).not.toContain('is_family_member');
    }
  });

  it('makes writing a routine a manager’s act, and keeps reading it everyone’s', () => {
    // 0022's blanket `FOR ALL` has to go, or a later policy just ORs with it.
    expect(sql).toContain('drop policy if exists "Members can manage family_automation_rules" on public.family_automation_rules');
    expect(sql).toMatch(/create policy family_automation_rules_select[\s\S]*?is_family_member\(family_id\)/);
    for (const cmd of ['insert', 'update', 'delete']) {
      const policy = sql.slice(sql.indexOf(`create policy family_automation_rules_${cmd}`));
      expect(policy, cmd).toContain('public.can_manage_family(family_id)');
    }
  });

  it('keeps medical and account facts to the adults, on every command', () => {
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      const policy = sql.slice(sql.indexOf(`create policy family_facts_${cmd}`));
      expect(policy, cmd).toContain("category not in ('medical', 'account') or public.can_manage_family(family_id)");
    }
  });

  it('leaves the brief readable by the family and writable only by the server', () => {
    expect(sql).toContain('drop policy if exists home_briefs_insert on public.home_briefs');
    expect(sql).toContain('drop policy if exists home_briefs_update on public.home_briefs');
    expect(sql).not.toMatch(/create policy home_briefs_(insert|update)/);
    // The read is untouched: a brief is for the whole family.
    expect(sql).not.toContain('drop policy if exists home_briefs_select');
  });

  it('ships a proof that reads as a child and as a parent, not just as postgres', () => {
    expect(proof).toContain('set local role authenticated');
    for (const claim of [
      'a child could read % plan row(s)',
      'that is the verbatim tool arguments',
      'a child could read % medical fact(s)',
      'a child should still read ordinary preferences',
      'a child could create a routine',
      'the parent who asked cannot see their own plan',
    ]) {
      expect(proof, claim).toContain(claim);
    }
  });
});

describe('the code agrees with 0262', () => {
  it('writes the brief with the server’s client, not the reader’s', () => {
    const store = readFileSync('lib/briefing/store.ts', 'utf8');
    // Both writers — saveBrief and markDelivered. loadBrief still reads with
    // the caller's client, because the brief is for the whole family to read.
    expect((store.match(/await serverWriter\(scope\.db\)/g) ?? []).length).toBe(2);
    for (const fn of ['saveBrief', 'markDelivered']) {
      const body = store.slice(store.indexOf(`export async function ${fn}`));
      expect(body.slice(0, body.indexOf('.from(')), fn).toContain('serverWriter(scope.db)');
    }
  });

  it('keeps the sensitive insight kinds to the adults', () => {
    const insights = readFileSync('lib/ai/insights.ts', 'utf8');
    const set = insights.slice(insights.indexOf('MANAGER_ONLY_INSIGHTS'));
    for (const kind of ['medications', 'care', 'documents', 'expenses', 'billing', 'messages']) {
      expect(set, kind).toContain(`'${kind}'`);
    }
    const route = readFileSync('app/api/ai/insights/route.ts', 'utf8');
    expect(route).toContain('MANAGER_ONLY_INSIGHTS.has(kind) && !isManager(ctx.active.role)');
  });

  it('fences the household rows it hands the model, and says they are data', () => {
    const route = readFileSync('app/api/ai/insights/route.ts', 'utf8');
    expect(route).toContain('fenceUntrustedBlock(`insight_${kind}`');
    // Appended by the route, not by the prompt registry: that module is
    // imported by a client component and the fence reaches node:crypto.
    expect(route).toContain('`${def.system}\\n\\n${UNTRUSTED_CONTENT_RULE}`');
    const insights = readFileSync('lib/ai/insights.ts', 'utf8');
    expect(insights).not.toContain("from '@/lib/ai/safety/untrusted'");
  });
});
