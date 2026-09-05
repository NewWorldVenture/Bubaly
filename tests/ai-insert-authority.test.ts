import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/0252_ai_insert_authority.sql', 'utf8');
function policy(name: string) {
  const start = sql.indexOf(`create policy ${name} `);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(';', start));
}

describe('client inserts cannot manufacture AI execution authority', () => {
  it('keeps untrusted runs out of the executor queue and its plan links', () => {
    const run = policy('family_automation_runs_insert');
    expect(run).toContain("state = 'queued'");
    for (const column of ['request_id', 'plan_id', 'current_step_id', 'requested_by_member_id', 'lease_owner', 'lease_expires_at', 'idempotency_key']) {
      expect(run).toContain(`${column} is null`);
    }
  });

  it('preserves legacy automatic completion records without scheduling them', () => {
    const run = policy('family_automation_runs_insert');
    expect(run).not.toMatch(/\bstatus\s*=/);
    expect(run).toContain('public.is_family_member(family_id)');
  });

  it('permits asking for approval, not inventing a decision or an execution', () => {
    const approval = policy('approval_requests_insert');
    expect(approval).toContain("status = 'pending'");
    expect(approval).toContain("approvals = '[]'::jsonb");
    for (const column of ['decided_by', 'decided_at', 'executed_at', 'execution_result', 'reviewed_by', 'review_note', 'edited_payload']) {
      expect(approval).toContain(`${column} is null`);
    }
    const parent = policy('parent_approvals_insert');
    expect(parent).toContain("status = 'pending'");
    expect(parent).toContain('decided_by is null');
    expect(parent).toContain('decided_at is null');
  });

  it('pins request identity and leaves accounting to the executor', () => {
    const request = policy('ai_requests_insert');
    expect(request).toContain('requested_by = auth.uid()');
    expect(request).toContain('fm.user_id = auth.uid()');
    expect(request).toContain('fm.family_id = ai_requests.family_id');
    expect(request).toContain("status = 'queued'");
    for (const column of ['prompt_tokens', 'completion_tokens', 'latency_ms', 'model', 'error', 'started_at', 'completed_at']) {
      expect(request).toContain(`${column} is null`);
    }
  });

  it('changes only client INSERT policies, not manager decisions or service grants', () => {
    expect(sql.match(/for insert to authenticated/g)).toHaveLength(4);
    expect(sql).not.toMatch(/for (update|delete|all)\b/i);
    expect(sql).not.toMatch(/\b(revoke|truncate|drop table|delete from)\b/i);
  });
});
