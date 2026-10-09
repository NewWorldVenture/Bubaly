import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Only a pre-created, fresh local fixture database is accepted. No remote options.
if (process.argv.length !== 2) throw new Error('The grocery fixture accepts no options.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = 'docs/final-audit/rollout-20261008/';
const env = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
const sql = (input) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', 'bubaly-audit-grocery-20261008', 'psql', '-U', 'postgres', '-d', 'bubaly_grocery_fixture_20261008', '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const read = (file) => readFileSync(root + file, 'utf8');
const evidenceFile = directory + 'grocery-rpc-boundary.json';
const captured = JSON.parse(read(evidenceFile));
const original = captured.functions.find((row) => row.signature === 'grocery_from_meal_plan(uuid,date,date,uuid)').definition;
const guardFile = 'supabase/migrations/0311_family_scoped_references.sql';
const repairFile = 'supabase/migrations/0313_meal_plan_groceries_stay_in_one_family.sql';
const guard = read(guardFile);
const repair = read(repairFile);
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const userA = '00000000-0000-4000-8000-000000000003';
const mealA = '00000000-0000-4000-8000-000000000004';
const mealB = '00000000-0000-4000-8000-000000000005';
const listA = '00000000-0000-4000-8000-000000000006';
const listB = '00000000-0000-4000-8000-000000000007';
const caller = `set role authenticated; set request.jwt.claim.sub='${userA}'; set request.jwt.claim.role='authenticated';`;
const invoke = (list) => `select public.grocery_from_meal_plan('${A}','2026-10-08','2026-10-08','${list}');`;
const reject = (command, expected) => {
  let message = '';
  try { sql(command); } catch (error) { message = String(error.stderr); }
  assert(message.includes(expected), `Expected refusal: ${expected}; got ${message}`);
};
sql(`
do $$ begin
  if current_database() <> 'bubaly_grocery_fixture_20261008' then raise exception 'Not the isolated grocery fixture'; end if;
end $$;
create role authenticated;
create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create function public.is_family_member(family uuid) returns boolean language sql stable as $$ select coalesce(auth.uid()='${userA}'::uuid and family='${A}'::uuid,false) $$;
create table public.meals(id uuid primary key, family_id uuid not null, ingredients jsonb);
create table public.meal_plans(id uuid primary key default gen_random_uuid(), family_id uuid not null, meal_id uuid references public.meals(id), plan_date date);
create table public.grocery_lists(id uuid primary key default gen_random_uuid(), family_id uuid not null, name text, created_by uuid);
create table public.grocery_items(id uuid primary key default gen_random_uuid(), family_id uuid not null, list_id uuid references public.grocery_lists(id), name text, quantity text, created_by uuid);
grant usage on schema public, auth to authenticated;
grant select, insert, update on public.meals, public.meal_plans, public.grocery_lists, public.grocery_items to authenticated;
insert into public.meals values ('${mealA}','${A}','[{"name":"A-fixture","qty":"1"}]'),('${mealB}','${B}','[{"name":"B-fixture","qty":"1"}]');
insert into public.meal_plans(family_id,meal_id,plan_date) values ('${A}','${mealA}','2026-10-08'),('${A}','${mealB}','2026-10-08');
insert into public.grocery_lists(id,family_id,name) values ('${listA}','${A}','A fixture'),('${listB}','${B}','B fixture');
alter table public.meals enable row level security;
alter table public.meal_plans enable row level security;
alter table public.grocery_lists enable row level security;
alter table public.grocery_items enable row level security;
create policy family on public.meals to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy family on public.meal_plans to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy family on public.grocery_lists to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
create policy family on public.grocery_items to authenticated using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
${original}
`);
const body = () => sql("select pg_get_functiondef('public.grocery_from_meal_plan(uuid,date,date,uuid)'::regprocedure);");
const beforeBody = body();
assert.equal(sql(caller + `select count(*) from public.meals where family_id='${B}';`), '0');
sql(caller + invoke(listA));
assert.equal(sql(caller + "select count(*) from public.grocery_items where name='B-fixture';"), '1');
sql(caller + invoke(listB));
assert.equal(sql(`select count(*) from public.grocery_items where family_id='${A}' and list_id='${listB}';`), '2');
sql('delete from public.grocery_items;');

// The production-missing helper prevents standalone0313 application, atomically.
reject('begin;' + repair + 'commit;', 'reference_shares_family');
assert.equal(body(), beforeBody);
sql('begin;' + guard + repair + 'rollback;');
assert.equal(body(), beforeBody);
assert.equal(sql("select to_regprocedure('public.reference_shares_family()') is null;"), 't');
assert.equal(sql("select count(*) from pg_trigger where tgname in ('trg_meal_plans_meal_id_family','trg_grocery_items_list_id_family');"), '0');
sql('begin;' + guard + repair + 'commit;');
sql('begin;' + guard + repair + 'commit;');
assert.equal(sql("select count(*) from pg_trigger where tgname in ('trg_meal_plans_meal_id_family','trg_grocery_items_list_id_family');"), '2');
assert.equal(sql(`select count(*) from public.meal_plans where family_id='${A}' and meal_id='${mealB}';`), '1');
sql(caller + invoke(listA));
assert.equal(sql(caller + "select coalesce(string_agg(name,',' order by name),'') from public.grocery_items;"), 'A-fixture');
reject(caller + invoke(listB), 'That list belongs to another family');
assert.equal(sql('select count(*) from public.grocery_items;'), '1');
reject(caller + `insert into public.meal_plans(family_id,meal_id,plan_date) values ('${A}','${mealB}','2026-10-08');`, 'points at a row in another family');
reject(caller + `insert into public.grocery_items(family_id,list_id,name) values ('${A}','${listB}','bad fixture');`, 'points at a row in another family');
sql(caller + `begin; insert into public.meal_plans(family_id,meal_id,plan_date) values ('${A}','${mealA}','2026-10-08'); insert into public.grocery_items(family_id,list_id,name) values ('${A}','${listA}','healthy fixture'); rollback;`);
reject('set role authenticated;' + invoke(listA), 'Not a member of this family');

const files = [directory + '0313-grocery.fixture.mjs', evidenceFile, guardFile, repairFile].map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(root + path)).digest('hex') }));
writeFileSync(root + directory + '0313-grocery.fixture-results.json', JSON.stringify({ database: sql('select version();'), scope: 'Fresh local PostgreSQL, four minimal tables, synthetic two-family data and a one-user membership stub. Exact captured grocery body and unchanged0311/0313 migration bytes. The other0311 tables are absent and their wiring is skipped; this is not a full schema/role rehearsal.', files, checks: { baselineOtherFamilyMealHiddenByRls: true, baselineDefinerCopiesForeignMeal: true, baselineSuppliedForeignListAccepted: true, missingHelperRefusesStandalone0313AndRollsBack: true, transactionRollbackRestoresBodyAndRemovesHelperAndTriggers: true, repeatApplication: true, existingCrossFamilyPlanPreserved: true, fixedRpcCopiesOnlyOwnFamilyMeal: true, suppliedForeignListRefusedBeforeWrite: true, futureCrossFamilyPlanAndItemRefused: true, healthySameFamilyWrites: true, unauthenticatedRefused: true } }, null, 2) + '\n');
console.log('0313 grocery fixture passed: two baseline failures, dependency refusal, rollback, replay, RLS control, family boundaries and historical-row preservation.');
