-- 0508 — Tax documents are a manager's.
-- Decided by the account holder (PROD-002, tax_documents: "managers only"),
-- recorded on #771 in comment 6101674181.
--
-- tax_documents carries 0077's `FOR ALL to authenticated using
-- (is_family_member(family_id))`, and 0391's step-up guards are written
-- `session_cleared_step_up() or not can_manage_family(family_id)`: they bind
-- only a manager. So a parent must present a second factor to open the Tax
-- Vault, and a child signed in by PIN, a teen, a caregiver or a guest reads,
-- renames and deletes the household's tax documents with none (finalaudit
-- 59319; ROLE-SCOPE-001 measured a guest reading the row). The files follow the
-- rows: the documents bucket reads `is_family_member(<first folder>) and not
-- document_object_is_restricted(name)`, and that helper looks only at
-- `documents`, so every member lists and downloads {family}/tax/<year>/….
--
-- This makes both the rows and the files a manager's:
--
--   1. tax_documents: every permissive policy goes, and four per-command
--      policies take their place, each `can_manage_family(family_id)` (a parent
--      or an adult of the row's family). 0391's RESTRICTIVE step-up guards stay
--      as they are, so a manager still needs the second factor, and now every
--      caller who reaches a row is one.
--   2. storage.objects: one RESTRICTIVE policy, "Tax files are a manager's",
--      for every command, to authenticated. An object of the documents bucket
--      whose path is under its family's tax/ folder (where the Tax Vault
--      uploads), or that a tax_documents row of the object's own family names,
--      is withheld from a caller who does not manage that family: no list, no
--      download, no signed link, no replace, move, delete or upload there.
--      The object's family is its first folder, cast exactly as the bucket's
--      policies cast it (0499's rule), so a spelling of the family id that the
--      cast accepts cannot step around it; a first folder that is not a uuid is
--      left to those policies, whose own cast refuses it. 0303's and 0499's
--      four permissive policies are not touched.
--
-- The Tax Vault page tells a non-manager it is kept by the household's parents
-- and adults instead of rendering an empty vault. The AI insights read goes
-- through the caller's session, so RLS narrows it.
--
-- The service role and session-less writers are untouched (they bypass RLS).
--
-- HELD: 0508, the first number above 0507, requested on #771 in comment
-- 6101674181 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/tax-documents-are-a-managers-check.sql and
-- .github/workflows/tax-documents-runtime.yml. Not applied to production by an
-- agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.tax_documents') is null or to_regclass('storage.objects') is null
     or to_regprocedure('storage.foldername(text)') is null
     or to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0508 needs public.tax_documents, storage.objects, storage.foldername and can_manage_family';
  end if;
end
$$;

-- 1. The rows.
do $$
declare
  p record;
begin
  for p in select polname from pg_policy
            where polrelid = 'public.tax_documents'::regclass and polpermissive loop
    execute format('drop policy %I on public.tax_documents', p.polname);
  end loop;
end
$$;

create policy "Managers read tax_documents" on public.tax_documents
  for select to authenticated using (public.can_manage_family(family_id));
create policy "Managers add tax_documents" on public.tax_documents
  for insert to authenticated with check (public.can_manage_family(family_id));
create policy "Managers change tax_documents" on public.tax_documents
  for update to authenticated
  using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
create policy "Managers remove tax_documents" on public.tax_documents
  for delete to authenticated using (public.can_manage_family(family_id));

-- 2. The files.
create or replace function public.tax_file_is_withheld(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select not public.can_manage_family(s.fam)
           and (lower(coalesce(s.second, '')) = 'tax'
                or exists (select 1 from public.tax_documents t
                            where t.family_id = s.fam and t.storage_path = p_object_name))
      from (select case
                     when f.folder ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
                       then f.folder::uuid
                   end as fam,
                   f.second
              from (select (storage.foldername(p_object_name))[1] as folder,
                           (storage.foldername(p_object_name))[2] as second) f) s
     where s.fam is not null), false);
$$;

comment on function public.tax_file_is_withheld(text) is
  'True when a documents-bucket object is a tax file (under its family''s tax/ folder, or named by a tax_documents row of that family) and the CALLER does not manage that family. The family is the object''s first folder, cast as the bucket''s policies cast it. SECURITY DEFINER so it sees the rows it asks about (0508).';

revoke all on function public.tax_file_is_withheld(text) from public;
revoke all on function public.tax_file_is_withheld(text) from anon;
grant execute on function public.tax_file_is_withheld(text) to authenticated;

drop policy if exists "Tax files are a manager's" on storage.objects;
create policy "Tax files are a manager's" on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'documents' or not public.tax_file_is_withheld(name))
  with check (bucket_id <> 'documents' or not public.tax_file_is_withheld(name));

-- Self-check.
do $$
declare
  n int;
begin
  select count(*) into n from pg_policy
   where polrelid = 'public.tax_documents'::regclass and polpermissive;
  if n <> 4 or exists (select 1 from pg_policies p
                        where p.schemaname = 'public' and p.tablename = 'tax_documents'
                          and p.permissive = 'PERMISSIVE'
                          and (coalesce(p.qual, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
                               or coalesce(p.with_check, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
                               or p.roles <> '{authenticated}'::name[])) then
    raise exception '0508: tax_documents carries % permissive policies, not the four manager-only ones', n;
  end if;
  select count(*) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'tax_documents'
     and p.permissive = 'RESTRICTIVE' and p.policyname like 'tax_documents_step_up_%';
  if n <> 4 then
    raise exception '0508: 0391''s four step-up guards are not all on tax_documents (% found)', n;
  end if;
  if not exists (select 1 from pg_policies p
                  where p.schemaname = 'storage' and p.tablename = 'objects'
                    and p.policyname = 'Tax files are a manager''s'
                    and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL'
                    and p.roles = '{authenticated}'::name[]
                    and p.qual ~ 'tax_file_is_withheld\(name\)'
                    and p.with_check ~ 'tax_file_is_withheld\(name\)') then
    raise exception '0508: storage.objects does not carry the restrictive tax-file policy';
  end if;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.tax_file_is_withheld(text)'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0508: tax_file_is_withheld is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;
