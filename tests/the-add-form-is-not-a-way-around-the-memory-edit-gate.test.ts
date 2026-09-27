// m21 — Family Memory's two write paths disagreed about who may write what.
//
// `updateFact` (the pencil, and the pin) refuses a non-manager whose edit would
// leave the row sensitive:
//
//   "Only a parent or adult can file a memory as medical or account information."
//
// `rememberFact` (the Add button) applied no role rule at all. Its two refusals
// keyed on ACTOR KIND — "was this Bubaly rather than a person" — and a signed-in
// teen is `actorKind: 'member'` with `source: 'user'`, so neither fired. The
// result a family met on /dashboard/knowledge: a teen typed label "Allergies",
// value "Peanuts — carries an EpiPen", got "Saved to family memory", and then
// could not correct it, because the pencil evaluates the SAME predicate and says
// no. She could still delete it. Write, destroy, but not fix.
//
// The category half of that predicate is already a database boundary — 0264's
// `family_facts_insert` refuses `medical` and `account` to a non-manager — so
// only the SENSITIVE_TERMS half was reachable. This test pins the terms half,
// because that is the half that got through.
//
// Second, and larger: `rememberConfirmed` upserts by (family_id, ilike label,
// member_id) with no role and no member check, so Add-by-the-same-label reached
// rows `factForWrite` refuses — including the household fact a PARENT wrote at
// family level (member_id null, which is the form's default "The family"). A
// member who may not edit that row could replace its value from the create
// form. That is an authorization rule, so it is mirrored in the database by
// 0385: an action-only check is not a boundary, since the browser holds an
// RLS-scoped client of its own.
//
// Third, the other side of that coin. The create form still lets a teen file a
// fact about the whole family or a sibling, so a rule keyed on `member_id`
// alone would refuse her the pencil, the restate and the trash on the row she
// had just written. The rule is "about me OR written by me" (`mayChangeFact`,
// and 0385's `created_by = auth.uid()` branch): whatever she may file, she may
// fix — and the household fact a PARENT wrote stays out of her reach.
//
// The database half is PROVEN behaviourally by
// docs/audit/a-member-only-rewrites-their-own-memory-check.sql, which CI runs
// against a fully replayed schema (.github/workflows/ci.yml, docs/audit/
// run-probes.sh globs *-check.sql) as the real `authenticated` role, with a
// negative control for UPDATE and one for DELETE. The last describe block here
// is only a static guard on the migration's text, and says so.
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { forgetFact, rememberFact, updateFact } from '@/lib/services/memory';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function scopeAs(role: 'parent' | 'teen', memberId: string): ServiceScope {
  return {
    db, familyId: FAMILY, userId: `user-${memberId}`, memberId,
    role, actorKind: 'member', tz: 'America/New_York',
  };
}

const factsNamed = (label: string) =>
  db.table('family_facts').filter((r) => r.family_id === FAMILY && String(r.label).toLowerCase() === label.toLowerCase());

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      family_facts: { notes: null, is_pinned: false, source: 'user', confidence: 100, expires_at: null, member_id: null },
      audit_logs: { resource_id: null, metadata: null },
    },
  });
});

describe('a memory a member would not be allowed to correct', () => {
  it('refuses the teen at the Add button, not one screen later at the pencil', async () => {
    const created = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Allergies',
      content: 'Peanuts — carries an EpiPen in her bag',
      category: 'important',
      source: 'user',
      memberId: 'teen',
      confidence: 100,
    });

    // The outcome a family notices: she is told at the moment she types it, and
    // nothing is stored that she would then be unable to fix.
    expect(created).toMatchObject({ ok: false, code: 'denied' });
    expect(created.ok ? '' : created.error).toBe('Only a parent or adult can file a memory as medical or account information.');
    expect(factsNamed('Allergies')).toHaveLength(0);
  });

  it('gives the create path the same answer the edit path already gave', async () => {
    db.seed('family_facts', [
      { id: 'hers', family_id: FAMILY, member_id: 'teen', category: 'important', label: 'Snack', value: 'crackers' },
    ]);
    const edited = await updateFact(scopeAs('teen', 'teen'), 'hers', { label: 'Allergies', value: 'Peanuts' });
    const created = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Allergies', content: 'Peanuts', category: 'important', source: 'user', memberId: 'teen', confidence: 100,
    });
    expect(edited.ok).toBe(false);
    expect(created.ok).toBe(false);
    expect(created.ok ? '' : created.error).toBe(edited.ok ? '' : edited.error);
  });

  it('still lets a parent record the allergy, which is whose job it is', async () => {
    const res = await rememberFact(scopeAs('parent', 'mum'), {
      key: 'Allergies', content: 'Peanuts — EpiPen in the hall drawer', category: 'important',
      source: 'user', memberId: 'teen', confidence: 100,
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(factsNamed('Allergies')[0]?.value).toBe('Peanuts — EpiPen in the hall drawer');
  });

  it('still lets the teen record an ordinary memory about herself', async () => {
    const res = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Shoe size', content: '6', category: 'important', source: 'user', memberId: 'teen', confidence: 100,
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(factsNamed('Shoe size')[0]?.value).toBe('6');
  });
});

