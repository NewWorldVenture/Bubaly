-- ── A trip links a document once ────────────────────────────────────────────
--
-- 0484 builds the unique index vacation_documents_vacation_document_key on
-- (vacation_id, document_id), the index lib/services/documents/index.ts already
-- assumes when it reads a 23505 as "already linked". Before building it, the
-- migration runs public.vacation_documents_duplicates_refuse(): if any pair is
-- linked more than once it raises 23505, naming the count and a sample of the
-- pairs, and the migration stops there having deleted nothing (an earlier draft
-- collapsed duplicates to their earliest row; the owner asked for a refusal).
--
-- What this probe asserts, on a throwaway family, everything rolled back:
--
--   b. the released schema: the preflight function is there; the index exists
--      with exactly (vacation_id, document_id); the first link of a document to
--      a trip lands; a second identical link is refused with 23505 and the trip
--      still carries the document once; two rows with no document_id (a typed
--      passport number, a visa number) coexist, since a unique index treats
--      NULLs as distinct.
--   a. the preflight over duplicates: with the index dropped INSIDE this
--      transaction (the only way to seed a duplicate at all) and one document
--      linked twice to one trip, the preflight refuses with 23505 and 0484's own
--      sentence naming that pair; BOTH rows are still there afterwards and no
--      other row of the family moved; the index statement itself cannot be run
--      over them either; with one of the two removed by hand, the preflight
--      passes and the index builds.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

\set ON_ERROR_STOP on
begin;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000004840f';
  usr  uuid := '00000000-0000-4000-8000-000000048401';
  trip uuid := '00000000-0000-4000-8000-000000048410';
  docA uuid := '00000000-0000-4000-8000-000000048411';
  docB uuid := '00000000-0000-4000-8000-000000048412';
  failures text[] := '{}';
  n int;
  got text;
  v_keys text;
