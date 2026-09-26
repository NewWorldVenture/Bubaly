-- Bubaly :: 0350 - a child's chore-proof folder is theirs
--
-- chore-proof objects live at <family>/<member>/<uuid>-<name>
-- (submitProofAction). The bucket's INSERT and DELETE policies checked only
-- family membership on the first segment, so a sibling could delete another
-- child's proof photos before a parent reviewed them, or upload into their
-- folder. Writes now need the second segment to be the caller's own member
-- row, or a family manager (who may submit on a child's behalf). Reads are
-- unchanged: the family reviews proof.
--
-- Pinned by docs/audit/chore-proof-storage-check.sql.

create or replace function public.chore_proof_object_is_writable(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_family uuid;
  v_member uuid;
begin
  begin
    v_family := ((storage.foldername(p_name))[1])::uuid;
    v_member := ((storage.foldername(p_name))[2])::uuid;
  exception when others then
    return false;
  end;
  return public.is_family_member(v_family)
    and (public.can_manage_family(v_family)
         or exists (select 1 from public.family_members m
                     where m.id = v_member and m.family_id = v_family
                       and m.user_id = auth.uid() and m.is_active));
end
$$;
revoke all on function public.chore_proof_object_is_writable(text) from public;
grant execute on function public.chore_proof_object_is_writable(text) to authenticated;

drop policy if exists "Family can upload chore proof" on storage.objects;
create policy "Family can upload chore proof" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chore-proof' and public.chore_proof_object_is_writable(name));

drop policy if exists "Family can delete chore proof" on storage.objects;
create policy "Family can delete chore proof" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chore-proof' and public.chore_proof_object_is_writable(name));
