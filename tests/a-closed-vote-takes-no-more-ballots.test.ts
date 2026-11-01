import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';
import { isPollClosed } from '@/lib/voting/polls';

// The held 0525: a ballot is cast or changed only while its vote is open, on
// meal votes and family polls, as the database's rule and not only the
// screens' (Support's 6137789822; voting-module.tsx: "nothing in the database
// refuses a vote on a closed poll").

const MIGRATION = 'supabase/reserved/0525_a_closed_vote_takes_no_more_ballots.sql';
const PROBE = 'docs/audit/reserved/a-closed-vote-takes-no-more-ballots-check.sql';
const WORKFLOW = '.github/workflows/closed-vote-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('a closed vote takes no more ballots (0525)', () => {
  it('the poll rule is isPollClosed\'s own', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    expect(isPollClosed('closed', null, now)).toBe(true);
    expect(isPollClosed('open', '2026-10-25T11:59:00Z', now)).toBe(true);
    expect(isPollClosed('open', '2026-10-25T12:00:00Z', now)).toBe(true);
    expect(isPollClosed('open', '2026-10-26T12:00:00Z', now)).toBe(false);
    expect(isPollClosed('open', null, now)).toBe(false);
    const sql = read(MIGRATION);
    expect(sql).toContain("select p.status = 'open' and (p.closes_at is null or p.closes_at > now()) into vote_open");
    expect(sql).toContain("select v.status = 'open' into vote_open");
  });

  it('reads the vote in the row\'s family, FOR SHARE, as the owner, before an insert or update', () => {
    const sql = read(MIGRATION);
    for (const fn of ['a_meal_ballot_is_cast_while_its_vote_is_open', 'a_poll_vote_is_cast_while_its_poll_is_open']) {
      const body = sql.slice(at(sql, `create or replace function public.${fn}()`));
      expect(body, fn).toContain('security definer\nset search_path = public, pg_temp');
      expect(at(body, 'if auth.uid() is null then')).toBeLessThan(at(body, 'for share;'));
      expect(sql, fn).toContain(`revoke all on function public.${fn}() from public, anon;`);
    }
    expect(sql).toContain('   where v.id = new.vote_id and v.family_id = new.family_id\n     for share;');
    expect(sql).toContain('   where p.id = new.poll_id and p.family_id = new.family_id\n     for share;');
    expect(sql).toContain("raise exception 'That vote is closed' using errcode = '42501';");
    expect(sql).toContain('create trigger trg_meal_vote_ballots_while_open before insert or update on public.meal_vote_ballots\n    for each row execute function public.a_meal_ballot_is_cast_while_its_vote_is_open();');
    expect(sql).toContain('create trigger trg_family_poll_votes_while_open before insert or update on public.family_poll_votes\n    for each row execute function public.a_poll_vote_is_cast_while_its_poll_is_open();');
    // Each body names only its own table's columns, so it resolves against it.
    const meal = between(sql, 'create or replace function public.a_meal_ballot_is_cast_while_its_vote_is_open()', 'create or replace function public.a_poll_vote_is_cast_while_its_poll_is_open()');
    expect(meal).not.toContain('poll_id');
  });

  it('the screens still ask first', () => {
    expect(read('components/modules/voting-module.tsx')).toContain("if (isPollClosed(current.status, current.closes_at, new Date())) {");
  });

  it('the probe and its workflow', () => {
    const probe = read(PROBE);
    expect(probe).toContain("guard constant text := '42501: That vote is closed';");
    expect(probe).toContain('-- N1. Both triggers disabled.');
    expect(probe).toContain('-- M1. The poll rule on status alone.');
    const wf = read(WORKFLOW);
    expect(at(wf, '- name: The released schema takes ballots on a closed vote')).toBeLessThan(at(wf, `-f ${MIGRATION}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${MIGRATION}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qF 'a-closed-vote-takes-no-more-ballots: OK'");
  });
});
