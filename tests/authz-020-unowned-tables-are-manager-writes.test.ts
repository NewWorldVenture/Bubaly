import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AUTHZ-020. Sixteen tables no application file references were open to any
// household member's write. 0355 (sync engine) and 0356 (social permission)
// had already closed nine; 0461 narrows the remaining seven to
// can_manage_family, keeping SELECT for every member. Proven on the local
// stack before and after: a child's and a teen's `insert into
// family_stress_predictions` / `vacation_audit_logs` went from INSERT 1 to
// 42501, and a parent's identical insert still succeeds.
//
// tests/authz-020-unreferenced-tables-stay-unreferenced.test.ts is the
// tripwire that the tables are still unowned; this file pins the policies.

const MIGRATIONS = 'supabase/migrations';
const FILE = join(MIGRATIONS, '0461_an_unowned_table_is_not_a_members_write.sql');

const NARROWED = [
  'family_stress_predictions',
  'vacation_activity_logs',
  'vacation_activity_tickets',
  'vacation_audit_logs',
  'vacation_checklists',
  'vacation_destinations',
  'vacation_notifications',
] as const;

/** Closed before 0461 by the migration named, and deliberately left alone. */
const CLOSED_EARLIER: Record<string, string> = {
  sync_calendar_shares: '0355',
  sync_change_logs: '0355',
  sync_conflict_resolutions: '0355',
  sync_event_attendees: '0355',
  sync_note_folders: '0355',
  sync_notes: '0355',
  sync_settings: '0355',
  social_campaigns: '0356',
  social_post_assets: '0356',
};

const read = () => readFileSync(FILE, 'utf8');
const loopArray = (sql: string) => {
  const m = sql.match(/unowned\s+text\[\]\s*:=\s*array\[([\s\S]*?)\];/);
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
};

describe('AUTHZ-020: an unowned table is not a member\'s write (0461)', () => {
  it('the migration exists', () => {
    expect(existsSync(FILE), FILE).toBe(true);
  });

  it('narrows exactly the seven tables still open, and none of the nine closed earlier', () => {
    const tables = loopArray(read());
    expect(tables).toEqual([...NARROWED]);
    for (const t of Object.keys(CLOSED_EARLIER)) expect(tables, t).not.toContain(t);
    expect(NARROWED.length + Object.keys(CLOSED_EARLIER).length).toBe(16);
  });

  it('writes are managers-only, permissive and restrictive, and SELECT stays membership', () => {
    const sql = read();
    expect(sql).toContain("create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))");
    expect(sql).toContain("create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))");
    expect(sql).toContain("create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))");
    expect(sql).toContain("create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))");
    for (const verb of ['insert', 'update', 'delete']) {
      expect(sql, verb).toMatch(new RegExp(`create policy %1\\$s_manager_${verb}_guard on public\\.%1\\$I as restrictive for ${verb} to authenticated`));
    }
    // No policy this file creates grants a write on bare membership.
    const creates = sql.split('\n').filter((l) => /create policy/.test(l) && !/^\s*--/.test(l));
    expect(creates.length).toBe(7);
    const memberWrites = creates.filter((l) => /for (insert|update|delete|all)\b/.test(l) && /is_family_member/.test(l));
    expect(memberWrites).toEqual([]);
  });

  it('sweeps every other permissive write policy (the FOR ALL ones included) and raises if one survives', () => {
    const sql = read();
    expect(sql).toContain("and p.polcmd in ('a','w','d','*')");
    expect(sql).toContain("raise exception '0461 FAILED: % permissive member write policy(ies) still on the unowned tables'");
  });

  it('is idempotent: every policy it creates is dropped-if-exists first', () => {
    const sql = read();
    const created = [...sql.matchAll(/create policy (%1\$s_[a-z_]+) on/g)].map((m) => m[1]);
    expect(created.length).toBe(7);
    for (const name of created) expect(sql, name).toContain(`drop policy if exists ${name} on`);
  });

  it('keeps the audit log append-only: a manager gets INSERT, not UPDATE or DELETE', () => {
    const sql = read();
    expect(sql).toMatch(/append_only\s+text\[\]\s*:=\s*array\['vacation_audit_logs'\]/);
    expect(sql).toMatch(/if not \(t = any \(append_only\)\) then\s+execute format\('create policy %1\$s_mng_update/);
  });

  it('no later migration reopens a narrowed table to bare membership', () => {
    const later = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > '0461');
    const reopened: string[] = [];
    for (const f of later) {
      const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
      for (const t of NARROWED) {
        const re = new RegExp(`create\\s+policy[^;]*on\\s+(public\\.)?"?${t}"?[^;]*for\\s+(insert|update|delete|all)[^;]*is_family_member`, 'i');
        if (re.test(sql)) reopened.push(`${f} -> ${t}`);
      }
    }
    expect(reopened).toEqual([]);
  });
});
