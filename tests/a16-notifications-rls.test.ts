import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A-16 (notifications / reminders) tenant-isolation guard. The global cross-family
// proof lives in the A-03 PG16 probe (docs/audit/rls-isolation-check.sql), which
// asserts every family-scoped table has RLS enabled and family B reads 0 rows of
// family A. This complementary static guard pins the *A-16 tables' own* RLS
// policies to their migrations so a future edit can't silently drop tenant
// scoping on the tables that carry a family's notifications and reminders.

function migration(file: string): string {
  return readFileSync(`supabase/migrations/${file}`, 'utf8');
}

function allMigrations(): string {
  return readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
    .join('\n');
}

// One `create policy` statement, from its own name to its own terminating `;`,
// so a predicate in a comment or in another table's policy cannot satisfy a check.
function statement(sql: string, start: number): string {
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(';', start) + 1);
}

// The definition that is live today: the last `create policy <name>` in
// migration order (notif_insert is restated by 0301 and 0388, the blanket
// family_reminders policy is replaced by 0479).
function livePolicy(name: string, table: string): string {
  const ordered = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8'))
    .join('\n');
  return statement(ordered, ordered.lastIndexOf(`create policy ${name} on public.${table} `));
}

const OPEN_POLICY = /(using|with check)\s*\(\s*true\s*\)/;

describe('A-16 notification/reminder tables are RLS tenant-scoped', () => {
  it('notifications: RLS enabled (universal drift-repair loop) and every policy is family- or user-scoped', () => {
    const drift = migration('0118_rls_drift_repair.sql');
    // 0118 force-enables RLS on every public base table via a loop, then defines
    // the recipient/family-scoped notification policies.
    expect(drift).toContain('execute format(\'alter table public.%I enable row level security;\', t)');
    expect(drift).toContain('create policy notif_select on public.notifications for select');
    // Scoped to the caller's own row OR family membership — never global.
    expect(drift).toContain('user_id = auth.uid() or (user_id is null and public.is_family_member(family_id))');
    expect(drift).toContain('with check (public.is_family_member(family_id))');
    // The insert check belongs to notif_insert itself, not to the generic loop.
    expect(statement(drift, drift.indexOf('create policy notif_insert on public.notifications'))).toContain(
      'with check (public.is_family_member(family_id))',
    );
  });

  it('notifications: the live definition of every notif_ policy is still recipient- or family-scoped', () => {
    const scope = {
      select: ['user_id = auth.uid() or (user_id is null and public.is_family_member(family_id))'],
      insert: ['public.is_family_member(family_id)', 'and user_id = auth.uid()'],
      update: ['user_id = auth.uid() or (user_id is null and public.is_family_member(family_id))'],
      delete: ['user_id = auth.uid() or public.can_manage_family(family_id)'],
    };
    for (const [op, predicates] of Object.entries(scope)) {
      const policy = livePolicy(`notif_${op}`, 'notifications');
      expect(policy).toContain(`for ${op}`);
      for (const predicate of predicates) expect(policy).toContain(predicate);
      expect(policy).not.toMatch(OPEN_POLICY);
    }
  });

  it('family_reminders: RLS enabled and scoped to the caller family', () => {
    const core = migration('0014_core_platform.sql');
    expect(core).toContain('alter table public.family_reminders enable row level security');
    expect(core).toContain('family_id in (select family_id from public.family_members where user_id = auth.uid())');
    // The predicate is the reminders policy's own, not one of the six neighbours'.
    const blanket = statement(core, core.indexOf('create policy "family members can manage reminders"'));
    expect(blanket).toContain('on public.family_reminders for all');
    expect(blanket).toContain('family_id in (select family_id from public.family_members where user_id = auth.uid())');
  });

  it('family_reminders: the live per-command policies are each scoped to the caller family', () => {
    for (const op of ['select', 'insert', 'update', 'delete']) {
      const policy = livePolicy(`family_reminders_${op}`, 'family_reminders');
      expect(policy).toContain(`for ${op} to public`);
      expect(policy).toContain('public.is_family_member(family_id)');
      expect(policy).not.toMatch(OPEN_POLICY);
    }
    expect(livePolicy('family_reminders_delete', 'family_reminders')).toContain('created_by = auth.uid()');
  });

  it('reminder_lists: RLS enabled and scoped via active family membership', () => {
    const m = migration('0100_reminder_details.sql');
    expect(m).toContain('ENABLE ROW LEVEL SECURITY');
    expect(m).toContain('FROM family_members WHERE family_id = reminder_lists.family_id AND user_id = auth.uid()');
  });

  it('push_devices: RLS enabled and every policy is scoped to the owning user', () => {
    const m = migration('0035_push_devices.sql');
    expect(m).toContain('alter table public.push_devices enable row level security');
    for (const op of ['select', 'insert', 'update', 'delete']) {
      expect(m).toContain(`create policy push_devices_${op} on public.push_devices`);
    }
    expect(m).toContain('user_id = auth.uid()');
    // Each policy's own statement carries the predicate, not just the header comment.
    for (const op of ['select', 'insert', 'update', 'delete']) {
      const policy = statement(m, m.indexOf(`create policy push_devices_${op} on public.push_devices`));
      expect(policy).toContain(`for ${op}`);
      if (op !== 'insert') expect(policy).toContain('using (user_id = auth.uid())');
      if (op === 'insert' || op === 'update') expect(policy).toContain('with check (user_id = auth.uid())');
      expect(policy).not.toMatch(OPEN_POLICY);
      expect(livePolicy(`push_devices_${op}`, 'push_devices')).toBe(policy);
    }
  });
});
