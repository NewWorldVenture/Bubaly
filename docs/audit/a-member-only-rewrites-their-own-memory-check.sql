-- ── A member only rewrites their own memory (0385) ──────────────────────────
--
-- HOLDS: supabase/migrations/0385_a_member_only_rewrites_their_own_memory.sql
--
-- Before 0385, `family_facts_update` (0264) narrowed the table by CATEGORY
-- only: on every ordinary category any member of the household could UPDATE
-- any row. `lib/services/memory/index.ts factForWrite` has always carried a
-- member rule — keyed on member_id then, on member_id or authorship now
-- (`mayChangeFact`: a manager, or `fact.member_id === scope.memberId`, or
-- `fact.created_by === scope.userId`):
--
--   if (!mayChangeFact(scope, data))
--     return fail('Only a parent or adult can change a memory about someone else.')
--
-- but the knowledge module reads `family_facts` from the browser on the
-- caller's own RLS-bound client, so a teen could skip the service entirely and
-- send `.from('family_facts').update({ value }).eq('id', …)` — and the row the
-- family reads back when someone asks "who do we call?" (a household-level
-- "Emergency contact" a parent entered, member_id null) became whatever she
-- typed. 0385 adds `can_manage_family(family_id) or is_self_member(member_id)
-- or created_by = auth.uid()` to UPDATE's USING and WITH CHECK and to DELETE's
-- USING, keeping 0264's category gate on both. The author branch is there
-- because INSERT stays open: a member may file a household or sibling fact,
-- and a rule keyed on member_id alone would then refuse her the correction,
-- the restatement and the delete of the row she had just written.
--
-- What this file proves, as the real `authenticated` role with a real
-- `request.jwt.claim.sub`, in one transaction that is rolled back:
--
--   1. a teen cannot rewrite a household-level memory (member_id null);
--   2. a teen cannot rewrite a sibling's memory;
--   3. a teen cannot push a row a PARENT wrote about her out of her reach —
--      re-point it at a sibling, or at "the family" — while it stays the
--      parent's row (the WITH CHECK half; asserted as 42501 with Postgres's RLS
--      wording, not as "anything raised"). The ONE way past that is measured
--      too (3c): re-pointing it AND writing her own uid into created_by in the
--      same statement LANDS, because WITH CHECK then passes on the author
--      branch. 0385 accepts that on purpose — `created_by` is not pinned, and
--      the end state (a row she owns, about her sibling) is one she reaches
--      anyway by forgetting the parent's row (9's control) and filing her own
--      (6b) — so this file asserts it lands rather than letting claim 3 read
--      wider than the policy is;
--   4. a teen cannot CLAIM a household or sibling memory by re-pointing it at
--      herself, nor by writing her own uid into its created_by (the USING
--      half, from the other direction). The created_by write is a different
--      statement from the control's, so it carries its own control — the same
--      write on the row about her lands — before its refusals are read;
--   5. 0264's category gate survived the rewrite of the policy, measured with
--      WHERE-less statements so the SELECT policy — which carries the same
--      gate — is never consulted and cannot be the thing that said no;
--   6. what 0385 deliberately left alone is still alone: the teen still SEES
--      the household's and her sibling's memories, and still INSERTS a
--      household-level one;
--   7. a parent AND an adult still can do all of 1–4 (a guard that refuses
--      everyone is not a boundary);
--   8. what a teen WROTE stays hers: she rewrites, re-points and forgets a
--      household memory she filed herself — the author branch, and the reason
--      it exists (without it 6's INSERT would file a fact she could never fix);
--   9. DELETE carries the same rule: a teen cannot forget the household's or
--      her sibling's memory (both written by the parent), and — its own control,
--      run first — can forget one about her; a parent can forget the
--      household's;
--  10. the policies' text still names the rule — `is_self_member`,
--      `created_by = auth.uid()` and 0264's medical/account gate on UPDATE's
--      USING and WITH CHECK and on DELETE's USING — the same shape check
--      0385's own Verify block makes at migration time, re-made here against
--      the schema every later migration has been replayed onto.
--
-- ── ONE STATEMENT ───────────────────────────────────────────────────────────
-- Every UPDATE attempt below — the control, every refusal, the managers' — is
-- the SAME SQL TEXT, `q0385_stmt`, run through `EXECUTE … USING`. Only the
-- parameters differ: which row, and which member it ends up about. Its SET list
-- is the union of the two app writers: `rememberConfirmed`'s value, category,
-- notes, is_pinned, expires_at, and the pencil's label and member_id. So no
-- attempt can be refused for naming a column the control did not name.
--
-- Three attempts step outside that text on purpose, and each says why where it
-- runs: 3c is q0385_stmt's SET list plus `created_by`, the one column the
-- control never writes; 4c writes `created_by` alone and so carries its own
-- control on the row about her first; 5 drops the WHERE clause so that only
-- the UPDATE policy is consulted.
--
-- The three "Emergency contact" rows the teen is aimed at are identical except
-- for member_id — same family, same category, same source, same creator (the
-- parent entered all three). With the creator held fixed, member_id is the one
-- thing that differs between the row the control rewrites and the rows the
-- refusals aim at. The author branch is measured separately (8) on a fourth
-- ordinary row, "Bin day", that the TEEN filed for the whole family.
--
-- ── NEGATIVE CONTROL, and it runs FIRST ─────────────────────────────────────
-- The same teen runs the same statement against HER OWN ordinary row, keeping
-- it hers (`member_id = her member`). Under 0385 that is exactly the case the
-- self rule lets through, and it MUST land — one row. If it does not, the
-- probe raises "UNPROVEN" before any refusal is read, because every refusal
-- below would then be a refusal with no attribution:
--
--   * the zero-row refusals (1, 2, 4) read as "blocked" just as readily when
--     `auth.uid()` is dead (a NULL sub makes every helper false, so USING
--     filters every row) or when an unrelated BEFORE UPDATE trigger returns
--     NULL — and the control writes zero rows under both of those too;
--   * the WITH CHECK refusals (3) are 42501, and so is "permission denied for
--     table family_facts" from a missing UPDATE grant or a revoked column in
--     the SET list, and so is whatever an unrelated guard trigger chooses to
--     raise — the control is refused by every one of those. The refusals also
--     tell an error from zero rows, and Postgres's RLS wording from any other
--     42501, but that only narrows what went wrong; it is the control landing
--     that shows this session could write the table at all.
--
-- A zero-row UPDATE is also what a row the session cannot SEE produces, so 6's
-- SELECT check is part of the attribution, not only a record of intent: the
-- household and sibling rows are visible to this teen, so zero rows written is
-- the UPDATE policy's answer, not the SELECT policy's.
--
-- Each attempt runs in its own subtransaction and is undone after its row
-- count is taken (`pg_temp.q0385_try` raises a private SQLSTATE to roll it
-- back), so a breach in one attempt cannot change what the next one measures.
--
-- Run against a throwaway instance (docs/audit/verify-pg.sh up):
--
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-member-only-rewrites-their-own-memory-check.sql
--
-- Without 0385 (0264's policies) this file fails on refusals 1, 2, 3, 3b, 4,
-- 4b, 4c, 5a, both DELETE refusals in 9, and 10, with "a teen REWROTE …" /
-- "RE-POINTED …" / "CLAIMED …" / "FORGOT …"; with 0385's author branch removed
-- it fails on 8 (three times), 5a, 3c and 10; with DELETE alone put back to
-- 0264 it fails on 9 and 10; with UPDATE revoked from `authenticated` it fails
-- on the control with "UNPROVEN"; with DELETE revoked, on 9's control with
-- "UNPROVEN for DELETE"; with UPDATE re-granted column by column but not on
-- created_by, on 4c's control with "UNPROVEN for created_by". Each of those
-- was run against the replayed schema when this file was last changed.

\set F   '03850385-0385-4357-8357-000000000001'
\set UP  '03850385-0385-4357-8357-000000000002'
\set UT  '03850385-0385-4357-8357-000000000003'
\set US  '03850385-0385-4357-8357-000000000004'
\set UA  '03850385-0385-4357-8357-000000000005'
\set MT  '03850385-0385-4357-8357-000000000011'
\set MS  '03850385-0385-4357-8357-000000000012'
\set MA  '03850385-0385-4357-8357-000000000013'
\set RH  '03850385-0385-4357-8357-000000000021'
\set RS  '03850385-0385-4357-8357-000000000022'
\set RT  '03850385-0385-4357-8357-000000000023'
\set RM  '03850385-0385-4357-8357-000000000024'
\set RA  '03850385-0385-4357-8357-000000000025'

begin;

-- ── Seed, as postgres ───────────────────────────────────────────────────────
insert into auth.users (id, email) values
  (:'UP', 'q0385-parent@example.com'),
  (:'UT', 'q0385-teen@example.com'),
  (:'US', 'q0385-sibling@example.com'),
  (:'UA', 'q0385-adult@example.com')
on conflict do nothing;

insert into public.families (id, name, created_by)
  values (:'F', 'Memory House', :'UP') on conflict do nothing;
-- on_family_created files the creator as a parent; re-assert it, because a
-- seed whose roles are wrong would fail the managers' check for a reason that
-- is not the policy's.
update public.family_members set role = 'parent', is_active = true
  where family_id = :'F' and user_id = :'UP';

insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  (:'MT', :'F', :'UT', 'Teen',    'teen',  true),
  (:'MS', :'F', :'US', 'Sibling', 'child', true),
  (:'MA', :'F', :'UA', 'Grandad', 'adult', true)
on conflict do nothing;

-- Three rows identical but for member_id, all entered by the parent. RM is the
-- teen's own medical row, which 0264 keeps from her whoever it is about. RA is
-- the one the TEEN filed, for the whole family — the author branch's row (8).
insert into public.family_facts (id, family_id, member_id, category, label, value, created_by, source, is_pinned) values
  (:'RH', :'F', null,  'contact', 'Emergency contact', 'Grandma Ruth — 555 0101', :'UP', 'user', false),
  (:'RS', :'F', :'MS', 'contact', 'Emergency contact', 'Coach Dana — 555 0199',   :'UP', 'user', false),
  (:'RT', :'F', :'MT', 'contact', 'Emergency contact', 'Aunt Priya — 555 0144',   :'UP', 'user', false),
  (:'RM', :'F', :'MT', 'medical', 'Allergies',         'Peanuts — EpiPen in her bag', :'UP', 'user', false),
  (:'RA', :'F', null,  'other',   'Bin day',           'Thursday',                :'UT', 'user', false);

-- ── The one attempt helper ──────────────────────────────────────────────────
-- Acts as `p_actor` (role authenticated, jwt sub), runs `p_sql` with four
-- parameters ($1 target row, $2 member the row ends up about, $3 value,
-- $4 category), records the row count or the error, and UNDOES the attempt.
-- The role switch is made outside the inner block on purpose: a GUC set inside
-- a subtransaction is reverted when that subtransaction rolls back.
create function pg_temp.q0385_try(
  p_actor uuid, p_sql text, p_target uuid, p_dest uuid, p_value text, p_category text,
  out rows_hit int, out err_state text, out err_msg text)
language plpgsql as $f$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    execute p_sql using p_target, p_dest, p_value, p_category;
    get diagnostics rows_hit = row_count;
    raise exception using errcode = 'P0385', message = 'q0385: undo this attempt';
  exception
    when sqlstate 'P0385' then null;
    when others then
      rows_hit := null; err_state := sqlstate; err_msg := sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end
$f$;

do $$
declare
  fam       constant uuid := '03850385-0385-4357-8357-000000000001';
  parent_u  constant uuid := '03850385-0385-4357-8357-000000000002';
  teen_u    constant uuid := '03850385-0385-4357-8357-000000000003';
  adult_u   constant uuid := '03850385-0385-4357-8357-000000000005';
  teen_m    constant uuid := '03850385-0385-4357-8357-000000000011';
  sib_m     constant uuid := '03850385-0385-4357-8357-000000000012';
  house_row constant uuid := '03850385-0385-4357-8357-000000000021';
  sib_row   constant uuid := '03850385-0385-4357-8357-000000000022';
  teen_row  constant uuid := '03850385-0385-4357-8357-000000000023';
  authored  constant uuid := '03850385-0385-4357-8357-000000000025';
  planted   constant uuid := '03850385-0385-4357-8357-000000000031';

  -- THE statement. Every UPDATE attempt in this file is this text.
  q0385_stmt constant text :=
    'update public.family_facts
        set member_id = $2, value = $3, category = $4, label = label,
            notes = ''q0385: rewritten'', is_pinned = true, expires_at = null
      where id = $1';

  rls_msg constant text := 'new row violates row-level security policy%"family_facts"%';
  r record;
  n int;
  failures text[] := '{}';
begin
  -- ══ NEGATIVE CONTROL — the same teen, the same statement, her OWN row ═════
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, teen_row, teen_m,
    'Aunt Priya — 555 0144 (restated by her)', 'contact');
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    raise exception 'member-memory boundary UNPROVEN: the control — this teen rewriting HER OWN ordinary memory with the very statement the refusals use — did not land (rows=%, %: %). Every refusal below would be unattributed: a missing UPDATE grant, a column revoke, a dead auth.uid() or an unrelated trigger refuses that statement too.',
      coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, '-'), coalesce(r.err_msg, 'no error, wrong row count');
  end if;

  -- ══ 6a. SELECT stays open — and makes the zero-row refusals readable ══════
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', teen_u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select count(*) into n from public.family_facts where id in (house_row, sib_row);
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if n <> 2 then
    raise exception 'member-memory boundary UNPROVEN: this teen sees % of the 2 household/sibling memories. 0385 leaves SELECT open to the household; if that changed on purpose, update this probe — until then a zero-row UPDATE below cannot be told apart from a row she cannot see.', n;
  end if;

  -- ══ 1. A teen cannot rewrite the household's memory ═══════════════════════
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, house_row, null,
    'call me instead', 'contact');
  if r.err_state is not null then
    failures := array_append(failures, format('refusal 1 was refused by an ERROR (%s: %s), not by the UPDATE policy''s USING (zero rows) — USING should drop a row that is not hers before any new row is built', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen REWROTE %s household-level memory (member_id null — the "Emergency contact" a parent entered for everyone)', r.rows_hit));
  end if;

  -- ══ 2. A teen cannot rewrite a sibling's memory ═══════════════════════════
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, sib_row, sib_m,
    'call me instead', 'contact');
  if r.err_state is not null then
    failures := array_append(failures, format('refusal 2 was refused by an ERROR (%s: %s), not by the UPDATE policy''s USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen REWROTE %s memory about her sibling', r.rows_hit));
  end if;

  -- ══ 3. A teen cannot push her own row out of her ownership (WITH CHECK) ══
  -- The control's statement, the control's row; only the member it ends up
  -- about is flipped.
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, teen_row, sib_m,
    'Aunt Priya — 555 0144', 'contact');
  if r.err_state is null then
    failures := array_append(failures, format('a teen RE-POINTED a memory a parent wrote about her at her sibling (%s row) — WITH CHECK does not carry the self rule', r.rows_hit));
  elsif r.err_state <> '42501' or r.err_msg not like rls_msg then
    failures := array_append(failures, format('re-pointing her own memory at a sibling was refused, but not by row-level security (%s: %s)', r.err_state, r.err_msg));
  end if;

  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, teen_row, null,
    'Aunt Priya — 555 0144', 'contact');
  if r.err_state is null then
    failures := array_append(failures, format('a teen RE-POINTED a memory a parent wrote about her at the whole family (%s row) — she has turned the parent''s row into a household fact the parents did not file', r.rows_hit));
  elsif r.err_state <> '42501' or r.err_msg not like rls_msg then
    failures := array_append(failures, format('re-pointing her own memory at the family was refused, but not by row-level security (%s: %s)', r.err_state, r.err_msg));
  end if;

  -- 3c: the one way past 3 — the SAME statement with `created_by = <her uid>`
  -- added to its SET list. USING passes on the self branch (the old row is
  -- about her); WITH CHECK passes on the author branch (the new row is hers).
  -- 3 and 3b hold only because q0385_stmt never writes created_by, so this is
  -- asserted to LAND: it is what 0385 says it accepts (created_by is not
  -- pinned; the end state is a forget-and-refile, which 9's control and 6b
  -- prove she may do), and a probe that left it unmeasured would let claim 3
  -- read as "she cannot re-point it" when the policy says "not while it stays
  -- the parent's". If created_by is pinned on purpose later, this fires and
  -- the claim is to be widened — that is a probe out of date, not a breach.
  select * into r from pg_temp.q0385_try(teen_u,
    format('update public.family_facts
               set member_id = $2, value = $3, category = $4, label = label,
                   notes = ''q0385: rewritten'', is_pinned = true, expires_at = null,
                   created_by = %L
             where id = $1', teen_u),
    teen_row, sib_m, 'Aunt Priya — 555 0144', 'contact');
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    failures := array_append(failures, format('re-pointing the memory about her at her sibling WHILE taking authorship of it did not land (rows=%s, %s: %s) — 0385 says WITH CHECK passes on the author branch and accepts this as a forget-and-refile; if created_by is now pinned on purpose, widen claim 3 and update this probe', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  -- ══ 4. A teen cannot CLAIM someone else's memory by making it about her ══
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, house_row, teen_m,
    'call me instead', 'contact');
  if r.err_state is not null then
    failures := array_append(failures, format('claiming the household memory was refused by an ERROR (%s: %s), not by USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen CLAIMED %s household memory by re-pointing it at herself', r.rows_hit));
  end if;

  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, sib_row, teen_m,
    'call me instead', 'contact');
  if r.err_state is not null then
    failures := array_append(failures, format('claiming the sibling''s memory was refused by an ERROR (%s: %s), not by USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen CLAIMED %s of her sibling''s memories by re-pointing it at herself', r.rows_hit));
  end if;

  -- 4c: nor by writing her own uid into created_by, which would make the
  -- author branch hand her the row. USING reads the row as it IS, so this is
  -- the same USING answer as 1, taken on the one column q0385_stmt never
  -- writes. That makes it a DIFFERENT statement from the control's, so it has
  -- its own control first: the same write on the row about her must land —
  -- one row — or the zero rows below could be created_by itself refusing
  -- (a column-level grant that stops at created_by, a trigger keyed on it)
  -- rather than USING. 0385 allows her that re-attribution (see 3c).
  select * into r from pg_temp.q0385_try(teen_u,
    'update public.family_facts set created_by = $2 where id = $1', teen_row, teen_u, null, null);
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    raise exception 'member-memory boundary UNPROVEN for created_by: the control — this teen writing her own uid into created_by on the memory about HER — did not land (rows=%, %: %). 4c below would be unattributed: whatever refuses this column refuses it on the household''s row too.%',
      coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, '-'), coalesce(r.err_msg, 'no error, wrong row count'),
      case when array_length(failures, 1) is not null then ' Failures already collected before it: ' || array_to_string(failures, ' | ') else '' end;
  end if;

  select * into r from pg_temp.q0385_try(teen_u,
    'update public.family_facts set created_by = $2 where id = $1', house_row, teen_u, null, null);
  if r.err_state is not null then
    failures := array_append(failures, format('claiming the household memory''s authorship was refused by an ERROR (%s: %s), not by USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen CLAIMED %s household memory by writing her uid into created_by', r.rows_hit));
  end if;

  select * into r from pg_temp.q0385_try(teen_u,
    'update public.family_facts set created_by = $2 where id = $1', sib_row, teen_u, null, null);
  if r.err_state is not null then
    failures := array_append(failures, format('claiming the sibling''s memory''s authorship was refused by an ERROR (%s: %s), not by USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen CLAIMED %s of her sibling''s memories by writing her uid into created_by', r.rows_hit));
  end if;

  -- ══ 5. 0264's category gate survived the new policy ═══════════════════════
  -- No WHERE clause and constant SET expressions, so the UPDATE needs no SELECT
  -- right and Postgres applies ONLY the UPDATE policy — the SELECT policy
  -- carries the same category gate and would otherwise answer for it. This
  -- teen belongs to one family, so the sweep can reach nothing outside it.
  --
  -- 5a (its own control): the sweep reaches exactly her two ordinary rows —
  -- the one about her and the household one she wrote — not the household's
  -- the parent wrote, not her sibling's, and not her own MEDICAL row.
  select * into r from pg_temp.q0385_try(teen_u,
    'update public.family_facts set notes = ''q0385: sweep''', null, null, null, null);
  if r.err_state is not null then
    failures := array_append(failures, format('the WHERE-less sweep was refused outright (%s: %s), so 5b below proves nothing', r.err_state, r.err_msg));
  elsif r.rows_hit <> 2 then
    failures := array_append(failures, format('a WHERE-less UPDATE by this teen reached %s rows; it should reach exactly 2 — the ordinary memory about her and the household one she wrote. More means the self/author rule or 0264''s category gate is missing from USING; fewer means one of those branches is refusing what it should allow', r.rows_hit));
  end if;

  -- 5b: the same sweep, filing her ordinary row as medical, must fail WITH CHECK.
  select * into r from pg_temp.q0385_try(teen_u,
    'update public.family_facts set category = ''medical''', null, null, null, null);
  if r.err_state is null then
    failures := array_append(failures, format('a teen re-filed %s memory as MEDICAL — 0264''s category gate is gone from WITH CHECK', r.rows_hit));
  elsif r.err_state <> '42501' or r.err_msg not like rls_msg then
    failures := array_append(failures, format('re-filing as medical was refused, but not by row-level security (%s: %s)', r.err_state, r.err_msg));
  end if;

  -- ══ 6b. INSERT stays open: a member files a household-level memory ════════
  select * into r from pg_temp.q0385_try(teen_u,
    format('insert into public.family_facts (id, family_id, member_id, category, label, value, created_by)
              values ($1, %L, $2, $4, %L, $3, %L)', fam, 'Bin day', teen_u),
    planted, null, 'Thursday', 'other');
  if r.err_state is not null or r.rows_hit <> 1 then
    failures := array_append(failures, format('a teen can no longer INSERT a household-level memory (rows=%s, %s: %s) — 0385 says INSERT is untouched; if that changed on purpose, update this probe', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  -- ══ 7. The managers still can ═════════════════════════════════════════════
  select * into r from pg_temp.q0385_try(parent_u, q0385_stmt, house_row, null,
    'Grandma Ruth — 555 0102', 'contact');
  if r.err_state is not null or r.rows_hit <> 1 then
    failures := array_append(failures, format('a PARENT could not rewrite the household memory (rows=%s, %s: %s) — the guard refuses everyone', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  select * into r from pg_temp.q0385_try(adult_u, q0385_stmt, sib_row, sib_m,
    'Coach Dana — 555 0198', 'contact');
  if r.err_state is not null or r.rows_hit <> 1 then
    failures := array_append(failures, format('an ADULT could not rewrite a child''s memory (rows=%s, %s: %s) — can_manage_family covers adults as well as parents', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  select * into r from pg_temp.q0385_try(parent_u, q0385_stmt, house_row, sib_m,
    'Grandma Ruth — 555 0101', 'contact');
  if r.err_state is not null or r.rows_hit <> 1 then
    failures := array_append(failures, format('a PARENT could not re-point the household memory at a child (rows=%s, %s: %s)', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  select * into r from pg_temp.q0385_try(parent_u, q0385_stmt, teen_row, sib_m,
    'Aunt Priya — 555 0144', 'contact');
  if r.err_state is not null or r.rows_hit <> 1 then
    failures := array_append(failures, format('a PARENT could not re-point the teen''s memory at her sibling (rows=%s, %s: %s)', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  -- ══ 8. What she WROTE stays hers — the author branch ══════════════════════
  -- "Bin day" is a household fact (member_id null) the teen filed herself, the
  -- very thing 6b shows she may still INSERT. The same statement as every
  -- attempt above; without `created_by = auth.uid()` in USING each of these is
  -- zero rows, which is "write, but never fix".
  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, authored, null,
    'Wednesday', 'other');
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    failures := array_append(failures, format('a teen could not correct the household memory SHE filed (rows=%s, %s: %s) — the author branch is missing, so she can write a fact she can never fix', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  select * into r from pg_temp.q0385_try(teen_u, q0385_stmt, authored, sib_m,
    'Thursday', 'other');
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    failures := array_append(failures, format('a teen could not re-point the memory SHE filed (rows=%s, %s: %s) — she could have forgotten it and filed it again about her sibling, so refusing this is not a boundary', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  select * into r from pg_temp.q0385_try(teen_u,
    'delete from public.family_facts where id = $1', authored, null, null, null);
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    failures := array_append(failures, format('a teen could not forget the household memory SHE filed (rows=%s, %s: %s)', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  -- ══ 9. DELETE carries the same rule ════════════════════════════════════════
  -- Its own control first: the same teen, the same statement, the row a parent
  -- wrote ABOUT her. It must go — one row — or the refusals below are
  -- unattributed (a revoked DELETE grant or a dead auth.uid() refuses it too).
  select * into r from pg_temp.q0385_try(teen_u,
    'delete from public.family_facts where id = $1', teen_row, null, null, null);
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    -- Raising here stops the block, so any UPDATE failures collected above
    -- ride along in the message instead of being dropped.
    raise exception 'member-memory boundary UNPROVEN for DELETE: the control — this teen forgetting a memory about HERSELF — did not land (rows=%, %: %). The DELETE refusals below would be unattributed.%',
      coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, '-'), coalesce(r.err_msg, 'no error, wrong row count'),
      case when array_length(failures, 1) is not null then ' Failures already collected before it: ' || array_to_string(failures, ' | ') else '' end;
  end if;

  -- 6a showed both rows are visible to her, so zero rows here is DELETE's
  -- USING answering, not SELECT's.
  select * into r from pg_temp.q0385_try(teen_u,
    'delete from public.family_facts where id = $1', house_row, null, null, null);
  if r.err_state is not null then
    failures := array_append(failures, format('forgetting the household memory was refused by an ERROR (%s: %s), not by DELETE''s USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen FORGOT %s household-level memory a parent entered (the "Emergency contact")', r.rows_hit));
  end if;

  select * into r from pg_temp.q0385_try(teen_u,
    'delete from public.family_facts where id = $1', sib_row, null, null, null);
  if r.err_state is not null then
    failures := array_append(failures, format('forgetting the sibling''s memory was refused by an ERROR (%s: %s), not by DELETE''s USING', r.err_state, r.err_msg));
  elsif r.rows_hit <> 0 then
    failures := array_append(failures, format('a teen FORGOT %s memory about her sibling', r.rows_hit));
  end if;

  select * into r from pg_temp.q0385_try(parent_u,
    'delete from public.family_facts where id = $1', house_row, null, null, null);
  if r.err_state is not null or r.rows_hit is distinct from 1 then
    failures := array_append(failures, format('a PARENT could not forget the household memory (rows=%s, %s: %s) — the guard refuses everyone', coalesce(r.rows_hit::text, 'none'), coalesce(r.err_state, 'no error'), coalesce(r.err_msg, '-')));
  end if;

  -- ══ 10. The policies still NAME the rule ═══════════════════════════════════
  -- 0385's Verify block asserts this once, at migration time. Every later
  -- migration has since been replayed onto this schema, so ask again: UPDATE's
  -- USING and WITH CHECK and DELETE's USING each carry the self branch, the
  -- author branch and 0264's medical/account gate. The behavioural sections
  -- above would catch a branch that is gone; this catches one that was
  -- rewritten into something that happens to answer the same on this seed.
  declare
    q text; c text; d text;
  begin
    select pg_get_expr(pol.polqual, pol.polrelid), pg_get_expr(pol.polwithcheck, pol.polrelid)
      into q, c
      from pg_policy pol
      where pol.polrelid = 'public.family_facts'::regclass and pol.polname = 'family_facts_update';
    select pg_get_expr(pol.polqual, pol.polrelid)
      into d
      from pg_policy pol
      where pol.polrelid = 'public.family_facts'::regclass and pol.polname = 'family_facts_delete';
    if q is null or c is null or d is null then
      failures := array_append(failures, format('family_facts_update (USING %s, WITH CHECK %s) or family_facts_delete (USING %s) is missing — 0385 created both with both halves', coalesce(q, 'MISSING'), coalesce(c, 'MISSING'), coalesce(d, 'MISSING')));
    else
      if q not like '%is_self_member(member_id)%' or c not like '%is_self_member(member_id)%' or d not like '%is_self_member(member_id)%' then
        failures := array_append(failures, 'the self branch `is_self_member(member_id)` is gone from one of UPDATE USING / UPDATE WITH CHECK / DELETE USING');
      end if;
      if q not like '%created_by = auth.uid()%' or c not like '%created_by = auth.uid()%' or d not like '%created_by = auth.uid()%' then
        failures := array_append(failures, 'the author branch `created_by = auth.uid()` is gone from one of UPDATE USING / UPDATE WITH CHECK / DELETE USING');
      end if;
      if q not like '%medical%' or c not like '%medical%' or d not like '%medical%' then
        failures := array_append(failures, '0264''s medical/account gate is gone from one of UPDATE USING / UPDATE WITH CHECK / DELETE USING');
      end if;
    end if;
  end;

  if array_length(failures, 1) is not null then
    raise exception 'member-memory boundary failed: %', array_to_string(failures, ' | ');
  end if;

  raise notice '0385 OK: the same teen CAN rewrite her own memory with the same statement (control), and cannot rewrite, claim or re-point the household''s or her sibling''s; she cannot move a parent''s row about her out of her hands while it stays the parent''s (taking authorship of it in the same statement lands, as 0385 says it does — a forget-and-refile); what she filed herself she can correct, re-point and forget; she cannot forget the household''s or her sibling''s; 0264''s medical gate holds on both sides; she still reads the family''s memory and files a household one; a parent and an adult can do all of it; the policies still name every branch';
end
$$;

rollback;
