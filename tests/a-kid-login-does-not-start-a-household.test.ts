import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

// The held 0507 refuses a signed-in kid login creating a family, which would
// make it the parent of a household of its own (and let it invite a stranger
// in). It recognises a kid login exactly as the held 0495 does at
// accept_invite: the synthetic domain the app mints kid addresses on, or the
// app_metadata mark createChildLoginAction writes with the service role. If
// either drifts from the app, a kid login stops being recognised in one place
// and not the other; these pin all three together.

const G0507 = 'supabase/reserved/0507_a_kid_login_does_not_start_a_household.sql';
const G0495 = 'supabase/reserved/0495_a_member_invited_back_gets_what_the_invite_grants.sql';
const ACTIONS = 'app/(app)/family/child-login-actions.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ');

/** The kid-login test in a SQL source: `where u.id = auth.uid() and ( … )` up to its closing `)) then`. */
function kidLoginTest(sql: string): string {
  const m = /where u\.id = auth\.uid\(\)\s+and \((right\(lower\(coalesce\(u\.email[\s\S]*?)\)\) then/.exec(sql);
  expect(m, 'no kid-login test found').not.toBeNull();
  return squash(m![1]);
}

describe('a kid login does not start a household', () => {
  const sql = read(G0507);

  it("recognises a kid login exactly as 0495's accept_invite does", () => {
    expect(kidLoginTest(sql)).toBe(kidLoginTest(read(G0495)));
  });

  it('reads the domain the app mints kid addresses on', () => {
    const domains = [...sql.matchAll(/'@([a-z0-9.-]+)'/g)].map((m) => m[1]);
    expect(domains.length).toBeGreaterThan(0);
    for (const d of domains) expect(d).toBe(CHILD_LOGIN_EMAIL_DOMAIN);
  });

  it('reads the app_metadata mark createChildLoginAction writes', () => {
    const key = /const KID_LOGIN_APP_METADATA_KEY = '([^']+)'/.exec(read(ACTIONS))?.[1];
    expect(key).toBe('bubaly_kid_login');
    expect(sql).toContain(`u.raw_app_meta_data->>'${key}'`);
    // user_metadata is the account owner's to edit, so it is never read.
    expect(sql).not.toMatch(/raw_user_meta_data/);
  });

  it('is a BEFORE INSERT guard on families that refuses with its own sentence', () => {
    expect(squash(sql)).toContain('create trigger trg_family_is_not_a_kid_logins_to_start before insert on public.families for each row execute function public.family_is_not_a_kid_logins_to_start();');
    expect(squash(sql)).toContain("raise exception 'A kid login cannot start a family of its own' using errcode = '42501';");
    expect(squash(sql)).toContain('security definer set search_path = public, pg_temp');
  });
});
