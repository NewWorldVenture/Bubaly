-- ── An Autopilot card is read by its audience (0486) ────────────────────────
--
-- Companion to 0486_an_autopilot_card_is_read_by_its_audience. An Autopilot
-- card is a copy the service-role scan makes of a source row, and until 0486 it
-- was read under 0085's family-wide policy: a guest whom 0481 refuses
-- `subscriptions_tracked` and `renewals` read the cards copied from both,
-- title, detail and payload. 0486 adds RESTRICTIVE read and update policies
-- that are lib/autopilot/audience.ts's rule, and pins the two columns that
-- rule reads:
--
--   insurance (source family_insurance_policies or kind insurance)
--                          a manager, or the member the policy names (member_id)
--   finance, or source subscriptions_tracked / renewals
--                          anyone but a guest
--   anything else          the family
--
-- Every line here runs as that member's own session under RLS (`set local role
-- authenticated` and the JWT claims PostgREST sets) and reads the columns the
-- leak was about: `select title, detail, payload`. Asserted, as a matrix of
-- nine readers by eleven cards and then as whole-family totals:
--
--   DENIED   a guest: the subscription charge, the unused-subscription flag
--            (finance by kind alone), the renewal, and every insurance card
--            that does not name them; a teen and a caregiver the policy does
--            not name: its insurance card; a named child: the household's
--            policies and another member's;
--   ALLOWED  a parent and an adult (managers): every card; the member a policy
--            names: its card (a guest too, when it is theirs); a teen, a
--            caregiver and a child: the finance and renewal cards; everyone,
--            the guest included: an ordinary card, one about a member, and a
--            refill card (everyone's in audience.ts too);
--   NOTHING  another family's parent, an inactive member, `anon`.
--
-- And the two app paths that read a row while writing it, as the same
-- sessions: resolving (resolveSuggestion's `update … select`) lands for a
-- reader and matches no row for anyone else; an insert that reads its row back
-- (the on-demand scan's `insert … select('id')`) lands for a card its writer
-- may read and is refused 42501 for one they may not, which is why
-- lib/autopilot/scan.ts skips such a draft on a member's own scan.
--
-- An UPDATE that names no column (RV486-2). Postgres adds a SELECT policy to
-- an UPDATE only when its WHERE, RETURNING or a SET expression names a column,
-- so `update autopilot_suggestions set member_id = '<own id>'` with no WHERE,
-- or PostgREST's unfiltered PATCH with return=minimal, skipped the read rule:
-- the teen named themselves on Ava's insurance card and read it. Asserted, each
-- as one write and then a read in the same session, with the card's
-- member_id, kind, source_kind, status and family_id compared before and
-- after:
--
--   DENIED   the unnamed teen, the guest and the caregiver, column-free (no
--            WHERE, `where true`, `returning 1`, a SET from auth.uid(), the
--            PostgREST shape): a card they may not read is not touched and they
--            still read nothing; a resolve of it neither. A READER cannot
--            relabel a card for someone outside its audience: the named child
--            moving her card to her brother (column-free and by id) or to
--            nobody, the teen turning the subscription charge into an 'other'
--            card for the guest, the named child turning hers into an everyone
--            card, the guest moving her travel card out of insurance, the teen
--            narrowing an ordinary card to finance, and a manager rewriting a
--            card's kind (the pin is not a role rule);
--   DENIED   (RV486-2-FAMILY) a move into another family the writer also
--            belongs to. Ava is a child here and in her co-parent's household,
--            Sam a teen in both, the guest runs her own household and the
--            parent is an adult in the co-parent's: Ava's move of her
--            insurance card (by id, returning id), Sam's of the subscription
--            charge (PostgREST's filtered PATCH, and with no WHERE), the
--            guest's of an ordinary card into her household and the parent's
--            of Ava's card are refused, the card stays in this family (this
--            family's reader still reads it) and the other family's reader
--            reads nothing;
--   ALLOWED  a manager reassigning a policy's card (the scan's refresh on a
--            manager's client, by id and family, returning id): the new member
--            reads it and the old one does not; the named member's and a
--            manager's resolve, and the named member's own scan archiving her
--            stale card;
--   0327     a resolution still names its own author (the named child cannot
--            sign as the parent nor the parent as her), and no client deletes.
--
-- Legacy insurance cards. A card written before the scan stored the policy's
-- member names nobody, so under 0486 the member the policy names cannot read
-- it. The probe writes one (and three it must not touch: a policy naming
-- nobody, another family's policy, a card already naming someone else), shows
-- the named child cannot read it, then RE-APPLIES 0486 itself with `\ir` in
-- this transaction: the child reads it, the unnamed teen and the guest still
-- do not, the other three are as they were, and applying it once more rewrites
-- no row (compared by ctid).
--
-- NEGATIVE CONTROLS, in this transaction, after the re-apply, each drop adding
-- to the last: with 0486's pin ALONE dropped (both policies in place) Ava's,
-- Sam's and the guest's moves into their other family land, that family's
-- reader reads the card and this family's no longer does, and the teen turns
-- the subscription charge into an 'other' card the guest reads; with the
-- update guard dropped as well the teen's column-free write names him on Ava's
-- card and he reads it, and the named child's moves it to her brother, who
-- reads it; with the read policy dropped as well the guest reads the
-- subscription charge and the teen reads the child's insurance card again. So
-- this probe is shown to see each defect, and the family moves to be the
-- pin's to hold, not the policies'. Replayed with 0486 as bd57dd0c3 had it
-- (no update guard, no pin, no backfill) it fails on exactly the RV486-2 lines
-- (the family moves included) and the legacy lines; replayed with the pin on
-- kind and source_kind only (0486 as 0bb434c22 had it) it fails on exactly the
-- family-move lines; it passes the rest (the per-group summary below says
-- which).
--
-- Rolled back: nothing here outlives the run.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql
--
-- `\ir` resolves the migration against THIS file's directory, so the probe runs
-- from any working directory (run-probes.sh passes an absolute path).
\set ON_ERROR_STOP on

begin;

-- Run q as `who` (null: no user) under `as_role`, inside a subtransaction that
-- is always rolled back. Returns the row count, 'refused' (42501) or
-- 'error:<sqlstate> <message>'.
create function pg_temp.ap_as(who uuid, as_role text, q text, counting boolean) returns text
language plpgsql as $f$
declare n bigint; res text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claim.role', as_role, true);
  perform set_config('request.jwt.claims',
    case when who is null then json_build_object('role', as_role)
         else json_build_object('sub', who::text, 'role', as_role) end::text, true);
  execute format('set local role %I', as_role);
  begin
    begin
      if counting then
        execute 'select count(*) from (' || q || ') s' into n;
      else
        execute q;
        get diagnostics n = row_count;
      end if;
      raise exception using errcode = 'AP486', message = n::text;
    exception
      when sqlstate 'AP486' then res := sqlerrm;
      when insufficient_privilege then res := 'refused';
      when others then res := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
  return res;
end $f$;

-- The claims PostgREST sets for `who` under `as_role`; '' clears them.
create function pg_temp.ap_claims(who uuid, as_role text) returns void
language plpgsql as $f$
begin
  perform set_config('request.jwt.claim.sub', coalesce(who::text, ''), true);
  perform set_config('request.jwt.claim.role', as_role, true);
  perform set_config('request.jwt.claims',
    case when as_role = '' then ''
         when who is null then json_build_object('role', as_role)::text
         else json_build_object('sub', who::text, 'role', as_role)::text end, true);
end $f$;

-- What a card says about who reads it, and whether it is resolved.
create function pg_temp.ap_card_state(card uuid) returns text
language sql as $f$
  select format('%s|%s|%s|%s|%s', s.member_id, s.kind, s.source_kind, s.status, s.family_id)
    from public.autopilot_suggestions s where s.id = card
$f$;

-- Run write_q as `who` under `as_role`, then read `card` (title, detail,
-- payload) as `reader`, in ONE subtransaction that is always rolled back: the
-- read sees what the write left. Returns '<write>; <card>; reads <n>' where
-- <write> is '<n> written', 'refused' (42501) or 'error:<sqlstate> <message>',
-- and <card> is 'kept' when the card's member_id, kind, source_kind, status and
-- family_id are what they were, 'deleted', or 'changed:' and the columns that
-- changed.
create function pg_temp.ap_write_read(who uuid, as_role text, write_q text, card uuid, reader uuid) returns text
language plpgsql as $f$
declare
  n bigint;
  written text;
  was text[];
  now_is text[];
  changed text[] := '{}';
  cols constant text[] := array['member_id', 'kind', 'source_kind', 'status', 'family_id'];
  res text;
begin
  was := string_to_array(pg_temp.ap_card_state(card), '|');
  begin
    perform pg_temp.ap_claims(who, as_role);
    execute format('set local role %I', as_role);
    begin
      execute write_q;
      get diagnostics n = row_count;
      written := n || ' written';
    exception
      when insufficient_privilege then written := 'refused';
      when others then written := 'error:' || sqlstate || ' ' || sqlerrm;
    end;
    execute 'reset role';
    now_is := string_to_array(pg_temp.ap_card_state(card), '|');
    if now_is is not null then
      for i in 1 .. 5 loop
        if now_is[i] is distinct from was[i] then changed := changed || cols[i]; end if;
      end loop;
    end if;
    perform pg_temp.ap_claims(reader, 'authenticated');
    execute 'set local role authenticated';
    execute format('select count(*) from (select title, detail, payload from public.autopilot_suggestions where id = %L) s', card) into n;
    execute 'reset role';
    raise exception using errcode = 'AP486', message = format('%s; %s; reads %s', written,
      case when now_is is null then 'deleted'
           when cardinality(changed) = 0 then 'kept'
           else 'changed:' || array_to_string(changed, ',') end, n);
  exception when sqlstate 'AP486' then res := sqlerrm;
  end;
  execute 'reset role';
  perform pg_temp.ap_claims(null, '');
  return res;
end $f$;

create temp table ap_result (seq serial, grp text, label text, got text, want text, ok boolean) on commit drop;

-- want: a number of rows, or 'refused' (42501).
create function pg_temp.ap_expect(grp text, label text, got text, want text) returns void
language plpgsql as $f$
begin
  insert into ap_result (grp, label, got, want, ok)
  values (grp, label, got, want,
          case when want = '0' then got in ('0', 'refused') else got = want end);
end $f$;

-- want: a regular expression over ap_write_read's answer.
create function pg_temp.ap_expect_re(grp text, label text, got text, want text) returns void
language plpgsql as $f$
begin
  insert into ap_result (grp, label, got, want, ok)
  values (grp, label, got, want, coalesce(got ~ want, false));
end $f$;

-- The fixture's ids, for the blocks after the in-transaction re-apply.
create temp table ap_fx (k text primary key, v uuid not null) on commit drop;

do $probe$
declare
  fam   constant uuid := '00000000-0000-4000-8000-0000004860f1';
  away  constant uuid := '00000000-0000-4000-8000-0000004860f2';
  uP    constant uuid := '00000000-0000-4000-8000-000000486001';  -- parent (manager)
  uA    constant uuid := '00000000-0000-4000-8000-000000486002';  -- adult (manager)
  uN    constant uuid := '00000000-0000-4000-8000-000000486003';  -- Ava, a child the dental policy names
  uU    constant uuid := '00000000-0000-4000-8000-000000486004';  -- Sam, a teen no policy names
  uC    constant uuid := '00000000-0000-4000-8000-000000486005';  -- a caregiver
  uG    constant uuid := '00000000-0000-4000-8000-000000486006';  -- a guest (grandparent invite)
  uI    constant uuid := '00000000-0000-4000-8000-000000486007';  -- a removed (inactive) parent
  uX    constant uuid := '00000000-0000-4000-8000-000000486008';  -- another family's parent
  uL    constant uuid := '00000000-0000-4000-8000-000000486009';  -- Leo, Ava's brother, a child no policy names
  -- RV486-2-FAMILY: households some of this family's members also belong to.
  famB  constant uuid := '00000000-0000-4000-8000-0000004860f3';  -- the co-parent's household: Ava and Sam live here too
  famX  constant uuid := '00000000-0000-4000-8000-0000004860f4';  -- the guest's own household, which she runs
  uB    constant uuid := '00000000-0000-4000-8000-00000048600a';  -- the co-parent, a parent of famB only
  uY    constant uuid := '00000000-0000-4000-8000-00000048600b';  -- Grandpa, an adult of famX only
  -- RV486-2's cards, by id.
  c_fin  constant uuid := '00000000-0000-4000-8000-0000004860c1';
  c_ava  constant uuid := '00000000-0000-4000-8000-0000004860c4';
  c_home constant uuid := '00000000-0000-4000-8000-0000004860c5';
  c_both constant uuid := '00000000-0000-4000-8000-0000004860c6';
  c_gran constant uuid := '00000000-0000-4000-8000-0000004860c8';
  c_ord  constant uuid := '00000000-0000-4000-8000-0000004860c9';
  -- The legacy-card fixture: policies and the cards copied from them.
  p_leg   constant uuid := '00000000-0000-4000-8000-0000004860d1';  -- Ava's eye cover; its card names nobody
  p_none  constant uuid := '00000000-0000-4000-8000-0000004860d2';  -- the household's flood cover, naming nobody
  p_away  constant uuid := '00000000-0000-4000-8000-0000004860d3';  -- the neighbours' policy
  p_moved constant uuid := '00000000-0000-4000-8000-0000004860d4';  -- Ava's pet cover; its card already names Sam
  c_leg   constant uuid := '00000000-0000-4000-8000-0000004860e1';
  c_none  constant uuid := '00000000-0000-4000-8000-0000004860e2';
  c_away  constant uuid := '00000000-0000-4000-8000-0000004860e3';
  c_moved constant uuid := '00000000-0000-4000-8000-0000004860e4';
  mN uuid; mU uuid; mG uuid; mL uuid; mC uuid; mX uuid;
  r record;
  w record;
  v_got text;
  v_want text;
  v_grp text;
  F text;
  -- ap_write_read answers
  HELD     constant text := '^(refused|[0-9]+ written); kept; reads 0$';   -- not touched, still unread
  KEPT_OWN constant text := '^(refused|[0-9]+ written); kept; reads 1$';   -- not touched, still the reader's
  RESOLVED constant text := '^1 written; changed:status; reads 1$';
  PATCH    constant text := 'with pgrst_source as (update public.autopilot_suggestions set member_id = pgrst_body.member_id '
    || 'from (select %L::json as json_data) pgrst_payload, '
    || 'lateral (select member_id from json_populate_record(null::public.autopilot_suggestions, pgrst_payload.json_data)) pgrst_body '
    || 'returning 1) select count(*) from pgrst_source';
  -- PostgREST's PATCH /autopilot_suggestions?id=eq.<card>&family_id=eq.<family>
  -- with {"family_id": "<other>"} and return=representation.
  PATCH_FAM constant text := 'with pgrst_source as (update public.autopilot_suggestions set family_id = pgrst_body.family_id '
    || 'from (select %L::json as json_data) pgrst_payload, '
    || 'lateral (select family_id from json_populate_record(null::public.autopilot_suggestions, pgrst_payload.json_data)) pgrst_body '
    || 'where public.autopilot_suggestions.id = %L::uuid and public.autopilot_suggestions.family_id = %L::uuid '
    || 'returning public.autopilot_suggestions.*) select count(*) from pgrst_source';
begin
  -- ── fixture, written as the table owner with no session (auth.uid() null) ──
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values
    (uP, 'ap486-parent@example.test'), (uA, 'ap486-adult@example.test'), (uN, 'ap486-ava@example.test'),
    (uU, 'ap486-sam@example.test'), (uC, 'ap486-sitter@example.test'), (uG, 'ap486-gran@example.test'),
    (uI, 'ap486-former@example.test'), (uX, 'ap486-away@example.test'), (uL, 'ap486-leo@example.test'),
    (uB, 'ap486-coparent@example.test'), (uY, 'ap486-grandpa@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'Autopilot audience probe'), (away, 'Autopilot audience probe, next door'),
    (famB, 'Autopilot audience probe, the co-parent''s household'), (famX, 'Autopilot audience probe, Grandma''s own household')
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uP, 'Mum', 'parent', true), (fam, uA, 'Gran', 'adult', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uN, 'Ava', 'child', true) returning id into mN;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uU, 'Sam', 'teen', true) returning id into mU;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uC, 'Sitter', 'caregiver', true) returning id into mC;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Grandma', 'guest', true) returning id into mG;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uL, 'Leo', 'child', true) returning id into mL;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uI, 'Former parent', 'parent', false);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (away, uX, 'Neighbour', 'parent', true) returning id into mX;
  -- Two households beside this one (RV486-2-FAMILY): Ava and Sam also live
  -- with the co-parent, Mum is an adult there too, and Grandma, a guest here,
  -- runs her own.
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (famB, uB, 'Dad', 'parent', true), (famB, uN, 'Ava', 'child', true), (famB, uU, 'Sam', 'teen', true),
    (famB, uP, 'Mum', 'adult', true),
    (famX, uG, 'Grandma', 'parent', true), (famX, uY, 'Grandpa', 'adult', true);
  insert into ap_fx values
    ('fam', fam), ('uP', uP), ('uA', uA), ('uN', uN), ('uU', uU), ('uG', uG), ('uL', uL),
    ('mN', mN), ('mU', mU), ('mL', mL), ('mX', mX),
    ('famB', famB), ('famX', famX), ('uB', uB), ('uY', uY),
    ('c_fin', c_fin), ('c_ava', c_ava), ('c_ord', c_ord),
    ('c_leg', c_leg), ('c_none', c_none), ('c_away', c_away), ('c_moved', c_moved);

  -- The cards, as the scan writes them (lib/autopilot/engine.ts): kind,
  -- source_kind, member_id, and the words.
  create temp table ap_card (label text primary key, id uuid not null, about text not null) on commit drop;
  insert into ap_card values
    ('fin',       '00000000-0000-4000-8000-0000004860c1', 'the subscription charge (finance, subscriptions_tracked)'),
    ('unused',    '00000000-0000-4000-8000-0000004860c2', 'the unused-subscription flag (finance, no source)'),
    ('ren',       '00000000-0000-4000-8000-0000004860c3', 'the renewal (document, renewals)'),
    ('ins_ava',   '00000000-0000-4000-8000-0000004860c4', 'Ava''s dental insurance renewal (insurance, names Ava)'),
    ('ins_home',  '00000000-0000-4000-8000-0000004860c5', 'the home insurance renewal (insurance, names nobody)'),
    ('ins_both',  '00000000-0000-4000-8000-0000004860c6', 'a premium card that is finance AND a policy''s (names Ava)'),
    ('ins_kind',  '00000000-0000-4000-8000-0000004860c7', 'an insurance card with no source (names nobody)'),
    ('ins_gran',  '00000000-0000-4000-8000-0000004860c8', 'Grandma''s travel insurance renewal (insurance, names the guest)'),
    ('ord',       '00000000-0000-4000-8000-0000004860c9', 'an ordinary card (groceries)'),
    ('ord_mem',   '00000000-0000-4000-8000-0000004860ca', 'an ordinary card about Sam (appointment)'),
    ('med',       '00000000-0000-4000-8000-0000004860cb', 'a refill card (medication, everyone''s in audience.ts)');

  insert into public.autopilot_suggestions
    (id, family_id, member_id, kind, title, detail, payload, source_kind, source_id, dedupe_key, status, action_type)
  values
    ('00000000-0000-4000-8000-0000004860c1', fam, null, 'finance', '$15.99 charge: Netflix tomorrow', 'Charged to the card ending 4242',
     '{"titleFacts":{"kind":"charge","name":"Netflix","amountCents":1599,"inDays":1}}', 'subscriptions_tracked', gen_random_uuid(), 'probe486-fin', 'open', 'review_subscription'),
    ('00000000-0000-4000-8000-0000004860c2', fam, null, 'finance', 'Unused: Spotify — $10.99/mo', 'No activity in 60+ days',
     '{"titleFacts":{"kind":"unused","name":"Spotify","amountCents":1099}}', null, null, 'probe486-unused', 'open', 'review_subscription'),
    ('00000000-0000-4000-8000-0000004860c3', fam, null, 'document', 'Passport expires in 9 days', 'Renew before the trip',
     '{"title":"Renew Passport"}', 'renewals', gen_random_uuid(), 'probe486-ren', 'open', 'create_reminder'),
    ('00000000-0000-4000-8000-0000004860c4', fam, mN, 'insurance', 'dental insurance (Smile Co) renews in 5 days', 'Review coverage',
     '{"title":"Renew dental insurance (Smile Co)"}', 'family_insurance_policies', gen_random_uuid(), 'probe486-ins-ava', 'open', 'create_reminder'),
    ('00000000-0000-4000-8000-0000004860c5', fam, null, 'insurance', 'home insurance (Acme) renews in 6 days', 'Review coverage',
     '{"title":"Renew home insurance (Acme)"}', 'family_insurance_policies', gen_random_uuid(), 'probe486-ins-home', 'open', 'create_reminder'),
    ('00000000-0000-4000-8000-0000004860c6', fam, mN, 'finance', 'Premium due: Smile Co $42.00', 'Dental premium',
     '{"amountCents":4200}', 'family_insurance_policies', gen_random_uuid(), 'probe486-ins-both', 'open', 'none'),
    ('00000000-0000-4000-8000-0000004860c7', fam, null, 'insurance', 'Check the life cover (Shield)', 'Annual review',
     '{"title":"Review life cover (Shield)"}', null, null, 'probe486-ins-kind', 'open', 'none'),
    ('00000000-0000-4000-8000-0000004860c8', fam, mG, 'insurance', 'travel insurance (Roam) renews in 4 days', 'Review coverage',
     '{"title":"Renew travel insurance (Roam)"}', 'family_insurance_policies', gen_random_uuid(), 'probe486-ins-gran', 'open', 'create_reminder'),
    ('00000000-0000-4000-8000-0000004860c9', fam, null, 'groceries', 'Still need: milk', 'On the list for 5 days',
     '{"items":["milk"]}', 'grocery_items', gen_random_uuid(), 'probe486-ord', 'open', 'none'),
    ('00000000-0000-4000-8000-0000004860ca', fam, mU, 'appointment', 'Orthodontist tomorrow 4pm', 'Leave by 3:30',
     '{"title":"Orthodontist"}', 'appointments', gen_random_uuid(), 'probe486-ord-mem', 'open', 'create_reminder'),
    ('00000000-0000-4000-8000-0000004860cb', fam, mN, 'medication', 'Prescription refill due in 2 days', 'Open Medications to see which one.',
     '{"title":"Refill a prescription"}', 'medications', gen_random_uuid(), 'probe486-med', 'open', 'create_reminder');
  -- The neighbours' own card: their parent reads THIS, so "reads nothing of
  -- ours" is not a reader who reads nothing at all.
  insert into public.autopilot_suggestions (id, family_id, kind, title, dedupe_key, status)
  values ('00000000-0000-4000-8000-0000004860cc', away, 'groceries', 'Still need: bread', 'probe486-away', 'open');

  -- Who reads which card: audience.ts's answer for each reader.
  create temp table ap_who (label text primary key, uid uuid, as_role text not null, sees text[] not null) on commit drop;
  insert into ap_who values
    ('the parent',              uP,   'authenticated', array['fin','unused','ren','ins_ava','ins_home','ins_both','ins_kind','ins_gran','ord','ord_mem','med']),
    ('the adult',               uA,   'authenticated', array['fin','unused','ren','ins_ava','ins_home','ins_both','ins_kind','ins_gran','ord','ord_mem','med']),
    ('Ava (named child)',       uN,   'authenticated', array['fin','unused','ren','ins_ava','ins_both','ord','ord_mem','med']),
    ('Sam (unnamed teen)',      uU,   'authenticated', array['fin','unused','ren','ord','ord_mem','med']),
    ('the caregiver',           uC,   'authenticated', array['fin','unused','ren','ord','ord_mem','med']),
    ('the guest',               uG,   'authenticated', array['ins_gran','ord','ord_mem','med']),
    ('the inactive member',     uI,   'authenticated', array[]::text[]),
    ('another family''s parent', uX,  'authenticated', array[]::text[]),
    ('anon',                    null, 'anon',          array[]::text[]);

  -- ── 1. the matrix: each reader, each card, the leaked columns ─────────────
  for w in select * from ap_who order by label loop
    for r in select * from ap_card order by label loop
      v_want := case when r.label = any(w.sees) then '1' else '0' end;
      v_got := pg_temp.ap_as(w.uid, w.as_role,
        format('select title, detail, payload from public.autopilot_suggestions where id = %L', r.id), true);
      v_grp := case
        when w.label in ('the parent', 'the adult') then 'a manager reads every card'
        when w.label = 'another family''s parent' then 'another family''s member reads nothing'
        when w.label = 'the inactive member' then 'an inactive member reads nothing'
        when w.label = 'anon' then 'anon reads nothing'
        when r.label in ('ord', 'ord_mem', 'med') and w.label = 'the guest' then 'a guest still reads an ordinary card'
        when r.label in ('ord', 'ord_mem', 'med') then 'every member reads an ordinary card'
        when r.label in ('fin', 'unused', 'ren') and v_want = '1' then 'a non-guest member reads finance and renewal cards'
        when r.label in ('fin', 'unused', 'ren') then 'DENIED: a guest reads no finance or renewal copy'
        when v_want = '1' then 'the member a policy names reads its card'
        when w.label = 'the guest' then 'DENIED: a guest reads no insurance card that is not theirs'
        else 'DENIED: a non-manager reads no insurance card that does not name them'
      end;
      perform pg_temp.ap_expect(v_grp, format('%s %s %s (title, detail, payload)', w.label,
        case when v_want = '1' then 'reads' else 'must not read' end, r.about), v_got, v_want);
    end loop;

    -- The whole family, in one read: exactly the cards audience.ts gives them.
    v_got := pg_temp.ap_as(w.uid, w.as_role,
      format('select title, detail, payload from public.autopilot_suggestions where family_id = %L', fam), true);
    perform pg_temp.ap_expect(
      case when w.label in ('the guest', 'Sam (unnamed teen)', 'the caregiver', 'Ava (named child)')
           then 'DENIED: a family-wide read returns only the reader''s cards'
           else 'a family-wide read returns exactly the reader''s cards' end,
      format('%s reads %s of the family''s 11 cards', w.label, cardinality(w.sees)), v_got, cardinality(w.sees)::text);
  end loop;

  -- Nothing of the copied words reaches the readers they are withheld from,
  -- by any card, in any of the three columns.
  v_got := pg_temp.ap_as(uG, 'authenticated', format(
    'select 1 from public.autopilot_suggestions where family_id = %L and (title || coalesce(detail, '''') || payload::text) ~ %L',
    fam, 'Netflix|Spotify|Passport|Smile Co|Acme|Shield|4242'), true);
  perform pg_temp.ap_expect('DENIED: a guest reads no finance or renewal copy',
    'no title, detail or payload a guest reads names a subscription, the passport or another''s policy', v_got, '0');
  v_got := pg_temp.ap_as(uU, 'authenticated', format(
    'select 1 from public.autopilot_suggestions where family_id = %L and (title || coalesce(detail, '''') || payload::text) ~ %L',
    fam, 'Smile Co|Acme|Shield|Roam'), true);
  perform pg_temp.ap_expect('DENIED: a non-manager reads no insurance card that does not name them',
    'no title, detail or payload the unnamed teen reads names a policy', v_got, '0');
  v_got := pg_temp.ap_as(uX, 'authenticated',
    'select 1 from public.autopilot_suggestions where id = ''00000000-0000-4000-8000-0000004860cc''', true);
  perform pg_temp.ap_expect('another family''s member reads nothing',
    'another family''s parent still reads their OWN family''s card (control)', v_got, '1');

  -- ── 2. resolving: `update … select`, as resolveSuggestion does ────────────
  F := 'update public.autopilot_suggestions set status = ''dismissed'', resolved_at = now(), resolved_by = %L where id = %L returning id';
  perform pg_temp.ap_expect('a reader resolves the card they read', 'the named child dismisses her insurance card',
    pg_temp.ap_as(uN, 'authenticated', format(F, uN, '00000000-0000-4000-8000-0000004860c4'), false), '1');
  perform pg_temp.ap_expect('a reader resolves the card they read', 'the teen dismisses the subscription charge',
    pg_temp.ap_as(uU, 'authenticated', format(F, uU, '00000000-0000-4000-8000-0000004860c1'), false), '1');
  perform pg_temp.ap_expect('a reader resolves the card they read', 'the guest dismisses an ordinary card',
    pg_temp.ap_as(uG, 'authenticated', format(F, uG, '00000000-0000-4000-8000-0000004860c9'), false), '1');
  perform pg_temp.ap_expect('a reader resolves the card they read', 'the parent dismisses the home insurance card',
    pg_temp.ap_as(uP, 'authenticated', format(F, uP, '00000000-0000-4000-8000-0000004860c5'), false), '1');
  perform pg_temp.ap_expect('DENIED: a non-reader''s resolve matches no row', 'the guest dismisses the subscription charge',
    pg_temp.ap_as(uG, 'authenticated', format(F, uG, '00000000-0000-4000-8000-0000004860c1'), false), '0');
  perform pg_temp.ap_expect('DENIED: a non-reader''s resolve matches no row', 'the guest dismisses the renewal',
    pg_temp.ap_as(uG, 'authenticated', format(F, uG, '00000000-0000-4000-8000-0000004860c3'), false), '0');
  perform pg_temp.ap_expect('DENIED: a non-reader''s resolve matches no row', 'the unnamed teen dismisses Ava''s insurance card',
    pg_temp.ap_as(uU, 'authenticated', format(F, uU, '00000000-0000-4000-8000-0000004860c4'), false), '0');

  -- ── 3. the on-demand scan's write: `insert … select('id')` ───────────────
  F := 'insert into public.autopilot_suggestions (family_id, member_id, kind, title, source_kind, dedupe_key, status, created_by) '
    || 'values (%L, %L, %L, %L, %L, %L, ''open'', %L) returning id';
  perform pg_temp.ap_expect('a member''s scan writes a card they may read', 'the named child writes her own insurance card',
    pg_temp.ap_as(uN, 'authenticated', format(F, fam, mN, 'insurance', 'dental insurance (Smile Co) renews in 4 days', 'family_insurance_policies', 'probe486-scan-ava', uN), false), '1');
  perform pg_temp.ap_expect('a member''s scan writes a card they may read', 'the teen writes an ordinary card',
    pg_temp.ap_as(uU, 'authenticated', format(F, fam, null, 'groceries', 'Still need: eggs', 'grocery_items', 'probe486-scan-ord', uU), false), '1');
  perform pg_temp.ap_expect('a member''s scan writes a card they may read', 'the parent writes the household''s insurance card',
    pg_temp.ap_as(uP, 'authenticated', format(F, fam, null, 'insurance', 'home insurance (Acme) renews in 5 days', 'family_insurance_policies', 'probe486-scan-home', uP), false), '1');
  perform pg_temp.ap_expect('DENIED: a member''s scan cannot write a card they may not read back',
    'the unnamed teen writes Ava''s insurance card and reads it back (lib/autopilot/scan.ts skips this draft)',
    pg_temp.ap_as(uU, 'authenticated', format(F, fam, mN, 'insurance', 'dental insurance (Smile Co) renews in 4 days', 'family_insurance_policies', 'probe486-scan-sam', uU), false), 'refused');
  perform pg_temp.ap_expect('DENIED: a member''s scan cannot write a card they may not read back',
    'the guest writes a subscription charge and reads it back',
    pg_temp.ap_as(uG, 'authenticated', format(F, fam, null, 'finance', '$9.99 charge: Hulu tomorrow', 'subscriptions_tracked', 'probe486-scan-gran', uG), false), 'refused');


  -- ── 4. an UPDATE that names no column (RV486-2) ──────────────────────────
  -- Each write is followed, in the same session, by a read of the card it
  -- must not reach. "kept" means its member_id, kind, source_kind and status
  -- are what they were; a column-free write may still land on cards its
  -- writer may read, which is why the answer allows "<n> written".
  v_grp := 'DENIED: a column-free UPDATE does not reach a card its writer may not read (RV486-2)';
  perform pg_temp.ap_expect_re(v_grp, 'the unnamed teen names himself on every card (no WHERE): Ava''s insurance card is not touched and he still reads nothing',
    pg_temp.ap_write_read(uU, 'authenticated', format('update public.autopilot_suggestions set member_id = %L', mU), c_ava, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the unnamed teen, `where true` and a SET from auth.uid(): the household''s policy card is not touched',
    pg_temp.ap_write_read(uU, 'authenticated', format(
      -- Sam belongs to two households, so the subquery names this one; it
      -- names no column of autopilot_suggestions.
      'update public.autopilot_suggestions set member_id = (select fm.id from public.family_members fm where fm.user_id = auth.uid() and fm.family_id = %L) where true', fam), c_home, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the unnamed teen, PostgREST''s unfiltered PATCH with return=minimal: Ava''s insurance card is not touched',
    pg_temp.ap_write_read(uU, 'authenticated', format(PATCH, json_build_object('member_id', mU)::text), c_ava, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the unnamed teen turns every card into an ''other'' card (no WHERE): Ava''s insurance card is not touched',
    pg_temp.ap_write_read(uU, 'authenticated', 'update public.autopilot_suggestions set kind = ''other'', source_kind = null', c_ava, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the guest names herself on every card (`returning 1`): Ava''s insurance card is not touched and she still reads nothing',
    pg_temp.ap_write_read(uG, 'authenticated', format('update public.autopilot_suggestions set member_id = %L returning 1', mG), c_ava, uG), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the guest turns every card into an ''other'' card (no WHERE): the subscription charge is not touched',
    pg_temp.ap_write_read(uG, 'authenticated', 'update public.autopilot_suggestions set kind = ''other'', source_kind = null', c_fin, uG), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the guest dismisses every card (no WHERE): the subscription charge is not resolved by her',
    pg_temp.ap_write_read(uG, 'authenticated',
      'update public.autopilot_suggestions set status = ''dismissed'', resolved_at = now(), resolved_by = auth.uid()', c_fin, uG), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the caregiver names herself on every card (no WHERE): the premium card naming Ava is not touched',
    pg_temp.ap_write_read(uC, 'authenticated', format('update public.autopilot_suggestions set member_id = %L', mC), c_both, uC), HELD);

  v_grp := 'DENIED: a reader cannot relabel a card for someone outside its audience (RV486-2)';
  perform pg_temp.ap_expect_re(v_grp, 'Ava (named) moves every card to her brother (no WHERE): her insurance card still names her and Leo reads nothing',
    pg_temp.ap_write_read(uN, 'authenticated', format('update public.autopilot_suggestions set member_id = %L', mL), c_ava, uL), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'Ava (named) moves her insurance card to her brother by id, returning id',
    pg_temp.ap_write_read(uN, 'authenticated', format('update public.autopilot_suggestions set member_id = %L where id = %L returning id', mL, c_ava), c_ava, uL), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'Ava (named) gives every card to nobody (no WHERE): her insurance card still names her and she still reads it',
    pg_temp.ap_write_read(uN, 'authenticated', 'update public.autopilot_suggestions set member_id = null', c_ava, uN), KEPT_OWN);
  perform pg_temp.ap_expect_re(v_grp, 'the teen, who reads the subscription charge, turns it into an ''other'' card by id: the guest still reads nothing',
    pg_temp.ap_write_read(uU, 'authenticated', format('update public.autopilot_suggestions set kind = ''other'', source_kind = null where id = %L', c_fin), c_fin, uG), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'Ava (named) turns her insurance card into an ''other'' card by id: the unnamed teen still reads nothing',
    pg_temp.ap_write_read(uN, 'authenticated', format('update public.autopilot_suggestions set kind = ''other'', source_kind = null where id = %L', c_ava), c_ava, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the guest moves her travel insurance card out of insurance (a groceries card): the unnamed teen still reads nothing',
    pg_temp.ap_write_read(uG, 'authenticated', format('update public.autopilot_suggestions set kind = ''groceries'', source_kind = ''grocery_items'' where id = %L', c_gran), c_gran, uU), HELD);
  perform pg_temp.ap_expect_re(v_grp, 'the teen narrows an ordinary card to finance by id: the guest still reads it',
    pg_temp.ap_write_read(uU, 'authenticated', format('update public.autopilot_suggestions set kind = ''finance'' where id = %L', c_ord), c_ord, uG), KEPT_OWN);
  perform pg_temp.ap_expect_re(v_grp, 'a manager turns the subscription charge into an ''other'' card by id: the guest still reads nothing (the pin is not a role rule)',
    pg_temp.ap_write_read(uP, 'authenticated', format('update public.autopilot_suggestions set kind = ''other'', source_kind = null where id = %L', c_fin), c_fin, uG), HELD);

  -- ── 4b. a move into another family the writer also belongs to ───────────
  -- (RV486-2-FAMILY.) Every helper in the read rule, and 0085's membership,
  -- takes the card's family_id; a writer who belongs to two families passes
  -- 0085's WITH CHECK in the other one, the update guard's USING on the old
  -- row and its WITH CHECK on the new one. Each move is read back as the other
  -- family's reader (it must read nothing) and as this family's (the card is
  -- still here: a move out of the family is also the delete 0327 refuses).
  v_grp := 'DENIED: no client moves a card into another family it also belongs to (RV486-2-FAMILY)';
  F := 'update public.autopilot_suggestions set family_id = %L where id = %L returning id';
  perform pg_temp.ap_expect_re(v_grp, 'Ava (named, a child in both households) moves her insurance card to her co-parent''s by id, returning id: refused, and the co-parent reads nothing',
    pg_temp.ap_write_read(uN, 'authenticated', format(F, famB, c_ava), c_ava, uB), '^refused; kept; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'Ava''s move: her insurance card is still this family''s and Gran (the adult, of this family only) still reads it',
    pg_temp.ap_write_read(uN, 'authenticated', format(F, famB, c_ava), c_ava, uA), '^refused; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'Sam (a teen in both) moves the subscription charge by PostgREST''s filtered PATCH: refused, and the co-parent reads nothing',
    pg_temp.ap_write_read(uU, 'authenticated', format(PATCH_FAM, json_build_object('family_id', famB)::text, c_fin, fam), c_fin, uB), '^refused; kept; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'Sam''s PATCH: the subscription charge is still this family''s and Leo (of this family only) still reads it',
    pg_temp.ap_write_read(uU, 'authenticated', format(PATCH_FAM, json_build_object('family_id', famB)::text, c_fin, fam), c_fin, uL), '^refused; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'Sam moves every card he may update (no WHERE): the subscription charge stays, and the co-parent reads nothing',
    pg_temp.ap_write_read(uU, 'authenticated', format('update public.autopilot_suggestions set family_id = %L', famB), c_fin, uB), '^refused; kept; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'the guest (who runs her own household) moves an ordinary card into it by id: refused, and Grandpa there reads nothing',
    pg_temp.ap_write_read(uG, 'authenticated', format(F, famX, c_ord), c_ord, uY), '^refused; kept; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'the guest''s move: the ordinary card is still this family''s and the teen still reads it',
    pg_temp.ap_write_read(uG, 'authenticated', format(F, famX, c_ord), c_ord, uU), '^refused; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'Mum (a manager here, an adult in the co-parent''s) moves Ava''s card there: refused too (the pin is not a role rule)',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, famB, c_ava), c_ava, uB), '^refused; kept; reads 0$');

  v_grp := 'a manager says whose policy a card is';
  F := 'update public.autopilot_suggestions set member_id = %L where id = %L and family_id = %L returning id';
  perform pg_temp.ap_expect_re(v_grp, 'the parent reassigns Ava''s insurance card to Leo (the scan''s refresh on a manager''s client): Leo reads it',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, mL, c_ava, fam), c_ava, uL), '^1 written; changed:member_id; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'the parent reassigns Ava''s insurance card to Leo: Ava no longer reads it',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, mL, c_ava, fam), c_ava, uN), '^1 written; changed:member_id; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'the parent names Ava on the household''s policy card: Ava reads it',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, mN, c_home, fam), c_home, uN), '^1 written; changed:member_id; reads 1$');

  v_grp := 'a reader resolves the card they read';
  F := 'update public.autopilot_suggestions set status = ''dismissed'', resolved_at = now(), resolved_by = %L '
    || 'where id = %L and family_id = %L and status = ''open'' returning id, status, updated_at';
  perform pg_temp.ap_expect_re(v_grp, 'the named child dismisses her insurance card (update … select, as resolveSuggestion) and still reads it',
    pg_temp.ap_write_read(uN, 'authenticated', format(F, uN, c_ava, fam), c_ava, uN), RESOLVED);
  perform pg_temp.ap_expect_re(v_grp, 'the parent dismisses Ava''s insurance card (update … select) and still reads it',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, uP, c_ava, fam), c_ava, uP), RESOLVED);
  perform pg_temp.ap_expect_re(v_grp, 'the named child''s own scan archives her stale card (lib/autopilot/history.ts)',
    pg_temp.ap_write_read(uN, 'authenticated', format(
      'update public.autopilot_suggestions set status = ''snoozed'', expires_at = now(), dedupe_key = ''archived:'' || %L || '':probe486-ins-ava'' '
      || 'where family_id = %L and id = %L and status = ''open'' returning id', c_ava, fam, c_ava), c_ava, uN), '^1 written; changed:status; reads 1$');

  -- ── 5. 0327's guards hold beside 0486's ──────────────────────────────────
  v_grp := '0327 still holds: a resolution names its own author, and no client deletes';
  F := 'update public.autopilot_suggestions set status = ''dismissed'', resolved_at = now(), resolved_by = %L where id = %L returning id';
  perform pg_temp.ap_expect_re(v_grp, 'the named child cannot sign her dismissal as the parent',
    pg_temp.ap_write_read(uN, 'authenticated', format(F, uP, c_ava), c_ava, uN), '^refused; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'the parent cannot sign a dismissal as the named child',
    pg_temp.ap_write_read(uP, 'authenticated', format(F, uN, c_ava), c_ava, uP), '^refused; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'the named child cannot delete her insurance card',
    pg_temp.ap_write_read(uN, 'authenticated', format('delete from public.autopilot_suggestions where id = %L', c_ava), c_ava, uN), '^0 written; kept; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'a manager cannot delete it either',
    pg_temp.ap_write_read(uP, 'authenticated', format('delete from public.autopilot_suggestions where id = %L', c_ava), c_ava, uP), '^0 written; kept; reads 1$');

  -- ── 6. a card written before the scan stored the policy's member ────────
  -- Policies as the Insurance Hub writes them, and cards as the scan wrote
  -- them before it stored the policy's member: member_id null. Three more the
  -- backfill must leave alone.
  insert into public.family_insurance_policies (id, family_id, policy_type, insurer, member_id, renewal_date, is_active) values
    (p_leg,   fam,  'vision', 'ClearView', mN,   current_date + 9,  true),
    (p_none,  fam,  'home',   'Riverside', null, current_date + 10, true),
    (p_away,  away, 'life',   'Northwind', mX,   current_date + 11, true),
    (p_moved, fam,  'pet',    'Paws',      mN,   current_date + 12, true);
  insert into public.autopilot_suggestions
    (id, family_id, member_id, kind, title, detail, payload, source_kind, source_id, dedupe_key, status, action_type)
  values
    (c_leg,   fam, null, 'insurance', 'vision insurance (ClearView) renews in 9 days', 'Review coverage',
     '{"title":"Renew vision insurance (ClearView)"}', 'family_insurance_policies', p_leg, 'probe486-legacy', 'open', 'create_reminder'),
    (c_none,  fam, null, 'insurance', 'home insurance (Riverside) renews in 10 days', 'Review coverage',
     '{"title":"Renew home insurance (Riverside)"}', 'family_insurance_policies', p_none, 'probe486-legacy-none', 'open', 'create_reminder'),
    (c_away,  fam, null, 'insurance', 'life insurance (Northwind) renews in 11 days', 'Review coverage',
     '{"title":"Renew life insurance (Northwind)"}', 'family_insurance_policies', p_away, 'probe486-legacy-away', 'open', 'create_reminder'),
    (c_moved, fam, mU,   'insurance', 'pet insurance (Paws) renews in 12 days', 'Review coverage',
     '{"title":"Renew pet insurance (Paws)"}', 'family_insurance_policies', p_moved, 'probe486-legacy-moved', 'open', 'create_reminder');

  v_grp := 'a legacy insurance card, before 0486''s backfill: the managers'' alone';
  F := format('select title, detail, payload from public.autopilot_suggestions where id = %L', c_leg);
  perform pg_temp.ap_expect(v_grp, 'Ava, whom the policy names, cannot read its card naming nobody (the regression the backfill closes)',
    pg_temp.ap_as(uN, 'authenticated', F, true), '0');
  perform pg_temp.ap_expect(v_grp, 'the parent reads it', pg_temp.ap_as(uP, 'authenticated', F, true), '1');
  perform pg_temp.ap_expect(v_grp, 'the unnamed teen does not', pg_temp.ap_as(uU, 'authenticated', F, true), '0');
end
$probe$;

-- ── 7. 0486 itself, re-applied in this transaction ──────────────────────────
-- The real file, so what is asserted is what the owner applies: its backfill
-- over the legacy cards above, its policies, its pin and its self-check (a
-- refusal stops the probe with the migration's own error).
\ir ../../supabase/migrations/0486_an_autopilot_card_is_read_by_its_audience.sql

create temp table ap_snapshot (taken text primary key, digest text not null) on commit drop;

do $after$
declare
  fx  jsonb := (select jsonb_object_agg(k, v) from ap_fx);
  F   text;
  v_grp text;
  v_member uuid;
begin
  v_grp := 'a legacy insurance card names the member its policy names after 0486''s backfill';
  F := format('select title, detail, payload from public.autopilot_suggestions where id = %L', fx->>'c_leg');
  perform pg_temp.ap_expect(v_grp, 'Ava, whom the policy names, now reads its card',
    pg_temp.ap_as((fx->>'uN')::uuid, 'authenticated', F, true), '1');
  perform pg_temp.ap_expect(v_grp, 'the parent still reads it', pg_temp.ap_as((fx->>'uP')::uuid, 'authenticated', F, true), '1');
  perform pg_temp.ap_expect(v_grp, 'the unnamed teen still does not', pg_temp.ap_as((fx->>'uU')::uuid, 'authenticated', F, true), '0');
  perform pg_temp.ap_expect(v_grp, 'the guest still does not', pg_temp.ap_as((fx->>'uG')::uuid, 'authenticated', F, true), '0');

  select member_id into v_member from public.autopilot_suggestions where id = (fx->>'c_leg')::uuid;
  perform pg_temp.ap_expect(v_grp, 'the card names Ava', case when v_member = (fx->>'mN')::uuid then '1' else coalesce(v_member::text, 'null') end, '1');
  select member_id into v_member from public.autopilot_suggestions where id = (fx->>'c_none')::uuid;
  perform pg_temp.ap_expect(v_grp, 'a card whose policy names nobody still names nobody', coalesce(v_member::text, 'null'), 'null');
  select member_id into v_member from public.autopilot_suggestions where id = (fx->>'c_away')::uuid;
  perform pg_temp.ap_expect(v_grp, 'a card whose source is ANOTHER family''s policy is not given that family''s member', coalesce(v_member::text, 'null'), 'null');
  select member_id into v_member from public.autopilot_suggestions where id = (fx->>'c_moved')::uuid;
  perform pg_temp.ap_expect(v_grp, 'a card that already names a member keeps it (a reassigned policy is the scan''s to follow)',
    case when v_member = (fx->>'mU')::uuid then 'Sam' else coalesce(v_member::text, 'null') end, 'Sam');

  insert into ap_snapshot
  select 'after the first re-apply', md5(coalesce(string_agg(s.id::text || ':' || s.ctid::text, ',' order by s.id), ''))
    from public.autopilot_suggestions s;
end
$after$;

-- And once more: the second run must write no row at all.
\ir ../../supabase/migrations/0486_an_autopilot_card_is_read_by_its_audience.sql

do $controls$
declare
  fx  jsonb := (select jsonb_object_agg(k, v) from ap_fx);
  r record;
  v_grp text;
  v_digest text;
  failures text[] := '{}';
  summary text := '';
begin
  select md5(coalesce(string_agg(s.id::text || ':' || s.ctid::text, ',' order by s.id), '')) into v_digest
    from public.autopilot_suggestions s;
  perform pg_temp.ap_expect('a legacy insurance card names the member its policy names after 0486''s backfill',
    're-applying 0486 again rewrites no card (every row''s ctid unchanged)',
    case when v_digest = (select digest from ap_snapshot where taken = 'after the first re-apply') then 'unchanged' else 'rewritten' end,
    'unchanged');

  -- ── 8. NEGATIVE CONTROLS: without each guard its defect is back ─────────
  v_grp := 'negative control: the probe sees the defect';
  -- The pin ALONE (both policies still in place): the family moves and the
  -- reader's widening are the pin's to hold, not the policies'.
  drop trigger if exists autopilot_suggestions_keep_their_audience on public.autopilot_suggestions;
  perform pg_temp.ap_expect_re(v_grp, 'with only the pin dropped Ava moves her insurance card to her co-parent''s household, and the co-parent reads it',
    pg_temp.ap_write_read((fx->>'uN')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set family_id = %L where id = %L returning id', fx->>'famB', fx->>'c_ava'),
      (fx->>'c_ava')::uuid, (fx->>'uB')::uuid),
    '^1 written; changed:family_id; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'with only the pin dropped Ava''s move takes the card out of this family: Gran (the adult, of this family only) no longer reads it',
    pg_temp.ap_write_read((fx->>'uN')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set family_id = %L where id = %L returning id', fx->>'famB', fx->>'c_ava'),
      (fx->>'c_ava')::uuid, (fx->>'uA')::uuid),
    '^1 written; changed:family_id; reads 0$');
  perform pg_temp.ap_expect_re(v_grp, 'with only the pin dropped Sam''s filtered PATCH moves the subscription charge, and the co-parent reads it',
    pg_temp.ap_write_read((fx->>'uU')::uuid, 'authenticated',
      format('with pgrst_source as (update public.autopilot_suggestions set family_id = pgrst_body.family_id '
        || 'from (select %L::json as json_data) pgrst_payload, '
        || 'lateral (select family_id from json_populate_record(null::public.autopilot_suggestions, pgrst_payload.json_data)) pgrst_body '
        || 'where public.autopilot_suggestions.id = %L::uuid and public.autopilot_suggestions.family_id = %L::uuid '
        || 'returning public.autopilot_suggestions.*) select count(*) from pgrst_source',
        json_build_object('family_id', fx->>'famB')::text, fx->>'c_fin', fx->>'fam'),
      (fx->>'c_fin')::uuid, (fx->>'uB')::uuid),
    '^1 written; changed:family_id; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'with only the pin dropped the guest moves an ordinary card into her own household, and Grandpa reads it',
    pg_temp.ap_write_read((fx->>'uG')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set family_id = %L where id = %L returning id', fx->>'famX', fx->>'c_ord'),
      (fx->>'c_ord')::uuid, (fx->>'uY')::uuid),
    '^1 written; changed:family_id; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'with only the pin dropped the teen turns the subscription charge into an ''other'' card, and the guest reads it',
    pg_temp.ap_write_read((fx->>'uU')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set kind = ''other'', source_kind = null where id = %L', fx->>'c_fin'),
      (fx->>'c_fin')::uuid, (fx->>'uG')::uuid),
    '^1 written; changed:kind,source_kind; reads 1$');
  drop policy if exists autopilot_suggestions_audience_update_guard on public.autopilot_suggestions;
  perform pg_temp.ap_expect_re(v_grp, 'with the update guard dropped as well the unnamed teen''s column-free write names him on Ava''s insurance card, and he reads it',
    pg_temp.ap_write_read((fx->>'uU')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set member_id = %L', fx->>'mU'), (fx->>'c_ava')::uuid, (fx->>'uU')::uuid),
    '^[0-9]+ written; changed:member_id; reads 1$');
  perform pg_temp.ap_expect_re(v_grp, 'with the update guard dropped as well Ava''s column-free write moves her card to her brother, and he reads it',
    pg_temp.ap_write_read((fx->>'uN')::uuid, 'authenticated',
      format('update public.autopilot_suggestions set member_id = %L', fx->>'mL'), (fx->>'c_ava')::uuid, (fx->>'uL')::uuid),
    '^[0-9]+ written; changed:member_id; reads 1$');
  drop policy if exists autopilot_suggestions_audience_read_guard on public.autopilot_suggestions;
  perform pg_temp.ap_expect(v_grp, 'with the read policy dropped the guest reads the subscription charge again',
    pg_temp.ap_as((fx->>'uG')::uuid, 'authenticated', format('select title, detail, payload from public.autopilot_suggestions where id = %L', fx->>'c_fin'), true), '1');
  perform pg_temp.ap_expect(v_grp, 'with the read policy dropped the unnamed teen reads Ava''s insurance card again',
    pg_temp.ap_as((fx->>'uU')::uuid, 'authenticated', format('select title, detail, payload from public.autopilot_suggestions where id = %L', fx->>'c_ava'), true), '1');

  -- ── verdict ───────────────────────────────────────────────────────────────
  for r in select grp, count(*) as n, count(*) filter (where ok) as passed from ap_result group by grp order by min(seq) loop
    summary := summary || format(E'\n  %s/%s  %s', r.passed, r.n, r.grp);
  end loop;
  select coalesce(array_agg(format('%s: %s (got %s, want %s)', grp, label, got, want) order by seq), '{}')
    into failures from ap_result where not ok;
  if cardinality(failures) > 0 then
    raise notice 'an-autopilot-card-is-read-by-its-audience, checks passed per group:%', summary;
    raise exception E'an Autopilot card is not read by its audience (0486), % of % checks failed:\n  - %',
      cardinality(failures), (select count(*) from ap_result), array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'an-autopilot-card-is-read-by-its-audience: OK (% checks: a guest reads no subscription or renewal copy, a non-manager no policy card that does not name them; managers read every card, a policy''s member its card, non-guests the finance cards, everyone the ordinary ones; another family, an inactive member and anon read nothing; resolve and the scan''s read-back follow the same rule; a column-free UPDATE reaches no card its writer may not read and no reader relabels a card out of its audience or moves it into another family they belong to, while a manager reassigns one and readers resolve; 0327 still holds; a legacy insurance card names its policy''s member after 0486 re-applied here, and re-applying again writes nothing; negative controls reproduced each defect)%',
    (select count(*) from ap_result), summary;
end
$controls$;

rollback;