begin
  -- ── fixture, written as the table owner with no session ──────────────────
  insert into auth.users (id, email) values (usr, 'trip-links-once@probe.test') on conflict (id) do nothing;
  insert into public.families (id, name) values (fam, 'Trip links a document once probe');
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, usr, 'Parent', 'parent', true);
  insert into public.vacations (id, family_id, title, created_by) values (trip, fam, 'Lisbon', usr);
  insert into public.documents (id, family_id, title, category, storage_path, created_by) values
    (docA, fam, 'Passport scan', 'travel', fam::text || '/passport.pdf', usr),
    (docB, fam, 'Hotel booking', 'travel', fam::text || '/hotel.pdf', usr);

  -- ── b. the released schema ────────────────────────────────────────────────
  if to_regprocedure('public.vacation_documents_duplicates_refuse()') is null then
    failures := array_append(failures, 'b0: public.vacation_documents_duplicates_refuse(), 0484''s preflight, is missing');
  end if;

  select string_agg(a.attname, ',' order by k.ord)
    into v_keys
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where c.relname = 'vacation_documents_vacation_document_key'
     and i.indrelid = 'public.vacation_documents'::regclass
     and i.indisunique
     and i.indpred is null
     and i.indexprs is null;
  if v_keys is distinct from 'vacation_id,document_id' then
    failures := array_append(failures, format('b1: no plain unique index vacation_documents_vacation_document_key on (vacation_id, document_id); found %s', coalesce(v_keys, 'none')));
  end if;

  begin
    insert into public.vacation_documents (family_id, vacation_id, title, document_id, created_by)
      values (fam, trip, 'Passport scan', docA, usr);
  exception when others then
    failures := array_append(failures, format('b2: the first link of a document to a trip was refused (%s: %s)', sqlstate, sqlerrm));
  end;

  begin
    insert into public.vacation_documents (family_id, vacation_id, title, document_id, created_by)
      values (fam, trip, 'Passport scan, again', docA, usr);
    failures := array_append(failures, 'b3: a second link of the same document to the same trip landed');
  exception
    when unique_violation then null;  -- 23505: what the application reads as "already linked"
    when others then
      failures := array_append(failures, format('b3: the second link was refused, but not by 23505 (%s: %s)', sqlstate, sqlerrm));
  end;
  select count(*) into n from public.vacation_documents where vacation_id = trip and document_id = docA;
  if n <> 1 then
    failures := array_append(failures, format('b3: the trip carries the document %s time(s), once expected', n));
  end if;

  begin
    insert into public.vacation_documents (family_id, vacation_id, title, number, created_by) values
      (fam, trip, 'Passport number', 'P1234567', usr),
      (fam, trip, 'Visa number',     'V7654321', usr);
  exception when others then
    failures := array_append(failures, format('b4: two rows with no document_id did not coexist (%s: %s)', sqlstate, sqlerrm));
  end;

  -- ── a. the preflight over seeded duplicates ───────────────────────────────
  -- Dropped INSIDE this transaction so a duplicate can be seeded at all; the
  -- rollback at the end puts it back.
  drop index public.vacation_documents_vacation_document_key;
  insert into public.vacation_documents (family_id, vacation_id, title, document_id, created_by) values
    (fam, trip, 'Hotel booking',         docB, usr),
    (fam, trip, 'Hotel booking (again)', docB, usr);
  select count(*) into n from public.vacation_documents where vacation_id = trip and document_id = docB;
  if n <> 2 then
    failures := array_append(failures, format('a0: seeded %s duplicate link(s), 2 expected', n));
  end if;

  -- a1. the preflight refuses, with 23505 and 0484's sentence naming the pair
  begin
    perform public.vacation_documents_duplicates_refuse();
    failures := array_append(failures, 'a1: the preflight passed over a pair linked twice');
  exception
    when unique_violation then
      got := sqlerrm;
      if got !~ '^0484: 1 \(vacation_id, document_id\) pair\(s\) are linked more than once \(1 surplus row\(s\)\)'
         or got !~ 'no row was deleted'
         or got !~ 'Dedupe by hand'
         or got !~ format('\(vacation %s, document %s\) x2', trip, docB) then
        failures := array_append(failures, format('a1: the preflight refused with 23505, but not with 0484''s sentence: %s', got));
      end if;
    when others then
      failures := array_append(failures, format('a1: the preflight refused, but not with 23505 (%s: %s)', sqlstate, sqlerrm));
  end;

  -- a2. no row loss: both duplicates, and everything else of the family, still there
  select count(*) into n from public.vacation_documents where vacation_id = trip and document_id = docB;
  if n <> 2 then
    failures := array_append(failures, format('a2: after the refusal %s of the 2 duplicate rows remain, so the preflight deleted something', n));
  end if;
  select count(*) into n from public.vacation_documents where family_id = fam;
  if n <> 5 then
    failures := array_append(failures, format('a2: the family has %s vacation_documents rows, 5 expected; the refusal must touch nothing', n));
  end if;

  -- a3. the index statement cannot be run over them either
  begin
    create unique index vacation_documents_vacation_document_key
      on public.vacation_documents (vacation_id, document_id);
    failures := array_append(failures, 'a3: the unique index was built over a pair linked twice');
  exception
    when unique_violation then null;
    when others then
      failures := array_append(failures, format('a3: building the index over duplicates failed, but not with 23505 (%s: %s)', sqlstate, sqlerrm));
  end;

  -- a4. control: with the duplicate removed by hand, the preflight passes and the index builds
  delete from public.vacation_documents
   where id = (select id from public.vacation_documents
                where vacation_id = trip and document_id = docB
                order by created_at desc, id desc limit 1);
  begin
    perform public.vacation_documents_duplicates_refuse();
  exception when others then
    failures := array_append(failures, format('a4: with no duplicate left the preflight still refused (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    create unique index if not exists vacation_documents_vacation_document_key
      on public.vacation_documents (vacation_id, document_id);
  exception when others then
    failures := array_append(failures, format('a4: with no duplicate left the index did not build (%s: %s)', sqlstate, sqlerrm));
  end;
  if not exists (select 1 from pg_class c join pg_index i on i.indexrelid = c.oid
                  where c.relname = 'vacation_documents_vacation_document_key'
                    and i.indrelid = 'public.vacation_documents'::regclass and i.indisunique) then
    failures := array_append(failures, 'a4: with no duplicate left the index is still not there');
  end if;

  if array_length(failures, 1) > 0 then
    raise exception E'a trip does not link a document once:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-trip-links-a-document-once: OK (released schema: the preflight function and the unique index on (vacation_id, document_id) are there, the first link lands, a second identical link is refused by 23505 and the trip carries the document once, two rows with no document_id coexist; preflight: over a pair seeded twice vacation_documents_duplicates_refuse() refuses with 23505 and 0484''s sentence naming the pair, both rows and every other row of the family are still there, the index cannot be built over them, and with one removed by hand the preflight passes and the index builds)';
end
$probe$;

rollback;
