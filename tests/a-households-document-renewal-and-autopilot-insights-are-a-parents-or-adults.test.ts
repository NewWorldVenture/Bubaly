import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

// The held 0531 (OPSD-O08, with the reviewer's corrected policy, OPSD-O09).
// daily_insights (0141) is read by every member, and the household's rows of
// the document, renewal and autopilot kinds are a parent's or adult's reading.
// The insight of the day already shows a non-manager only their own reading;
// 0531 keeps the household's rows of those kinds from being read at rest.

const M = 'supabase/reserved/0531_a_households_document_renewal_and_autopilot_insights_are_a_parents_or_adults.sql';
const P = 'docs/audit/reserved/a-households-document-renewal-and-autopilot-insights-are-a-parents-or-adults-check.sql';
const W = '.github/workflows/daily-insight-reading-runtime.yml';
const read = (p: string) => readFileSync(p, 'utf8');

describe('the household\'s document, renewal and Autopilot insights are a parent\'s or adult\'s (0531)', () => {
  const sql = read(M);

  it('one restrictive read, by kind, for a parent or adult or the member whose reading it is', () => {
    expect(sql).toContain('create policy "A document, renewal or Autopilot insight is a manager\'s" on public.daily_insights\n'
      + '  as restrictive for select to authenticated\n'
      + "  using (kind not in ('document', 'renewal', 'autopilot')\n"
      + '         or public.can_manage_family(family_id)\n'
      + '         or (member_id is not null and public.is_self_member(member_id)));');
    // 0141's policies stay as they are: only this one is added (and dropped
    // first, so the file runs twice).
    expect(sql.match(/create policy/g)).toHaveLength(1);
    expect(sql.match(/drop policy if exists "A document, renewal or Autopilot insight is a manager's" on public.daily_insights;/g)).toHaveLength(1);
    expect(sql).not.toMatch(/(drop|create|alter) policy (if exists )?"?daily_insights_(select|insert|update)/);
    expect(sql).not.toMatch(/create (or replace )?(function|trigger)/);
  });

  it('the kinds are the insight of the day\'s own', () => {
    const kinds = read('lib/home/insight-of-day.ts');
    for (const kind of ['document', 'renewal', 'autopilot']) {
      expect(kinds, kind).toContain(`id: '${kind}', kind: '${kind}',`);
    }
  });

  it('the app writes and reads as the finding\'s body assumes', () => {
    const home = bodyOf(read('components/dashboard/ai-home-dashboard.tsx'),
      'let insightRow:', '} catch { /* daily_insights not migrated yet — skip the hero */ }');
    // A non-manager's reading is theirs and only starts a kind nobody has
    // written today; a parent's or adult's is the household's.
    expect(home).toContain('member_id: manager ? null : myMemberId,');
    expect(home).toContain("supabase.from('daily_insights').upsert(rows, { onConflict: 'family_id,as_of_date,kind', ignoreDuplicates: true })");
    // A non-manager is shown a candidate only under the day's row of its kind
    // they can read, so a hidden household row hides that kind from them.
    expect(at(home, 'const row = active.find((r) => r.kind === c.kind);'))
      .toBeLessThan(at(home, 'return row ? [{ ...c, id: row.id }] : [];'));
  });
});

describe('the probe and its workflow', () => {
  it('the probe measures each role and kind, the app\'s writes, and carries its controls', () => {
    const probe = read(P);
    for (const role of ["('teen', ", "('child', ", "('caregiver', ", "('guest', "]) expect(probe, role).toContain(role);
    for (const kind of ["('document', ", "('renewal', ", "('autopilot', "]) expect(probe, kind).toContain(kind);
    expect(probe).toContain('on conflict (family_id, as_of_date, kind) do nothing');
    expect(probe).toContain('on conflict (family_id, as_of_date, kind) do update set title = excluded.title, member_id = excluded.member_id');
    expect(probe).toContain('-- N1. The policy dropped.');
    expect(probe).toContain('-- M1. Autopilot left out of the policy\'s kinds.');
  });

  it('the workflow shows the failure, applies 0531 twice, and re-runs the released probes', () => {
    const wf = read(W);
    expect(at(wf, "- name: The released schema lets a child read the household's document, renewal and Autopilot insights")).toBeLessThan(at(wf, `-f ${M}\n`));
    expect(wf.split(`psql -X -v ON_ERROR_STOP=1 -q -f ${M}\n`)).toHaveLength(3);
    expect(wf).toContain("grep -qE 'CONTROL|PRECONDITION'");
    expect(wf).toContain("grep -qF 'a-households-document-renewal-and-autopilot-insights-are-a-parents-or-adults: OK'");
    for (const probe of ['rls-sweep', 'gated-write-tables', 'family-erasure-leaves-nothing', 'an-erasure-actually-erases']) {
      expect(wf, probe).toContain(`docs/audit/${probe}-check.sql`);
    }
  });
});
