import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
import { isWithheldFromGuest } from '@/lib/auth/guest-scope';

// The held 0520 and 0521, beside the owner's decision on ROLE-SCOPE-001 (held
// 0509): a guest does not read the AI Front Desk's call history or the
// Communications Hub, the two tables behind withheld pages that 0509's list
// left out; and the call history, which the application only reads, is
// written by no member.

const M0520 = 'supabase/reserved/0520_a_guest_does_not_read_the_front_desks_call_history_or_the_hub.sql';
const P0520 = 'docs/audit/reserved/a-guest-does-not-read-the-front-desks-call-history-check.sql';
const W0520 = '.github/workflows/front-desk-guest-runtime.yml';
const M0521 = 'supabase/reserved/0521_a_call_in_the_front_desk_history_is_written_by_no_member.sql';
const P0521 = 'docs/audit/reserved/a-call-in-the-front-desk-history-is-written-by-no-member-check.sql';
const W0521 = '.github/workflows/call-history-writes-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('a guest does not read the call history or the Hub (0520)', () => {
  it('the pages behind both tables are already withheld from a guest', () => {
    for (const page of ['/dashboard/front-desk', '/dashboard/inbox', '/dashboard/contact-center']) {
      expect(isWithheldFromGuest(page), page).toBe(true);
    }
    expect(read('app/(app)/dashboard/front-desk/page.tsx')).toContain("requireFeature('/dashboard/front-desk')");
    expect(read('components/modules/front-desk-module.tsx')).toContain(".from('call_logs').select('*')");
    expect(read('components/modules/inbox-module.tsx')).toContain(".from('family_communications').select('*')");
  });

  it('guards both tables with 0509\'s guard, by name and predicate, and needs 0509 first', () => {
    const sql = read(M0520);
    expect(sql).toContain("foreach t in array array['call_logs', 'family_communications'] loop");
    expect(sql).toContain("'create policy %I on public.%I as restrictive for select to authenticated using (not public.is_family_guest(family_id))'");
    expect(sql).toContain("'A guest does not read ' || t");
    expect(sql).toContain("raise exception '0520 needs public.is_family_guest(uuid), which the held 0509 creates; apply 0509 first';");
    expect(sql).toContain("and p.qual = '(NOT is_family_guest(family_id))') then");
    expect(at(sql, "to_regprocedure('public.is_family_guest(uuid)') is null")).toBeLessThan(at(sql, 'create policy %I'));
  });

  it('the probe counts what each member reads and carries both controls', () => {
    const probe = read(P0520);
    expect(probe).toContain("guard constant text := '(NOT is_family_guest(family_id))';");
    expect(probe).toContain('-- N1. Both guards dropped.');
    expect(probe).toContain('-- M1. Each guard made permissive.');
    expect(probe).toContain("'CONTROL: the guest read %s of %s in the household they are a parent of, not 1'");
  });

  it('the workflow shows the failure on released and with 0509 alone, then applies 0520 twice', () => {
    const wf = read(W0520);
    const m0509 = 'supabase/reserved/0509_a_guest_does_not_read_the_households_most_sensitive_areas.sql';
    expect(at(wf, '- name: The released schema lets a guest read the call history and the Hub'))
      .toBeLessThan(at(wf, `-f ${m0509}\n`));
    expect(at(wf, `-f ${m0509}\n`)).toBeLessThan(at(wf, '- name: With 0509 alone a guest still reads both'));
    expect(at(wf, '- name: With 0509 alone a guest still reads both')).toBeLessThan(at(wf, `-f ${M0520}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M0520}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qF 'a-guest-does-not-read-the-front-desks-call-history: OK'");
  });

  it('the home dashboard offers a guest neither tile', () => {
    const home = read('components/dashboard/ai-home-dashboard.tsx');
    expect(home).toContain("const offered = (href: string) => !(ctx.active.role === 'guest' && isWithheldFromGuest(href));");
    expect(home).toContain(`{offered('/dashboard/front-desk') && <Link href="/dashboard/front-desk"`);
    expect(home).toContain(`{offered('/dashboard/inbox') && <Link href="/dashboard/inbox"`);
    expect(home).toContain('<Link href="/dashboard/concierge"');
  });
});

describe('a call in the front desk\'s history is written by no member (0521)', () => {
  it('nothing in the application writes call_logs', () => {
    const writers = ['app', 'lib', 'components', 'shared'].flatMap(sources).filter((file) => {
      const src = read(file);
      return /from\('call_logs'\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/.test(src);
    });
    expect(writers).toEqual([]);
  });

  it('drops the member writes and keeps the read and the managers\' delete', () => {
    const sql = read(M0521);
    expect(sql).toContain('drop policy if exists "call_logs_insert" on public.call_logs;');
    expect(sql).toContain('drop policy if exists "call_logs_update" on public.call_logs;');
    expect(sql).toContain('revoke insert, update on public.call_logs from anon, authenticated;');
    const statements = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(statements).not.toMatch(/drop policy[^;]*call_logs_(select|delete)/);
    expect(statements).not.toMatch(/revoke[^;]*(select|delete)[^;]*call_logs/);
    expect(sql).toContain("and pg_get_expr(p.polqual, p.polrelid) = 'can_manage_family(family_id)') then");
  });

  it('the probe and its workflow', () => {
    const probe = read(P0521);
    expect(probe).toContain("-- N1. 0092's insert put back.");
    expect(probe).toContain("-- M1. 0092's update alone put back.");
    const wf = read(W0521);
    expect(at(wf, '- name: The released schema lets a member write the call history')).toBeLessThan(at(wf, `-f ${M0521}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M0521}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qF 'a-call-in-the-front-desk-history-is-written-by-no-member: OK'");
  });
});