describe('the Add form cannot reach a memory its author may not edit', () => {
  beforeEach(() => {
    // What a parent entered for the household: the form's default member is
    // "The family", which is member_id null. `created_by` is the PARENT's
    // login, so neither half of the teen's rule (about her, written by her)
    // reaches it.
    db.seed('family_facts', [
      { id: 'household', family_id: FAMILY, member_id: null, category: 'important', label: 'Emergency contact', value: 'Grandma Ruth — 555 0101', created_by: 'user-mum' },
    ]);
  });

  it('does not let a teen replace what a parent entered for the household', async () => {
    const res = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Emergency contact', content: 'call me instead', category: 'important',
      source: 'user', memberId: null, confidence: 100,
    });
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    // The number Bubaly reads back when someone asks who to call is still the
    // parent's.
    expect(factsNamed('Emergency contact')).toHaveLength(1);
    expect(factsNamed('Emergency contact')[0]?.value).toBe('Grandma Ruth — 555 0101');
  });

  it('gives the same refusal the pencil gives on that row', async () => {
    const viaPencil = await updateFact(scopeAs('teen', 'teen'), 'household', { value: 'call me instead' });
    const viaAdd = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Emergency contact', content: 'call me instead', category: 'important',
      source: 'user', memberId: null, confidence: 100,
    });
    expect(viaPencil).toMatchObject({ ok: false, code: 'denied' });
    expect(viaAdd.ok ? '' : viaAdd.error).toBe(viaPencil.ok ? '' : viaPencil.error);
  });

  it('still updates the teen\'s OWN memory in place when she restates it', async () => {
    db.seed('family_facts', [
      { id: 'hers', family_id: FAMILY, member_id: 'teen', category: 'important', label: 'Shoe size', value: '5' },
    ]);
    const res = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Shoe size', content: '6', category: 'important', source: 'user', memberId: 'teen', confidence: 100,
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(factsNamed('Shoe size')).toHaveLength(1);
    expect(factsNamed('Shoe size')[0]?.value).toBe('6');
  });

  it('still lets a parent restate the household fact', async () => {
    const res = await rememberFact(scopeAs('parent', 'mum'), {
      key: 'Emergency contact', content: 'Grandma Ruth — 555 0199', category: 'important',
      source: 'user', memberId: null, confidence: 100,
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(factsNamed('Emergency contact')).toHaveLength(1);
    expect(factsNamed('Emergency contact')[0]?.value).toBe('Grandma Ruth — 555 0199');
  });
});

