import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0527 (CALHUB-O1, the database half of CALHUB-01). The Idea Board is
// shown to every family and 0197's insert policies check only author_id, so a
// signed-in user could post a team reply, or an idea already shipped and pinned,
// under the team's name. 0527 refuses that for a signed-in caller. The app
// already writes team replies and roadmap changes on the service client after
// the super-admin step-up, and signs everything else with authorNameFor().

const M = 'supabase/reserved/0527_a_post_on_the_idea_board_is_the_callers_own.sql';
const P = 'docs/audit/reserved/a-post-on-the-idea-board-is-the-callers-own-check.sql';
const W = '.github/workflows/idea-board-authorship-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('a post on the Idea Board is the caller\'s own (0527)', () => {
  const sql = read(M);
  const name = bodyOf(sql, 'create or replace function public.feedback_name_is_the_callers_own(p_name text)', '$$;');
  const comment = bodyOf(sql, 'create or replace function public.a_feedback_comment_is_the_callers_own()', '$$;');
  const idea = bodyOf(sql, 'create or replace function public.a_feedback_idea_starts_as_the_callers_own()', '$$;');

  it('the name check follows authorNameFor(), and never answers yes to the team\'s name', () => {
    const actions = read('app/(app)/feedback/actions.ts');
    // The app's three sources, in its order: the member's display name trimmed,
    // the email's local part, the default.
    expect(actions).toContain("const name = ctx.active.member?.display_name?.trim();");
    expect(actions).toContain("return email ? email.split('@')[0] : 'A Bubaly family';");
    expect(name).toContain("nullif(btrim(m.display_name, js.ws), '') = p_name");
    expect(name).toContain("nullif(split_part(u.email, '@', 1), '') = p_name");
    expect(name).toContain("p_name = 'A Bubaly family'");
    // The team's name however it is spaced or cased: trimmed the same way, each
    // run of that whitespace inside it read as one space.
    expect(name).toContain("and lower(regexp_replace(btrim(p_name, js.ws), '[' || js.ws || ']+', ' ', 'g')) <> 'bubaly team'");
    expect(name).toContain('where m.user_id = auth.uid()');
    expect(sql).toContain('revoke all on function public.feedback_name_is_the_callers_own(text) from public, anon, authenticated;');
  });

  it('trims exactly what JavaScript\'s trim() trims, not btrim()\'s spaces alone', () => {
    // A display name stored as E'\tAda\n' is signed "Ada" by authorNameFor().
    const literal = /with js\(ws\) as \(\n\s+select E'([^']*)'\n/.exec(name)?.[1];
    expect(literal, 'the whitespace set').toBeDefined();
    const named: Record<string, string> = { t: '\t', n: '\n', f: '\f', r: '\r' };
    const decoded = literal!.replace(/\\u([0-9A-Fa-f]{4})|\\([tnfr])/g,
      (_m, hex?: string, c?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : named[c!]));
    expect(decoded).not.toContain('\\');
    const sqlSet = [...decoded].map((ch) => ch.codePointAt(0)!).sort((a, b) => a - b);
    const jsSet: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (String.fromCodePoint(cp).trim() === '') jsSet.push(cp);
    }
    expect(sqlSet).toEqual(jsSet);
  });

  it('a signed-in caller posts no team reply and signs with their own name; the service role is exempt', () => {
    for (const body of [comment, idea]) {
      expect(body).toContain('security definer\nset search_path = public, pg_temp');
      expect(body).toContain('if auth.uid() is null then\n    return new; -- service role / server-side jobs');
      expect(body).toContain("if not public.feedback_name_is_the_callers_own(new.author_name) then");
    }
    expect(comment).toContain("if new.is_team then\n    raise exception 'Only the Bubaly Team posts a team reply' using errcode = '42501';");
  });

  it('a new idea starts as the board starts one: every roadmap and tracker column at its default', () => {
    for (const clause of ["new.status is distinct from 'under_review'", 'new.admin_note is not null', 'new.pinned',
      'new.vote_count <> 0', 'new.comment_count <> 0', 'new.github_issue_number is not null',
      'new.github_issue_url is not null', 'new.github_state is not null', 'new.github_synced_at is not null']) {
      expect(idea, clause).toContain(clause);
    }
  });

  it('the board\'s own limits hold in the database too (CALHUB-O5)', () => {
    const actions = read('app/(app)/feedback/actions.ts');
    expect(actions).toContain('const IDEA_BURST = { limit: 5, windowMs: 60_000 } as const;');
    expect(actions).toContain('const IDEAS_PER_DAY = 20;');
    expect(idea).toContain("where i.author_id = auth.uid() and i.created_at > now() - interval '1 minute') >= 5 then");
    expect(idea).toContain("where i.author_id = auth.uid() and i.created_at > now() - interval '1 day') >= 20 then");
    // On the database's clock, one admission at a time per author: the caller
    // sends created_at (0197's default does not stop it), and two inserts in
    // flight would each count without the other.
    expect(at(idea, 'new.created_at := now();')).toBeLessThan(at(idea, "interval '1 minute'"));
    expect(at(idea, "perform pg_advisory_xact_lock(hashtextextended('feedback idea admission ' || auth.uid()::text, 0));"))
      .toBeLessThan(at(idea, "interval '1 minute'"));
  });

  it('INSERT only: the counters and the admin console\'s updates are untouched', () => {
    expect(sql).toContain('create trigger trg_feedback_comments_callers_own before insert on public.feedback_comments');
    expect(sql).toContain('create trigger trg_feedback_ideas_callers_own before insert on public.feedback_ideas');
    expect(sql).not.toMatch(/before insert or update|before update/);
    expect(sql).not.toMatch(/create policy|drop policy/);
    // The writes that carry team authority stay on the service client.
    expect(read('app/(app)/admin/feedback/actions.ts')).toContain('return { supabase: createServiceClient(), userId: user?.id ?? null };');
    expect(read('app/(app)/feedback/actions.ts')).toContain('const writer = team ? createServiceClient() : await createServer();');
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each forged column and name, with its controls', () => {
    const probe = read(P);
    for (const col of ['status', 'admin_note', 'pinned', 'vote_count', 'comment_count', 'github_issue_number', 'github_issue_url', 'github_state', 'github_synced_at']) {
      expect(probe, col).toContain(`('${col}', `);
    }
    expect(probe).toContain("display_name = case family_id when '00000000-0000-4000-8527-0000000000f1' then '  Ada ' else 'Bubaly Team' end");
    expect(probe).toContain("('(the server) post a team reply', 'service_role', '',");
    expect(probe).toContain('-- N1. Both guards disabled.');
    expect(probe).toContain('-- M1. The name check answers yes to any name.');
    expect(probe).toContain("('posted a sixth idea within a minute', 5, interval '30 seconds', 'minute'),");
    expect(probe).toContain("('posted a twenty-first idea within a day', 20, interval '2 hours', 'day'),");
    // The review on #1126: names wrapped in what JavaScript's trim() trims, the
    // team's name however it is spaced, the caller's own created_at, and a
    // second insert in flight.
    expect(probe).toContain("E'\\tCleo\\n', 'adult', true),");
    expect(probe).toContain("E'\\u00A0Dee\\u2003', 'teen', true),");
    expect(probe).toContain("E'\\tBubaly Team\\n', 'adult', true),");
    expect(probe).toContain("E'Bubaly\\u00A0Team', 'adult', true);");
    expect(probe).toContain("('00000000-0000-4000-8527-0000000000a7',E'\\tBubaly Team\\n@example.com')");
    expect(probe).toContain("('posted a sixth idea within a minute, backdating each', 0, 5, 'minute'),");
    expect(probe).toContain("('posted a twenty-first idea within a day, backdating her last five', 16, 4, 'day')) v(what, earlier, own, want) loop");
    expect(probe).toContain("elsif stamped is distinct from now() then");
    expect(probe).toContain("perform dblink_send_query('c0527_other', format($q$");
    expect(probe).toContain("perform set_config('lock_timeout', '20s', true);");
  });

  it('the workflow shows the failure, applies 0527 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema lets anyone post as the Bubaly Team and forge the roadmap')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-post-on-the-idea-board-is-the-callers-own: OK'");
    for (const line of [
      '"Ada posted a sixth idea within a minute, backdating each (OK 1)"',
      '"Ada posted a twenty-first idea within a day, backdating her last five (OK 1)"',
      '"Ada\'s idea kept the created_at she gave it"',
      '"a second insert of Ada\'s went ahead while her first was in flight"',
      '"Eve commented under her display name as stored"',
      '"Fay commented as \\"Bubaly<NBSP>Team\\", her own display name (OK 1)"',
      '"Gil commented as E\'\\tBubaly Team\\n\', the local part of Gil\'s email (OK 1)"',
    ]) expect(wf, line).toContain(line);
    for (const probe of ['definer-functions-check-their-caller', 'privileged-rpc-grants', 'family-erasure-leaves-nothing', 'plpgsql-bodies-resolve']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
