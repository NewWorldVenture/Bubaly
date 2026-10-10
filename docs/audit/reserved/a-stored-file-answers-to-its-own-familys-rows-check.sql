-- ── A stored file answers to its own family's rows ──────────────────────────
--
-- The `documents` bucket's policies (0007 upload, 0303 read/update/delete)
-- asked only whether the caller belongs to the folder's family and whether a
-- SENSITIVE documents row of ANY family restricts the object. The held 0499
-- makes a write follow the row of the object's OWN family that names it:
--
--   * an insurance card image (insurance_policies.front_image_path /
--     back_image_path, written by managers only) is written by managers only;
--   * the bytes behind a documents row are not written by that family's guest
--     (0464's rule at the bytes);
--   * nobody without the right uploads at a sensitive document's path;
--   * a row planted by ANOTHER family neither hides the file nor blocks its own
--     family's writes;
--   * all of this holds for an object stored under a family id spelt any way
--     the policies' uuid cast accepts (braces, no hyphens, upper case), and a
--     first folder that is not a uuid fails closed: a read finds no row or is
--     refused by the cast itself (22P02, exact), and an upload is refused by
--     that cast or a policy (42501); any other error fails the probe rather
--     than counting as closed.
--
-- What this probe asserts, through PostgREST's role on storage.objects (the
-- statements storage-api runs under the caller's RLS), for each of the six
-- roles of one family and one parent of another family, on nine objects (six
-- under the canonical family id; a sensitive document, an insurance card image
-- and a household document under its braces, no-hyphen and upper-case
-- spellings):
--
--   read (r), replace in place (u), move the file away from its path (m),
--   move another file onto the path (o), remove (d) and upload at the path (i),
--   o and i starting from a missing object whose row still names the path. Each
--   runs in its own rolled-back subtransaction; a filtered write (0 rows) and a
--   42501 from a WITH CHECK both count as refused. The result is compared with
--   an expected matrix. A cell that allows more than
--   expected is a defect line; one that allows less is a CONTROL line (0499
--   must not take away what the rows allow: tax files and the family's own
--   use of its files are the controls).
--
-- Then, only where 0499 is installed, four MUTATION CONTROLS inside
-- rolled-back subtransactions, each of which must turn a refusal back into a
-- landing, so every refusal is attributed to the clause that 0499 adds:
--
--   M1. the delete policy without `not document_object_write_is_refused`:
--       the child's delete of the insurance image lands;
--   M4. the update policy's USING half without it: the child's move of the
--       insurance image away from its path lands;
--   M2. document_object_write_is_refused without its own-family binding: the
--       planted foreign insurance row blocks the family's own parent;
--   M3. document_object_is_restricted as 0303 wrote it: the planted foreign
--       sensitive row hides the family's file from its own parent.
--
-- And a catalog check: the bucket still has exactly four policies, and every
-- write half carries the new clause.
--
-- Everything is rolled back.
--
-- HELD with 0499: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/stored-file-rows-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0499 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8499-0000000000a1','s0499-parent@example.com'),
  ('00000000-0000-4000-8499-0000000000a2','s0499-adult@example.com'),
  ('00000000-0000-4000-8499-0000000000a3','s0499-teen@example.com'),
  ('00000000-0000-4000-8499-0000000000a4','s0499-child@example.com'),
  ('00000000-0000-4000-8499-0000000000a5','s0499-caregiver@example.com'),
  ('00000000-0000-4000-8499-0000000000a6','s0499-guest@example.com'),
  ('00000000-0000-4000-8499-0000000000b1','s0499-other-parent@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8499-0000000000f1','Stored File House','00000000-0000-4000-8499-0000000000a1'),
  ('00000000-0000-4000-8499-0000000000f2','Other House','00000000-0000-4000-8499-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8499-0000000000a1','00000000-0000-4000-8499-0000000000b1');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8499-0000000000f1','00000000-0000-4000-8499-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8499-0000000000f1','00000000-0000-4000-8499-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8499-0000000000f1','00000000-0000-4000-8499-0000000000a4','Kid','child',true),
  ('00000000-0000-4000-8499-0000000000f1','00000000-0000-4000-8499-0000000000a5','Nanny','caregiver',true),
  ('00000000-0000-4000-8499-0000000000f1','00000000-0000-4000-8499-0000000000a6','Grandma','guest',true);
-- The teen is also a guest of the other family, so a guest rule read from that
-- family's planted row would refuse the teen on this family's file: that is
-- what makes the write helper's own-family binding on documents rows load-bearing.
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8499-0000000000f2','00000000-0000-4000-8499-0000000000a3','Visiting teen','guest',true);
insert into storage.buckets (id, name, public) values ('documents','documents',false) on conflict (id) do nothing;

-- The family's files, each beside the row the app writes for it.
insert into public.insurance_policies (family_id, insurer, front_image_path, back_image_path) values
  ('00000000-0000-4000-8499-0000000000f1','Acme Health',
   '00000000-0000-4000-8499-0000000000f1/insurance/1700000000001-front.png',
   '00000000-0000-4000-8499-0000000000f1/insurance/1700000000002-back.png');
insert into public.documents (family_id, title, category, storage_path, is_secure, created_by) values
  ('00000000-0000-4000-8499-0000000000f1','Fridge warranty','warranty',
   '00000000-0000-4000-8499-0000000000f1/home/1700000000003-warranty.pdf',false,'00000000-0000-4000-8499-0000000000a1'),
  ('00000000-0000-4000-8499-0000000000f1','Passport','identity',
   '00000000-0000-4000-8499-0000000000f1/identity/1700000000005-passport.pdf',true,'00000000-0000-4000-8499-0000000000a1'),
  ('00000000-0000-4000-8499-0000000000f1','Boiler manual','manual',
   '00000000-0000-4000-8499-0000000000f1/home/1700000000006-manual.pdf',false,'00000000-0000-4000-8499-0000000000a1');
-- The same three kinds of row, each naming an object stored under a family id
-- spelt the way the uuid cast accepts but the canonical text is not: braces,
-- no hyphens, upper case. The policies' membership cast reads each as this
-- family, so the row helpers must too.
insert into public.documents (family_id, title, category, storage_path, is_secure, created_by) values
  ('00000000-0000-4000-8499-0000000000f1','Passport (braces)','identity',
   '{00000000-0000-4000-8499-0000000000f1}/identity/1700000000007-passport.pdf',true,'00000000-0000-4000-8499-0000000000a1'),
  ('00000000-0000-4000-8499-0000000000f1','Dryer warranty (upper case)','warranty',
   '00000000-0000-4000-8499-0000000000F1/home/1700000000009-warranty.pdf',false,'00000000-0000-4000-8499-0000000000a1');
insert into public.insurance_policies (family_id, insurer, front_image_path) values
  ('00000000-0000-4000-8499-0000000000f1','Acme Dental',
   '000000000000400084990000000000f1/insurance/1700000000008-front.png');
insert into public.tax_documents (family_id, tax_year, category, name, storage_path) values
  ('00000000-0000-4000-8499-0000000000f1',2025,'w2','W-2',
   '00000000-0000-4000-8499-0000000000f1/tax/2025/1700000000004-w2.pdf');
insert into storage.objects (bucket_id, name, owner)
  select 'documents', n, '00000000-0000-4000-8499-0000000000a1'::uuid from unnest(array[
    '00000000-0000-4000-8499-0000000000f1/insurance/1700000000001-front.png',
    '00000000-0000-4000-8499-0000000000f1/insurance/1700000000002-back.png',
    '00000000-0000-4000-8499-0000000000f1/home/1700000000003-warranty.pdf',
    '00000000-0000-4000-8499-0000000000f1/tax/2025/1700000000004-w2.pdf',
    '00000000-0000-4000-8499-0000000000f1/identity/1700000000005-passport.pdf',
    '00000000-0000-4000-8499-0000000000f1/home/1700000000006-manual.pdf',
    '{00000000-0000-4000-8499-0000000000f1}/identity/1700000000007-passport.pdf',
    '000000000000400084990000000000f1/insurance/1700000000008-front.png',
    '00000000-0000-4000-8499-0000000000F1/home/1700000000009-warranty.pdf']) as n;

do $$
declare
  fam      constant uuid := '00000000-0000-4000-8499-0000000000f1';
  other    constant uuid := '00000000-0000-4000-8499-0000000000f2';
  manual   constant text := '00000000-0000-4000-8499-0000000000f1/home/1700000000006-manual.pdf';
  front    constant text := '00000000-0000-4000-8499-0000000000f1/insurance/1700000000001-front.png';
  failures text[] := '{}';
  who      record;
  obj      record;
  exp      text;
  got      text;
  verb     text;
  k        int;
  i_closed boolean;
  row_txt  text;
  t        record;
  looser   boolean;
  tighter  boolean;
  n        int;
  pos      int;
  installed boolean := to_regprocedure('public.document_object_write_is_refused(text)') is not null;
  -- The held 0508 makes tax files a manager's (the owner's decision on
  -- PROD-002); where it is installed a non-manager's every verb on the W-2 is
  -- refused, and a manager's are unchanged.
  tax_is_managers boolean := exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
                                       and p.policyname = 'Tax files are a manager''s');
