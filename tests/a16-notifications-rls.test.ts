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
  });

  it('family_reminders: RLS enabled and scoped to the caller family', () => {
    const core = migration('0014_core_platform.sql');
    expect(core).toContain('alter table public.family_reminders enable row level security');
    expect(core).toContain('family_id in (select family_id from public.family_members where user_id = auth.uid())');
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
  });
});
