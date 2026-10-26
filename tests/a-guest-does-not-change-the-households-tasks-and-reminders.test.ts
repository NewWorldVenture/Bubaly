import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

// The held 0522, beside 0464 (ROLE-M03) and the held 0498: a guest views the
// household's tasks and reminders and does not change them. KIDS-O01's two
// triggers and the database half of Support's reminder finding.

const MIGRATION = 'supabase/reserved/0522_a_guest_does_not_change_the_households_tasks_and_reminders.sql';
const PROBE = 'docs/audit/reserved/a-guest-does-not-change-the-households-tasks-and-reminders-check.sql';
const WORKFLOW = '.github/workflows/guest-tasks-runtime.yml';
const TABLES = ['todo_lists', 'todo_items', 'reminder_lists', 'family_reminders'];
const read = (p: string) => readFileSync(p, 'utf8');

describe('a guest does not change the household\'s tasks and reminders (0522)', () => {
  it('wires 0464\'s own guard onto the four tables, before insert, update and delete', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain(`foreach t in array array[${TABLES.map((t) => `'${t}'`).join(', ')}] loop`);
    expect(sql).toContain("execute format('create trigger %I before insert or update or delete on public.%I '");
    expect(sql).toContain("'for each row execute function public.household_write_is_not_a_guests()',");
    expect(sql).toContain("'trg_' || t || '_not_a_guests', t);");
    expect(sql).not.toMatch(/create (or replace )?function/);
    expect(at(sql, "to_regprocedure('public.household_write_is_not_a_guests()') is null")).toBeLessThan(at(sql, 'create trigger %I'));
    expect(sql).toContain("raise exception '0522: % of 4 tables carry the guest guard on insert, update and delete', n;");
  });

  it('the guard it reuses refuses a guest of the row\'s family and exempts the server', () => {
    const fn = read('supabase/migrations/0464_a_guest_views_the_household.sql');
    expect(fn).toContain("raise exception 'A guest can see the household but not change it'");
    expect(fn).toContain('if auth.uid() is null then');
  });

  it('the to-do actions already refuse a guest before any write', () => {
    expect(read('app/(app)/dashboard/todos/actions.ts')).toContain("return role === 'guest';");
  });

  it('the probe examines each table as a guest, keeps every other role writing, and carries both controls', () => {
    const probe = read(PROBE);
    for (const t of TABLES) expect(probe, t).toContain(`'${t}', '00000000-0000-4000-8522-`);
    expect(probe).toContain("guard constant text := '42501: A guest can see the household but not change it';");
    expect(probe).toContain("('Caregiver', '00000000-0000-4000-8522-0000000000a5', false)");
    expect(probe).toContain('-- N1. The four guards disabled.');
    expect(probe).toContain("-- M1. todo_items' guard on INSERT alone.");
    // A guest's attempts are rolled back before the controls run.
    expect(at(probe, "got := pg_temp.c0522_as(guest, format(t.insert_sql, 'Grandma'));"))
      .toBeLessThan(at(probe, "      raise exception using errcode = 'P0R01';\n    exception when sqlstate 'P0R01' then null;\n    end;\n\n    -- 5."));
  });

  it('the workflow shows the failure on released, then applies 0522 twice and requires a pass', () => {
    const wf = read(WORKFLOW);
    expect(at(wf, '- name: The released schema lets a guest change the tasks and reminders')).toBeLessThan(at(wf, `-f ${MIGRATION}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${MIGRATION}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qF 'a-guest-does-not-change-the-households-tasks-and-reminders: OK'");
    expect(wf).toContain('docs/audit/a-guest-views-the-household-check.sql');
  });
});