begin
  -- The other family's parent plants, under RLS and in their OWN family, a
  -- sensitive document row and an insurance row that name this family's file.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000b1', true);
  perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000b1','role','authenticated')::text, true);
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
      values (other, 'Planted', 'identity', manual, true, '00000000-0000-4000-8499-0000000000b1');
    insert into public.insurance_policies (family_id, insurer, front_image_path)
      values (other, 'Planted', manual);
  exception when others then
    failures := array_append(failures, format('CONTROL: the other family''s parent could not plant rows naming this family''s file (%s: %s); the cross-family cells below prove nothing', sqlstate, sqlerrm));
  end;
  perform set_config('role','postgres', true);

  -- r u m o d i: read, replace in place, move away, move another file onto the
  -- path, remove, upload at the path; 1 = allowed, 0 = refused. o and i start
  -- from a missing object whose row still names the path.
  for who in select * from (values
      ('parent',    'a parent',       '00000000-0000-4000-8499-0000000000a1', '111111', '111111', '111111', '111111', '111111', '111111'),
      ('adult',     'an adult',       '00000000-0000-4000-8499-0000000000a2', '111111', '111111', '111111', '111111', '111111', '111111'),
      ('teen',      'a teen',         '00000000-0000-4000-8499-0000000000a3', '100000', '100000', '111111', '111111', '000000', '111111'),
      ('child',     'a child',        '00000000-0000-4000-8499-0000000000a4', '100000', '100000', '111111', '111111', '000000', '111111'),
      ('caregiver', 'a caregiver',    '00000000-0000-4000-8499-0000000000a5', '100000', '100000', '111111', '111111', '000000', '111111'),
      ('guest',     'a guest',        '00000000-0000-4000-8499-0000000000a6', '100000', '100000', '100000', '111111', '000000', '100000'),
      ('outsider',  'another family''s parent', '00000000-0000-4000-8499-0000000000b1', '000000', '000000', '000000', '000000', '000000', '000000')
    ) as w(label, phrase, uid, e_front, e_back, e_warranty, e_w2, e_passport, e_manual) loop

    for obj in select * from (values
        ('front',    '00000000-0000-4000-8499-0000000000f1/insurance/1700000000001-front.png', 'the front of the insurance card a parent saved'),
        ('back',     '00000000-0000-4000-8499-0000000000f1/insurance/1700000000002-back.png',  'the back of the insurance card a parent saved'),
        ('warranty', '00000000-0000-4000-8499-0000000000f1/home/1700000000003-warranty.pdf',   'the bytes behind a household document'),
        ('w2',       '00000000-0000-4000-8499-0000000000f1/tax/2025/1700000000004-w2.pdf',     'a tax file (control: its row is any member''s; a manager''s under 0508)'),
        ('passport', '00000000-0000-4000-8499-0000000000f1/identity/1700000000005-passport.pdf','a sensitive document''s file'),
        ('manual',   '00000000-0000-4000-8499-0000000000f1/home/1700000000006-manual.pdf',     'a household document another family''s rows name'),
        ('passport-braces', '{00000000-0000-4000-8499-0000000000f1}/identity/1700000000007-passport.pdf', 'a sensitive document''s file stored under {family id}'),
        ('front-nohyphen',  '000000000000400084990000000000f1/insurance/1700000000008-front.png',      'an insurance card image stored under the family id without hyphens'),
        ('warranty-upper',  '00000000-0000-4000-8499-0000000000F1/home/1700000000009-warranty.pdf',       'the bytes behind a household document stored under the upper-case family id')
      ) as o(key, path, what) loop

      exp := case obj.key when 'front' then who.e_front when 'back' then who.e_back
                          when 'warranty' then who.e_warranty
                          when 'w2' then case when tax_is_managers and who.label in ('teen', 'child', 'caregiver', 'guest')
                                              then '000000' else who.e_w2 end
                          when 'passport' then who.e_passport
                          when 'passport-braces' then who.e_passport
                          when 'front-nohyphen' then who.e_front
                          when 'warranty-upper' then who.e_warranty
                          else who.e_manual end;

      -- Each verb in its own rolled-back subtransaction. A refusal is either a
      -- filter (0 rows: USING) or 42501 (a WITH CHECK); both count as refused.
      got := '';
      foreach verb in array array['r','u','m','o','d','i'] loop
        k := 0;
        begin
          perform set_config('role','postgres', true);
          -- o and i start from a missing object: the row still names the path.
          if verb in ('o','i') then
            delete from storage.objects where bucket_id = 'documents' and name = obj.path;
          end if;
          if verb = 'o' then
            insert into storage.objects (bucket_id, name, owner) values ('documents', obj.path || '.incoming', who.uid::uuid);
          end if;
          perform set_config('role','authenticated', true);
          perform set_config('request.jwt.claim.sub', who.uid, true);
          perform set_config('request.jwt.claims', json_build_object('sub', who.uid, 'role','authenticated')::text, true);
          begin
            case verb
              when 'r' then
                select count(*) into k from storage.objects where bucket_id = 'documents' and name = obj.path;
              when 'u' then   -- replace in place (update, or upload with upsert)
                update storage.objects set metadata = '{"replaced":true}' where bucket_id = 'documents' and name = obj.path;
                get diagnostics k = row_count;
              when 'm' then   -- move the file away from the path its row names
                update storage.objects set name = obj.path || '.moved' where bucket_id = 'documents' and name = obj.path;
                get diagnostics k = row_count;
              when 'o' then   -- move another file onto that path
                update storage.objects set name = obj.path where bucket_id = 'documents' and name = obj.path || '.incoming';
                get diagnostics k = row_count;
              when 'd' then
                delete from storage.objects where bucket_id = 'documents' and name = obj.path;
                get diagnostics k = row_count;
              when 'i' then   -- upload at the path
                insert into storage.objects (bucket_id, name, owner) values ('documents', obj.path, who.uid::uuid);
                k := 1;
            end case;
          exception when insufficient_privilege then k := 0;
          end;
          raise exception using errcode = 'P0R01';
        exception when sqlstate 'P0R01' then null;
        end;
        got := got || case when k = 1 then '1' else '0' end;
      end loop;
      perform set_config('role','postgres', true);

      if got is distinct from exp then
        looser := false; tighter := false;
        for pos in 1..6 loop
          if substr(got, pos, 1) = '1' and substr(exp, pos, 1) = '0' then looser := true; end if;
          if substr(got, pos, 1) = '0' and substr(exp, pos, 1) = '1' then tighter := true; end if;
        end loop;
        if looser then
          failures := array_append(failures, format('%s changed or reached %s (read/replace/move away/move onto/remove/upload expected %s, got %s)', who.phrase, obj.what, exp, got));
        end if;
        if tighter then
          if obj.key = 'manual' and who.label <> 'outsider' then
            failures := array_append(failures, format('another family''s rows stopped %s of the family using its own file (expected %s, got %s)', who.phrase, exp, got));
          else
            failures := array_append(failures, format('CONTROL: %s lost what its row allows on %s (expected %s, got %s)', who.phrase, obj.what, exp, got));
          end if;
        end if;
      end if;
    end loop;
  end loop;

  -- Malformed: a first folder that is not a uuid fails closed. The object is
  -- added only here, in its own rolled-back subtransaction, so no other cell
  -- above evaluates a policy over it.
  begin
    insert into storage.objects (bucket_id, name, owner)
      values ('documents', 'not-a-family/1700000000010-note.pdf', '00000000-0000-4000-8499-0000000000a1');
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000a1', true);
    perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000a1','role','authenticated')::text, true);
    -- Fail closed means exactly one of two answers: no row, or the policies'
    -- own uuid cast refusing the path (22P02). Any other error is not this
    -- boundary answering, so it fails the probe rather than counting as closed.
    begin
      select count(*)::text into got from storage.objects where bucket_id = 'documents' and name = 'not-a-family/1700000000010-note.pdf';
    exception when others then got := sqlstate || ': ' || sqlerrm;
    end;
    if got not in ('0', '22P02: invalid input syntax for type uuid: "not-a-family"') then
      failures := array_append(failures, format('a parent''s read of an object whose first folder is not a family id was not refused by the path itself (%s)', got));
    end if;
    begin
      insert into storage.objects (bucket_id, name, owner)
        values ('documents', 'not-a-family/1700000000011-new.pdf', '00000000-0000-4000-8499-0000000000a1');
      got := 'landed';
    exception when others then got := sqlstate || ': ' || sqlerrm;
    end;
    if got = 'landed' then
      failures := array_append(failures, 'a parent uploaded under a first folder that is not a family id');
    elsif got not like '42501: %' and got <> '22P02: invalid input syntax for type uuid: "not-a-family"' then
      failures := array_append(failures, format('a parent''s upload under a first folder that is not a family id was not refused by the path or a policy (%s)', got));
    end if;
    perform set_config('role','postgres', true);
    if installed then
      -- Dynamic, so this block also compiles where the helper does not exist.
      execute 'select public.document_object_is_restricted($1)
                  and public.document_object_write_is_refused($1)
                  and public.document_object_is_restricted($2)'
         into i_closed using 'not-a-family/x.pdf', 'no-folder.pdf';
      if not coalesce(i_closed, false) then
        failures := array_append(failures, 'the row helpers do not fail closed on a path whose first folder is not a family id');
      end if;
    end if;
    raise exception using errcode = 'P0R01';
  exception when sqlstate 'P0R01' then null;
  end;
  perform set_config('role','postgres', true);

  -- The family helper agrees with the policies' uuid cast on every spelling,
  -- valid and not, and opens no subtransaction (a plain SQL function).
  if to_regprocedure('public.document_object_family(text)') is not null then
    for t in select * from (values
        ('00000000-0000-4000-8499-0000000000f1'), ('00000000-0000-4000-8499-0000000000F1'),
        ('{00000000-0000-4000-8499-0000000000f1}'), ('000000000000400084990000000000f1'),
        ('{000000000000400084990000000000f1}'), ('0000-0000-0000-4000-8499-0000-0000-00f1'),
        ('{00000000-0000-4000-8499-0000000000f1'), ('00000000-0000-4000-8499-0000000000f1}'),
        (' 00000000-0000-4000-8499-0000000000f1'), ('00000000--0000-4000-8499-0000000000f1'),
        ('00000000-0000-4000-8499-0000000000f1-'), ('not-a-family'), ('')
      ) as v(folder) loop
      begin
        got := (t.folder::uuid)::text;
      exception when invalid_text_representation then got := null;
      end;
      execute 'select public.document_object_family($1)::text' into row_txt using t.folder || '/x.pdf';
      if row_txt is distinct from got then
        failures := array_append(failures, format('the family helper reads folder %L as %s, but the policies'' cast reads it as %s', t.folder, coalesce(row_txt, 'null'), coalesce(got, 'an error')));
      end if;
    end loop;
    if not exists (select 1 from pg_proc f
                    where f.oid = to_regprocedure('public.document_object_family(text)')
                      and f.prolang = (select oid from pg_language where lanname = 'sql')) then
      failures := array_append(failures, 'the family helper is not a plain SQL function, so a storage listing pays a subtransaction per object');
    end if;
  end if;

  if installed then
    -- M1. Without the clause on the delete policy, the child's delete lands.
    begin
      drop policy "Family members can delete their documents" on storage.objects;
      create policy "Family members can delete their documents" on storage.objects
        for delete to authenticated
        using (bucket_id = 'documents'
               and public.is_family_member(((storage.foldername(name))[1])::uuid)
               and not public.document_object_is_restricted(name));
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000a4','role','authenticated')::text, true);
      delete from storage.objects where bucket_id = 'documents' and name = front;
      get diagnostics n = row_count;
      perform set_config('role','postgres', true);
      if n <> 1 then
        failures := array_append(failures, format('MUTATION CONTROL M1: without 0499''s clause the child''s delete of the insurance image still removed %s rows, so the refusal above is not attributed to it', n));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null; end;
    perform set_config('role','postgres', true);

    -- M4. Without the clause in the update policy's USING half, the child moves
    --     the insurance image away from the path its row names. (Its WITH CHECK
    --     half alone refuses a replace in place, not a move to a free path.)
    begin
      drop policy "Family members can update their documents" on storage.objects;
      create policy "Family members can update their documents" on storage.objects
        for update to authenticated
        using (bucket_id = 'documents'
               and public.is_family_member(((storage.foldername(name))[1])::uuid)
               and not public.document_object_is_restricted(name))
        with check (bucket_id = 'documents'
                    and public.is_family_member(((storage.foldername(name))[1])::uuid)
                    and not public.document_object_is_restricted(name)
                    and not public.document_object_write_is_refused(name));
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000a4', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000a4','role','authenticated')::text, true);
      update storage.objects set name = front || '.moved' where bucket_id = 'documents' and name = front;
      get diagnostics n = row_count;
      perform set_config('role','postgres', true);
      if n <> 1 then
        failures := array_append(failures, format('MUTATION CONTROL M4: without 0499''s clause in the update policy''s USING half the child''s move of the insurance image still moved %s rows, so the refusal above is not attributed to it', n));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null; end;
    perform set_config('role','postgres', true);

    -- M2. Without its own-family binding, the planted insurance row blocks the
    --     family's parent.
    begin
      execute replace(pg_get_functiondef('public.document_object_write_is_refused(text)'::regprocedure),
                      'and p.family_id = public.document_object_family(p_object_name)', '');
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000a1', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000a1','role','authenticated')::text, true);
      delete from storage.objects where bucket_id = 'documents' and name = manual;
      get diagnostics n = row_count;
      perform set_config('role','postgres', true);
      if n <> 0 then
        failures := array_append(failures, 'MUTATION CONTROL M2: with the write helper''s own-family binding removed, the planted foreign insurance row still did not block the family''s parent, so this fixture cannot see what the binding prevents');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null; end;
    perform set_config('role','postgres', true);

    -- M3. 0303's restriction (any family's row) hides the family's own file.
    begin
      execute replace(pg_get_functiondef('public.document_object_is_restricted(text)'::regprocedure),
                      'and d.family_id = public.document_object_family(p_object_name)', '');
      perform set_config('role','authenticated', true);
      perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8499-0000000000a1', true);
      perform set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-8499-0000000000a1','role','authenticated')::text, true);
      select count(*) into n from storage.objects where bucket_id = 'documents' and name = manual;
      perform set_config('role','postgres', true);
      if n <> 0 then
        failures := array_append(failures, 'MUTATION CONTROL M3: with 0303''s any-family lookup restored, the planted foreign sensitive row still did not hide the file, so this fixture cannot see what the binding prevents');
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null; end;
    perform set_config('role','postgres', true);
  end if;

  -- Catalog: still exactly four policies on the bucket, every write half
  -- carrying the row rule.
  select count(*) into n
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and (coalesce(p.qual, '') ~ 'bucket_id = ''documents''::text'
          or coalesce(p.with_check, '') ~ 'bucket_id = ''documents''::text');
  if n <> 4 then
    failures := array_append(failures, format('%s storage.objects policies name the documents bucket, not 4', n));
  end if;
  select count(*) into n
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and ((p.cmd = 'INSERT' and coalesce(p.with_check, '') ~ 'bucket_id = ''documents''::text'
           and p.with_check ~ 'NOT document_object_write_is_refused\(name\)'
           and p.with_check ~ 'NOT document_object_is_restricted\(name\)')
       or (p.cmd = 'UPDATE' and coalesce(p.qual, '') ~ 'bucket_id = ''documents''::text'
           and p.qual ~ 'NOT document_object_write_is_refused\(name\)'
           and p.with_check ~ 'NOT document_object_write_is_refused\(name\)')
       or (p.cmd = 'DELETE' and coalesce(p.qual, '') ~ 'bucket_id = ''documents''::text'
           and p.qual ~ 'NOT document_object_write_is_refused\(name\)'));
  if n <> 3 then
    failures := array_append(failures, format('%s of the documents bucket''s 3 write policies carry the row rule', n));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a stored file does not answer to its own family''s rows:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-stored-file-answers-to-its-own-familys-rows: OK (insurance card images: only a parent or adult replaces, moves, removes or re-uploads them, every role still reads them; a household document''s bytes: everyone but the guest writes them; tax files: unchanged, every role; a sensitive file: only a manager reads, writes or uploads at its path; another family''s planted rows neither hid the family''s file nor blocked its parent or child; the same held for files stored under braces, no-hyphen and upper-case family ids, and a non-uuid first folder failed closed; another family''s parent reaches nothing; mutation controls M1-M4 each turned a refusal back; four policies, every write half carrying the rule)';
end $$;

rollback;
