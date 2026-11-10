import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// A-10 — static guard that every Meals / Groceries / Food table is family-scoped
// (tenant-isolated) in its defining migration, so cross-family isolation on the
// A-10 surface cannot silently regress. This complements agent-01's live global
// proof (PLA-0415: 353/353 tables RLS-enabled, family B reads 0 rows of family A,
// cross-family writes blocked, verified on the PG16 harness) with an A-10-specific
// pin so a future migration can't drop the policy on one of these tables unnoticed.
//
// Every policy below scopes to the caller's own family — either via the shared
// SECURITY DEFINER helper `public.is_family_member(family_id)` or the equivalent
// inline `family_id in (select family_id from family_members where user_id =
// auth.uid())`. Neither lets family B touch family A's rows.
const mig = (n: string) => readFileSync(`supabase/migrations/${n}`, 'utf8');

const rls0004 = mig('0004_rls.sql');
const grocery0025 = mig('0025_fix_grocery_lists_rls.sql');
const recipes0014 = mig('0014_core_platform.sql');
const pantry0080 = mig('00800_food_household.sql');
const dining0104 = mig('0104_dining_out.sql');
const hub0115 = mig('0115_meals_hub.sql');

// The defining migrations above are not the last word: later migrations drop
// and re-create some of these policies, so the cases below also read the
// migration that defines each policy today, without its comments.
const uncommented = (sql: string) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const repair0107 = uncommented(mig('0107_meals_media_rls.sql'));
const recipes0426 = uncommented(mig('0426_a_policy_should_say_what_it_checks.sql'));
const health0430 = uncommented(mig('0430_a_health_record_is_not_a_siblings_to_rewrite.sql'));
const sweep0481 = uncommented(mig('0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.sql'));
const FOOD_TABLES = ['meals', 'meal_plans', 'grocery_lists', 'grocery_items', 'family_recipes', 'pantry_items', 'dining_out', 'nutrition_logs', 'family_favorites'];

