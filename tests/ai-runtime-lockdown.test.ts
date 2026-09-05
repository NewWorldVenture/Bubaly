import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 0252 closes the three write paths a signed-in member could use to make
// Bubaly act with someone else's authority. These guards pin the predicates
// so a later "simplification" of a policy cannot quietly reopen one.
const sql = readFileSync('supabase/migrations/0252_ai_runtime_lockdown.sql', 'utf8');
const policy = (name: string) => {
  const start = sql.indexOf(`create policy ${name} `);
  expect(start, name).toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  return sql.slice(start, end);
};

describe('0252 AI runtime lockdown', () => {
  it('lets a member file only their own, unplanned, queued run', () => {
    const p = policy('family_automation_runs_insert');
    for (const clause of ['created_by = auth.uid()', "state = 'queued'", 'plan_id is null', 'request_id is null', 'lease_owner is null']) {
      expect(p).toContain(clause);
    }
    expect(p).toMatch(/requested_by_member_id is null\s+or requested_by_member_id in \(/);
  });

  it('lets a member file only a member approval request with no run or payload linkage', () => {
    const p = policy('approval_requests_insert');
    for (const clause of ["requested_by_kind = 'member'", 'payload_kind is null', 'run_id is null', 'plan_step_id is null', "coalesce(plan_step_ids, '{}'::uuid[]) = '{}'::uuid[]"]) {
      expect(p).toContain(clause);
    }
    expect(p).toContain('fm.user_id = auth.uid()');
  });

  it('pins a fresh concierge request to its author', () => {
    const p = policy('ai_requests_insert');
    for (const clause of ['requested_by = auth.uid()', "kind = 'concierge'", "status = 'queued'"]) expect(p).toContain(clause);
    expect(sql).toContain('add column if not exists client_request_id text');
    expect(sql).toContain('uq_ai_requests_client_request');
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

  it('is additive and idempotent', () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect((sql.match(/drop policy if exists/g) ?? []).length).toBe((sql.match(/create policy/g) ?? []).length);
    expect(sql).toContain('add column if not exists');
    expect(sql).toContain('create unique index if not exists');
  });
});
