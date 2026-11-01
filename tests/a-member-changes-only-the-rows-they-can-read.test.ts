import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

// The held 0523 and 0524. A narrowed read (0509, 0514, 0515, 0517, 0520) did not
// narrow an unfiltered write: 0523 refuses a signed-in caller's UPDATE or
// DELETE of a row they cannot read, asked as the caller. And nine tables behind
// the areas withheld from a guest still took a guest's insert: 0524 puts 0464's
// guest guard on them.

const M0523 = 'supabase/reserved/0523_a_member_changes_only_the_rows_they_can_read.sql';
const P0523 = 'docs/audit/reserved/a-member-changes-only-the-rows-they-can-read-check.sql';
const W0523 = '.github/workflows/blind-writes-runtime.yml';
const M0524 = 'supabase/reserved/0524_a_guest_adds_nothing_to_the_areas_withheld_from_them.sql';
const P0524 = 'docs/audit/reserved/a-guest-adds-nothing-to-the-areas-withheld-from-them-check.sql';
const W0524 = '.github/workflows/guest-withheld-writes-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

const BLIND = ['auto_insurance_policies', 'family_communications', 'home_locations', 'utility_bills',
  'vacation_medical_information', 'wallet_cards', 'wallet_passes', 'wallet_rewards',
  'home_warranties', 'vehicle_registrations', 'vacation_documents', 'voice_commands'];
const GUEST = ['auto_insurance_policies', 'driving_trips', 'family_communications', 'home_locations',
  'utility_bills', 'vacation_medical_information', 'wallet_cards', 'wallet_passes', 'wallet_rewards'];

describe('a member changes only the rows they can read (0523)', () => {
  it('asks the table\'s own read, as the caller, before a change and after an update', () => {
    const sql = read(M0523);
    expect(sql).toContain('security invoker\nset search_path = public, pg_temp');
    expect(sql).toContain("execute format('select exists (select 1 from %s where id = $1)', tg_relid::regclass)");
    expect(sql).toContain("using case when tg_when = 'BEFORE' then old.id else new.id end;");
    expect(sql).toContain("raise exception 'A record you cannot see is not yours to change'");
    expect(sql).toContain('if auth.uid() is null then');
    expect(sql).toContain("'create trigger %I before update or delete on public.%I '");
    expect(sql).toContain("'create trigger %I after update on public.%I '");
    expect(sql).toContain('revoke all on function public.a_row_you_cannot_read_is_not_yours_to_change() from public, anon;');
    expect(sql).not.toMatch(/create policy/);
    for (const t of BLIND) expect(sql, t).toContain(`'${t}'`);
    expect(sql).toContain("raise exception '0523: % of 24 triggers (12 tables, before and after) are in place', n;");
  });

  it('the probe needs the read rules, measures unfiltered writes, and carries its controls', () => {
    const probe = read(P0523);
    expect(probe).toContain("raise exception 'PRECONDITION: the held read rules (0509, 0514, 0515, 0517, 0520) are not all installed");
    expect(probe).toContain("format('update public.%I set %I = %L', t.tbl, t.col, 'blind')");
    expect(probe).toContain("format('delete from public.%I', t.tbl)");
    expect(probe).toContain("handoff constant text := 'update public.wallet_cards set member_id = ''00000000-0000-4000-8523-0000000000c4''';");
    for (const m of ['-- N1. The triggers disabled.', '-- M1. The guard asked as the owner instead of the caller.', '-- M2. No AFTER UPDATE triggers.']) {
      expect(probe, m).toContain(m);
    }
  });

  it('the workflow applies the read rules, shows the failure, then applies 0523 twice', () => {
    const wf = read(W0523);
    const rules = ['0509', '0514', '0515', '0517', '0520'].map((n) => wf.indexOf(`-f supabase/reserved/${n}_`));
    for (const i of rules) expect(i).toBeGreaterThan(0);
    expect([...rules].sort((a, b) => a - b)).toEqual(rules);
    expect(Math.max(...rules)).toBeLessThan(at(wf, '- name: With the read rules alone a member rewrites and deletes rows they cannot read'));
    expect(at(wf, '- name: With the read rules alone a member rewrites and deletes rows they cannot read')).toBeLessThan(at(wf, `-f ${M0523}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M0523}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-member-changes-only-the-rows-they-can-read: OK'");
  });
});

describe('a guest adds nothing to the areas withheld from them (0524)', () => {
  it('wires 0464\'s own guard onto the nine tables', () => {
    const sql = read(M0524);
    expect(sql).toContain(`foreach t in array array[${GUEST.slice(0, 4).map((t) => `'${t}'`).join(', ')},`);
    for (const t of GUEST) expect(sql, t).toContain(`'${t}'`);
    expect(sql).toContain("'for each row execute function public.household_write_is_not_a_guests()',");
    expect(sql).not.toMatch(/create (or replace )?function/);
    expect(sql).toContain("raise exception '0524: % of 9 tables carry the guest guard on insert, update and delete', n;");
  });

  it('every page over these tables is already withheld from a guest', () => {
    const scope = read('lib/auth/guest-scope.ts');
    for (const page of ["'/dashboard/insurance'", "'/dashboard/utilities'", "'/dashboard/inbox'", "'/dashboard/family/driving-safety'", "'/wallet'"]) {
      expect(scope, page).toContain(page);
    }
  });

  it('the probe and its workflow', () => {
    const probe = read(P0524);
    expect(probe).toContain("guard constant text := '42501: A guest can see the household but not change it';");
    expect(probe).toContain('-- N1. The nine guards disabled.');
    expect(probe).toContain("-- M1. utility_bills' guard on UPDATE and DELETE only.");
    const wf = read(W0524);
    expect(at(wf, '- name: The released schema lets a guest add to the withheld areas')).toBeLessThan(at(wf, `-f ${M0524}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M0524}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qF 'a-guest-adds-nothing-to-the-areas-withheld-from-them: OK'");
  });
});