describe('A-10 food tables are family-scoped in their migrations', () => {
  it('meals / meal_plans / grocery_lists / grocery_items get is_family_member RLS in 0004', () => {
    // The loop in 0004 enables RLS + creates all four CRUD policies for each table.
    for (const t of ['meals', 'meal_plans', 'grocery_lists', 'grocery_items']) {
      expect(rls0004, `${t} must be in the 0004 family-scoped RLS loop`).toContain(`'${t}'`);
    }
    expect(rls0004).toMatch(/enable row level security/i);
    expect(rls0004).toContain('for select using (public.is_family_member(family_id))');
    expect(rls0004).toContain('for insert with check (public.is_family_member(family_id))');
    expect(rls0004).toContain('for delete using (public.is_family_member(family_id))');
  });

  it('grocery_lists / grocery_items RLS is re-asserted family-scoped in 0025', () => {
    expect(grocery0025).toContain("ARRAY['grocery_lists', 'grocery_items']");
    expect(grocery0025).toContain('ENABLE ROW LEVEL SECURITY');
    expect(grocery0025).toContain('public.is_family_member(family_id)');
    // insert path was the original bug — must carry a family-scoped WITH CHECK
    expect(grocery0025).toContain('FOR INSERT WITH CHECK (public.is_family_member(family_id))');
  });

  it('family_recipes is RLS-enabled and family-scoped in 0014', () => {
    expect(recipes0014).toContain('alter table public.family_recipes enable row level security');
    expect(recipes0014).toContain('on public.family_recipes for all');
    expect(recipes0014).toContain('family_id in (select family_id from public.family_members where user_id = auth.uid())');
    // 0426 drops that policy and re-creates it under the same name: its loop is
    // the definition a database has today.
    const listed = "('family_recipes',      'family members can manage recipes')";
    expect(recipes0426).toContain(listed);
    const loop = recipes0426.slice(recipes0426.indexOf(listed));
    const rewrite = loop.slice(0, loop.indexOf('end loop;'));
    expect(rewrite).toContain("execute format('drop policy %I on public.%I', spec.pol, spec.tbl);");
    expect(rewrite).toContain(
      "'create policy %I on public.%I for all to public '\n"
      + "      'using (public.is_family_member(family_id)) '\n"
      + "      'with check (public.is_family_member(family_id))'",
    );
  });

  it('pantry_items is RLS-enabled and family-scoped in 0080', () => {
    expect(pantry0080).toMatch(/pantry_items/);
    expect(pantry0080).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(pantry0080).toContain('USING (public.is_family_member(family_id))');
    expect(pantry0080).toContain('WITH CHECK (public.is_family_member(family_id))');
  });

  it('dining_out is RLS-enabled and family-scoped in 0104', () => {
    expect(dining0104).toContain('alter table public.dining_out enable row level security');
    expect(dining0104).toContain('on public.dining_out');
    expect(dining0104).toContain('using (public.is_family_member(family_id))');
    expect(dining0104).toContain('with check (public.is_family_member(family_id))');
    // 0481 drops every permissive policy on the table, 0104's included, and
    // writes these four: they are the policies a database has today.
    const anchor = "tablename='dining_out' and permissive='PERMISSIVE'";
    expect(sweep0481).toContain(anchor);
    const block = sweep0481.slice(sweep0481.indexOf(anchor));
    const live = block.slice(0, block.indexOf('end $$;'));
    expect(live).toContain("execute format('drop policy %I on public.dining_out', p.policyname);");
    const policies = [...live.matchAll(/create policy (dining_out_\w+) on public\.dining_out for (\w+) to authenticated([^;]*);/g)];
    expect(policies.map((m) => `${m[1]} for ${m[2]}`)).toEqual([
      'dining_out_select for select',
      'dining_out_insert for insert',
      'dining_out_update for update',
      'dining_out_delete for delete',
    ]);
    const [select, insert, update, remove] = policies.map((m) => m[3].trim());
    expect(select).toBe('using (public.is_family_member(family_id))');
    expect(insert).toMatch(/^with check \(public\.is_family_member\(family_id\) and /);
    expect(update).toMatch(/^using \(public\.is_family_member\(family_id\) and [^\n]*\n\s*with check \(public\.is_family_member\(family_id\) and /);
    expect(remove).toMatch(/^using \(public\.can_manage_family\(family_id\) or \(public\.is_family_member\(family_id\) and /);
  });

  it('nutrition_logs + family_favorites get is_family_member RLS on all four ops in 0115', () => {
    expect(hub0115).toContain('create table if not exists public.family_favorites');
    expect(hub0115).toContain('create table if not exists public.nutrition_logs');
    expect(hub0115).toMatch(/enable row level security/i);
    // 0115 builds the four policies via format() with is_family_member on each op
    expect(hub0115).toContain('for select using (public.is_family_member(family_id))');
    expect(hub0115).toContain('for insert with check (public.is_family_member(family_id))');
    expect(hub0115).toContain('for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))');
    expect(hub0115).toContain('for delete using (public.is_family_member(family_id))');
  });

  it('the later rewrites of the planner and nutrition policies in 0107 and 0430 stay family-scoped', () => {
    const loop0107 = repair0107.slice(repair0107.indexOf('foreach t in array array['), repair0107.indexOf('end loop;'));
    for (const t of ['meals', 'meal_plans', 'grocery_lists', 'grocery_items', 'family_recipes']) {
      expect(loop0107, `${t} must be in the 0107 repair loop`).toContain(`'${t}'`);
    }
    expect(loop0107).toContain('for select using (public.is_family_member(family_id))');
    expect(loop0107).toContain('for insert with check (public.is_family_member(family_id))');
    expect(loop0107).toContain('for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))');
    expect(loop0107).toContain('for delete using (public.is_family_member(family_id))');

    const listed = "('nutrition_logs',  'A')";
    expect(health0430).toContain(listed);
    const loop0430 = health0430.slice(health0430.indexOf(listed), health0430.indexOf('for pol in'));
    expect(loop0430).toContain("for select to authenticated using (public.is_family_member(family_id))'");
    expect(loop0430).toContain("for insert to authenticated with check (public.is_family_member(family_id))'");
    expect(loop0430).toContain("owner := 'public.can_manage_family(family_id) or created_by = auth.uid()'");
    expect(loop0430).toContain("for update to authenticated using (%s) with check (%s)'");
    expect(loop0430).toContain("for delete to authenticated using (%s)'");
  });

  it('no migration writes a policy on these tables besides the ones pinned above', () => {
    // The header's promise. A migration that creates, drops or alters a policy
    // in a statement (or DO block) naming one of these tables has to be added
    // here, and its policy pinned in a case above, before this passes again.
    const writers: Record<string, string[]> = Object.fromEntries(FOOD_TABLES.map((t) => [t, []]));
    for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
      const sql = uncommented(mig(file));
      const blocks = [...sql.matchAll(/\bdo\s+(\$\w*\$)[\s\S]*?\1/gi)].map((m) => m[0]);
      const statements = blocks.reduce((text, block) => text.replace(block, () => ''), sql).split(';');
      for (const chunk of [...blocks, ...statements]) {
        if (!/\b(create|drop|alter)\s+policy\b/i.test(chunk)) continue;
        for (const t of FOOD_TABLES) {
          if (new RegExp(`(public\\.|')${t}\\b`).test(chunk) && !writers[t].includes(file)) writers[t].push(file);
        }
      }
    }
    expect(writers).toEqual({
      meals: ['0004_rls.sql', '0107_meals_media_rls.sql'],
      meal_plans: ['0004_rls.sql', '0107_meals_media_rls.sql'],
      grocery_lists: ['0004_rls.sql', '0025_fix_grocery_lists_rls.sql', '0107_meals_media_rls.sql'],
      grocery_items: ['0004_rls.sql', '0025_fix_grocery_lists_rls.sql', '0107_meals_media_rls.sql'],
      family_recipes: ['0014_core_platform.sql', '0107_meals_media_rls.sql', '0426_a_policy_should_say_what_it_checks.sql'],
      pantry_items: ['00800_food_household.sql'],
      dining_out: ['0104_dining_out.sql', '0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.sql'],
      nutrition_logs: ['0115_meals_hub.sql', '0430_a_health_record_is_not_a_siblings_to_rewrite.sql'],
      family_favorites: ['0115_meals_hub.sql'],
    });
  });
});
