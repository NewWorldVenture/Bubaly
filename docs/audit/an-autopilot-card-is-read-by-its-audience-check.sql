-- ── An Autopilot card is read by its audience (0486) ────────────────────────
--
-- Companion to 0486_an_autopilot_card_is_read_by_its_audience. An Autopilot
-- card is a copy the service-role scan makes of a source row, and until 0486 it
-- was read under 0085's family-wide policy: a guest whom 0481 refuses
-- `subscriptions_tracked` and `renewals` read the cards copied from both,
-- title, detail and payload. 0486 adds one RESTRICTIVE read policy that is
-- lib/autopilot/audience.ts's rule:
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
-- NEGATIVE CONTROL, in this transaction: with 0486's policy dropped, the guest
-- reads the subscription charge and the teen reads the child's insurance card
-- again, so this probe is shown to see the defect. Replayed without 0486 the
-- probe fails on exactly the guest and unnamed-member lines and passes the
-- rest (the per-group summary below says which).
--
-- Rolled back: nothing here outlives the run.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql
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

create temp table ap_result (seq serial, grp text, label text, got text, want text, ok boolean) on commit drop;

-- want: a number of rows, or 'refused' (42501).
create function pg_temp.ap_expect(grp text, label text, got text, want text) returns void
language plpgsql as $f$
begin
  insert into ap_result (grp, label, got, want, ok)
  values (grp, label, got, want,
          case when want = '0' then got in ('0', 'refused') else got = want end);
end $f$;

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
  mN uuid; mU uuid; mG uuid;
  r record;
  w record;
  v_got text;
  v_want text;
  v_grp text;
  F text;
  failures text[] := '{}';
  summary text := '';
begin
  -- ── fixture, written as the table owner with no session (auth.uid() null) ──
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id, email) values
    (uP, 'ap486-parent@example.test'), (uA, 'ap486-adult@example.test'), (uN, 'ap486-ava@example.test'),
    (uU, 'ap486-sam@example.test'), (uC, 'ap486-sitter@example.test'), (uG, 'ap486-gran@example.test'),
    (uI, 'ap486-former@example.test'), (uX, 'ap486-away@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'Autopilot audience probe'), (away, 'Autopilot audience probe, next door')
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uP, 'Mum', 'parent', true), (fam, uA, 'Gran', 'adult', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uN, 'Ava', 'child', true) returning id into mN;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uU, 'Sam', 'teen', true) returning id into mU;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uC, 'Sitter', 'caregiver', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uG, 'Grandma', 'guest', true) returning id into mG;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, uI, 'Former parent', 'parent', false),
    (away, uX, 'Neighbour', 'parent', true);

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

  -- ── 4. NEGATIVE CONTROL: without 0486's policy the leak is back ──────────
  drop policy if exists autopilot_suggestions_audience_read_guard on public.autopilot_suggestions;
  perform pg_temp.ap_expect('negative control: the probe sees the defect', 'with the policy dropped the guest reads the subscription charge again',
    pg_temp.ap_as(uG, 'authenticated', 'select title, detail, payload from public.autopilot_suggestions where id = ''00000000-0000-4000-8000-0000004860c1''', true), '1');
  perform pg_temp.ap_expect('negative control: the probe sees the defect', 'with the policy dropped the unnamed teen reads Ava''s insurance card again',
    pg_temp.ap_as(uU, 'authenticated', 'select title, detail, payload from public.autopilot_suggestions where id = ''00000000-0000-4000-8000-0000004860c4''', true), '1');

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
  raise notice 'an-autopilot-card-is-read-by-its-audience: OK (% checks: a guest reads no subscription or renewal copy, a non-manager no policy card that does not name them; managers read every card, a policy''s member its card, non-guests the finance cards, everyone the ordinary ones; another family, an inactive member and anon read nothing; resolve and the scan''s read-back follow the same rule; negative control reproduced the leak)%',
    (select count(*) from ap_result), summary;
end
$probe$;

rollback;