describe('what a member files, she can fix', () => {
  // The Add form's default member is "The family" and INSERT is open to every
  // member, so this is the ordinary way a teen writes a household fact.
  const fileBinDay = () => rememberFact(scopeAs('teen', 'teen'), {
    key: 'Bin day', content: 'Thursday', category: 'important', source: 'user', memberId: null, confidence: 100,
  });

  it('lets the teen restate a household fact she filed herself', async () => {
    expect((await fileBinDay()).ok).toBe(true);
    const res = await rememberFact(scopeAs('teen', 'teen'), {
      key: 'Bin day', content: 'Wednesday', category: 'important', source: 'user', memberId: null, confidence: 100,
    });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(res.ok && res.data.kind === 'fact' ? res.data.updated : null).toBe(true);
    expect(factsNamed('Bin day')).toHaveLength(1);
    expect(factsNamed('Bin day')[0]?.value).toBe('Wednesday');
  });

  it('lets her correct it with the pencil, and forget it', async () => {
    const filed = await fileBinDay();
    const id = filed.ok && filed.data.kind === 'fact' ? filed.data.fact.id : '';
    expect(id).not.toBe('');

    const edited = await updateFact(scopeAs('teen', 'teen'), id, { value: 'Wednesday', memberId: null });
    expect(edited.ok, edited.ok ? '' : edited.error).toBe(true);
    expect(factsNamed('Bin day')[0]?.value).toBe('Wednesday');

    const forgotten = await forgetFact(scopeAs('teen', 'teen'), id);
    expect(forgotten.ok, forgotten.ok ? '' : forgotten.error).toBe(true);
    expect(factsNamed('Bin day')).toHaveLength(0);
  });

  it('does not let a DIFFERENT non-manager touch it — authorship is per person, not per role', async () => {
    const filed = await fileBinDay();
    const id = filed.ok && filed.data.kind === 'fact' ? filed.data.fact.id : '';
    const sibling = scopeAs('teen', 'sib');
    expect(await updateFact(sibling, id, { value: 'Friday' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await forgetFact(sibling, id)).toMatchObject({ ok: false, code: 'denied' });
    expect(factsNamed('Bin day')[0]?.value).toBe('Thursday');
  });

  it('refuses re-pointing a memory a parent wrote about her, with the sentence rather than a database error', async () => {
    db.seed('family_facts', [
      { id: 'about-her', family_id: FAMILY, member_id: 'teen', category: 'important', label: 'Coat size', value: '12', created_by: 'user-mum' },
    ]);
    // Still hers to correct in place — it is about her.
    const kept = await updateFact(scopeAs('teen', 'teen'), 'about-her', { value: '14', memberId: 'teen' });
    expect(kept.ok, kept.ok ? '' : kept.error).toBe(true);
    // But moving it to the whole family would leave it neither about her nor
    // written by her: 0385's WITH CHECK refuses that, so the service says so
    // first, in the pencil's own words.
    const moved = await updateFact(scopeAs('teen', 'teen'), 'about-her', { memberId: null });
    expect(moved).toMatchObject({ ok: false, code: 'denied' });
    expect(moved.ok ? '' : moved.error).toBe('Only a parent or adult can change a memory about someone else.');
    expect(db.table('family_facts').find((r) => r.id === 'about-her')?.member_id).toBe('teen');
  });
});

describe('the migration text (static guard only — the behaviour is proven by the audit probe)', () => {
  // This block can only say the migration SAYS the right thing. Whether the
  // policy does it is measured by the probe named below, as `authenticated`,
  // against every migration replayed — see the header of this file.
  const sql = readFileSync('supabase/migrations/0385_a_member_only_rewrites_their_own_memory.sql', 'utf8');
  const probe = 'docs/audit/a-member-only-rewrites-their-own-memory-check.sql';

  /** The body of one `create policy <name> on public.family_facts … ;` statement, comments excluded. */
  const policy = (name: string): string => {
    const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    const at = code.indexOf(`create policy ${name} on public.family_facts`);
    expect(at, `${name} is not created by 0385`).toBeGreaterThanOrEqual(0);
    return code.slice(at, code.indexOf(';', at));
  };
  const clause = (body: string, head: 'using' | 'with check'): string => {
    const start = body.indexOf(`${head} (`);
    expect(start, `no ${head} clause`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = start + head.length + 1; i < body.length; i++) {
      if (body[i] === '(') depth++;
      if (body[i] === ')' && --depth === 0) return body.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${head} clause`);
  };

  const rule = '(public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid())';
  const gate = "(category not in ('medical', 'account') or public.can_manage_family(family_id))";

  it('puts the manager-or-self-or-author rule, and 0264\'s category gate, on UPDATE\'s USING and WITH CHECK', () => {
    const update = policy('family_facts_update');
    for (const side of [clause(update, 'using'), clause(update, 'with check')]) {
      expect(side).toContain(rule);
      expect(side).toContain(gate);
    }
  });

  it('puts the same rule and gate on DELETE\'s USING', () => {
    const del = clause(policy('family_facts_delete'), 'using');
    expect(del).toContain(rule);
    expect(del).toContain(gate);
  });

  it('drops each policy it creates first, so a replay does not fail on "already exists"', () => {
    const created = [...sql.matchAll(/^create policy (\w+) on public\.family_facts/gm)].map((m) => m[1]);
    expect(created.sort()).toEqual(['family_facts_delete', 'family_facts_update']);
    for (const name of created) {
      const drop = sql.indexOf(`drop policy if exists ${name} on public.family_facts;`);
      expect(drop, `${name} is created without a drop first`).toBeGreaterThanOrEqual(0);
      expect(drop).toBeLessThan(at(sql, `create policy ${name} on public.family_facts`));
    }
  });

  it('has a behavioural probe in the directory CI globs, naming this migration', () => {
    expect(existsSync(probe)).toBe(true);
    expect(readFileSync(probe, 'utf8')).toContain('HOLDS: supabase/migrations/0385_a_member_only_rewrites_their_own_memory.sql');
  });
});
