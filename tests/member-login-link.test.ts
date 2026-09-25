import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SEC-025. `family_members.user_id` links a login to a member row, and the RLS
// policies let a family's parent or adult write every column of their own
// family's rows. Any account could therefore put a stranger's user id into its
// own family and read the stranger's profile (email, full name, date of birth,
// phone) through `profiles_select_self`. 0335 refuses a client write of user_id.
//
// The behaviour is proved against a real catalogue by
// docs/audit/member-login-link-check.sql. This pins the shape that makes the
// trigger mean anything, because the obvious "hardening" breaks it silently:
// inside a SECURITY DEFINER function current_user is the owner, so a definer
// version of this trigger would exempt every caller — the same mistake that
// kept marketplace_close_auction refusing everyone until 0334, inverted.
const MIG = 'supabase/migrations/0335_only_the_server_links_a_login_to_a_member.sql';
const FN = 'family_member_login_is_the_servers_to_link';
const TRIGGER = 'trg_family_member_login_is_the_servers_to_link';

const executable = (raw: string) => raw.replace(/^\s*--.*$/gm, '');

describe('only the server links a login to a family member (0335)', () => {
  const sql = executable(readFileSync(MIG, 'utf8'));
  const fnBody = sql.slice(sql.indexOf(`function public.${FN}()`), sql.indexOf('$$;'));

  it('fires before an insert, and before any update that names user_id', () => {
    expect(sql).toMatch(new RegExp(
      `create trigger ${TRIGGER}\\s+before insert or update of user_id on public\\.family_members\\s+for each row`,
      'i',
    ));
  });

  it('runs as the caller, so current_user is the role running the statement', () => {
    expect(fnBody).not.toMatch(/security\s+definer/i);
    expect(fnBody).toMatch(/current_user not in \('authenticated', 'anon'\)/);
  });

  it('refuses a new login and a changed login, not the rest of the row', () => {
    expect(fnBody).toMatch(/tg_op = 'INSERT' and new\.user_id is not null/);
    expect(fnBody).toMatch(/tg_op = 'UPDATE' and new\.user_id is distinct from old\.user_id/);
    expect(fnBody.match(/errcode = 'insufficient_privilege'/g)).toHaveLength(2);
  });

  it('is not dropped by a later migration', () => {
    const later = readdirSync('supabase/migrations')
      .filter((name) => name.endsWith('.sql') && name > '0335')
      .map((name) => executable(readFileSync(`supabase/migrations/${name}`, 'utf8')));
    for (const text of later) {
      const drops = text.includes(`drop trigger if exists ${TRIGGER}`) || new RegExp(`drop function[^;]*${FN}`, 'i').test(text);
      if (drops) expect(text).toMatch(new RegExp(`create trigger ${TRIGGER}`));
    }
  });
});
