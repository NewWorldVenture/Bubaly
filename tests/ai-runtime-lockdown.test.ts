import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0255 closes the write paths a signed-in member could use to make Bubaly act
// with someone else's authority, on top of 0252's insert-authority pins. These
// guards pin the predicates so a later "simplification" of a policy cannot
// quietly reopen one — and check that 0255 kept every condition 0252 set,
// because a later policy of the same name replaces the earlier one outright.
const sql = readFileSync('supabase/migrations/0255_ai_runtime_lockdown.sql', 'utf8');
const prior = readFileSync('supabase/migrations/0252_ai_insert_authority.sql', 'utf8');
const policyIn = (source: string, name: string) => {
  const start = source.indexOf(`create policy ${name} `);
  expect(start, name).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return source.slice(start, end);
};
const policy = (name: string) => policyIn(sql, name);

/** The simple `column is null` / `column = literal` clauses of a policy body. */
function simpleClauses(body: string): string[] {
  return [...body.matchAll(/\b([a-z_]+ (?:is null|= (?:'[a-z_]+'|'\[\]'::jsonb|'\{\}'::jsonb|auth\.uid\(\))))/g)].map((m) => m[1]);
}

describe('0255 AI runtime lockdown', () => {
  it('keeps every insert condition 0252 introduced, on every policy it replaces', () => {
    for (const name of ['family_automation_runs_insert', 'approval_requests_insert', 'ai_requests_insert']) {
      const before = simpleClauses(policyIn(prior, name));
      expect(before.length, name).toBeGreaterThan(3);
      const after = policy(name);
      for (const clause of before) expect(after, `${name} dropped "${clause}"`).toContain(clause);
    }
    // parent_approvals is 0252's alone; this file must not touch it.
    expect(sql).not.toContain('parent_approvals');
  });

  it('lets a member file only their own, unplanned, queued run', () => {
    const p = policy('family_automation_runs_insert');
    for (const clause of ['created_by = auth.uid()', "state = 'queued'", 'plan_id is null', 'request_id is null', 'requested_by_member_id is null', 'lease_owner is null', 'idempotency_key is null']) {
      expect(p).toContain(clause);
    }
  });

  it('lets a member file only a member approval request, about themselves, with no run or payload linkage', () => {
    const p = policy('approval_requests_insert');
    for (const clause of ["requested_by_kind = 'member'", 'payload_kind is null', 'request_id is null', 'run_id is null', 'plan_step_id is null', "coalesce(plan_step_ids, '{}'::uuid[]) = '{}'::uuid[]"]) {
      expect(p).toContain(clause);
    }
    expect(p).toMatch(/requested_by_member_id is null\s+or exists \(/);
    expect(p).toContain('fm.user_id = auth.uid()');
    expect(p).toContain('fm.is_active');
  });

  it('pins a fresh concierge request to its author and gives it a client key', () => {
    const p = policy('ai_requests_insert');
    for (const clause of ['requested_by = auth.uid()', "kind = 'concierge'", "status = 'queued'", 'fm.is_active']) expect(p).toContain(clause);
    expect(sql).toContain('add column if not exists client_request_id text');
    expect(sql).toMatch(/create unique index if not exists uq_ai_requests_client_request\s+on public\.ai_requests \(family_id, client_request_id\) where client_request_id is not null/);
  });

  it('makes a conversation its owner\'s: every ai_conversations and ai_messages policy checks user_id = auth.uid()', () => {
    for (const name of ['ai_conversations_select', 'ai_conversations_insert', 'ai_conversations_update', 'ai_conversations_delete']) {
      expect(policy(name)).toContain('user_id = auth.uid()');
    }
    for (const name of ['ai_messages_select', 'ai_messages_insert', 'ai_messages_update', 'ai_messages_delete']) {
      const p = policy(name);
      expect(p).toContain('c.user_id = auth.uid()');
      expect(p).toContain('c.id = ai_messages.conversation_id');
    }
    // Nothing in this file widens what the family can read.
    expect(sql).not.toMatch(/for select[^;]*using \(public\.is_family_member\(family_id\)\)\s*;/);
  });

  it('is additive and idempotent, and changes no grants', () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(sql).not.toMatch(/\b(revoke|grant|truncate|delete from)\b/i);
    expect((sql.match(/drop policy if exists/g) ?? []).length).toBe((sql.match(/create policy/g) ?? []).length);
    expect(sql).toContain('add column if not exists');
    expect(sql).toContain('create unique index if not exists');
  });
});
