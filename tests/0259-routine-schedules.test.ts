import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTINE_ANCHORS } from '@/lib/services/routines/anchors';

// 0259 is what makes "every Sunday, plan our meals" a row a worker can fire
// exactly once. The unique key on (rule, due_at) is the fire guard, and the
// absence of a client write policy on routine_runs is what stops a member
// silencing a routine by claiming its occurrence first.
const raw = readFileSync('supabase/migrations/0259_routine_schedules.sql', 'utf8');
const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

describe('0259 routine schedules', () => {
  it('gives a rule everything a clock needs', () => {
    for (const column of ['schedule_kind', 'schedule_expr', 'anchor_key', 'offset_days', 'at_hour', 'next_run_at', 'said']) {
      expect(sql, column).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toContain("check (schedule_kind is null or schedule_kind in ('cron', 'relative'))");
  });

  it('refuses a half-written schedule that would silently never fire', () => {
    const shape = sql.slice(sql.indexOf('family_automation_rules_schedule_shape_check'));
    expect(shape).toContain("schedule_kind = 'cron' and schedule_expr is not null");
    expect(shape).toContain("schedule_kind = 'relative' and anchor_key is not null and offset_days is not null");
  });

  it('makes firing once per occurrence the database’s job', () => {
    expect(sql).toContain('create table if not exists public.routine_runs');
    expect(sql).toMatch(/create unique index if not exists uq_routine_runs_occurrence\s+on public\.routine_runs \(rule_id, due_at\)/);
    expect(sql).toMatch(/status\s+text not null default 'filed' check \(status in \('filed', 'skipped', 'failed'\)\)/);
  });

  it('lets the family read their routine history and nothing else write it', () => {
    expect(sql).toMatch(/create policy routine_runs_select[\s\S]*?is_family_member\(family_id\)/);
    // A member who could insert here could claim an occurrence and silence the
    // routine; only the worker (service role) writes.
    expect(sql).not.toMatch(/create policy routine_runs_(insert|update|delete)/);
    expect(sql).toContain('alter table public.routine_runs enable row level security');
  });

  it('indexes the only question the worker asks', () => {
    expect(sql).toMatch(/create index if not exists idx_family_automation_rules_due\s+on public\.family_automation_rules \(next_run_at\)/);
  });

  it('leaves the existing event-triggered rules alone', () => {
    // schedule_kind is null for them, and the worker only reads rows that have one.
    expect(sql).not.toMatch(/\b(drop table|drop column|delete from|truncate|update public\.family_automation_rules)\b/i);
  });

  it('anchors named in code are the only tables a routine can read', () => {
    // The migration stores an anchor KEY; the table comes from this list.
    expect(sql).toContain('anchor_key');
    expect(sql).not.toMatch(/anchor_table/);
    for (const anchor of ROUTINE_ANCHORS) expect(anchor.table).toMatch(/^(vacations|calendar_events|school_events|sports_events|bills)$/);
  });
});
