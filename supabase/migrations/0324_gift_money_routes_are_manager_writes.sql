-- Bubaly :: 0324 - where gift money goes is decided by the family's managers
--
-- Three tables route money from relatives into a child's wallet, and each kept
-- a "Members manage …" FOR ALL policy while every ledger table is manager-write:
--
--   gift_payments  pending gifts from a public gift link. A parent approves one
--                  with wallet_approve_gift (SECURITY DEFINER, manager-gated),
--                  which credits the row's child_wallet_id with its
--                  amount_cents — as stored. So a child could repoint a pending
--                  gift from Grandma at their own wallet, raise its amount, or
--                  insert a pledge that never happened, and the parent's
--                  approval would credit real ledger money.
--   gift_links     the public tokens relatives pay through, each bound to a
--                  child's wallet.
--   pay_handles    public Pay-IDs, each bound to a child's wallet: a child could
--                  repoint a sibling's Pay-ID at themselves.
--
-- Every application writer is either the service role (the public gift action
-- and pages) or a server action that checks isManager (claim/release a Pay-ID,
-- create a gift link, dismiss a gift), and approval is the RPC. So members keep
-- SELECT and managers keep INSERT, UPDATE and DELETE.
--
-- Pinned by docs/audit/gift-money-route-check.sql.

do $$
declare
  t text;
begin
  foreach t in array array['gift_payments', 'gift_links', 'pay_handles'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', 'Members manage ' || t, t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_family_member(family_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_family(family_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_family(family_id))', t || '_delete', t);
  end loop;
end
$$;
