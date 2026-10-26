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
    expect(name).toContain("nullif(btrim(m.display_name), '') = p_name");
    expect(name).toContain("nullif(split_part(u.email, '@', 1), '') = p_name");
    expect(name).toContain("p_name = 'A Bubaly family'");
    expect(name).toContain("and lower(btrim(p_name)) <> 'bubaly team'");
    expect(name).toContain('where m.user_id = auth.uid()');
    expect(sql).toContain('revoke all on function public.feedback_name_is_the_callers_own(text) from public, anon, authenticated;');
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
  });

  it('the workflow shows the failure, applies 0527 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, '- name: The released schema lets anyone post as the Bubaly Team and forge the roadmap')).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-post-on-the-idea-board-is-the-callers-own: OK'");
    for (const probe of ['definer-functions-check-their-caller', 'privileged-rpc-grants', 'family-erasure-leaves-nothing', 'plpgsql-bodies-resolve']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
