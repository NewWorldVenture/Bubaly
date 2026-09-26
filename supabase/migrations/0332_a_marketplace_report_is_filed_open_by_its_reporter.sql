-- Bubaly :: 0332 - a marketplace report is filed open, in the reporter's name
--
-- marketplace_reports feeds the platform Trust & Safety queue; the super-admin
-- moderates it (service role) and a report's verdict lives in status,
-- resolution, reviewed_by and reviewed_at. The member INSERT policy checked
-- only is_family_member(family_id), so a member could file a report in another
-- member's name (reporter_member is any id), or file it already 'dismissed'
-- with a resolution and reviewer, so it never reaches the open queue.
-- reportListingAction writes none of the verdict columns and names the
-- caller's own member row. INSERT now requires exactly that. Members have no
-- UPDATE/DELETE policy (unchanged).
--
-- Pinned by docs/audit/marketplace-report-check.sql.

do $$
begin
  if to_regclass('public.marketplace_reports') is null then
    return;
  end if;
  drop policy if exists mkt_reports_insert on public.marketplace_reports;
  create policy mkt_reports_insert on public.marketplace_reports
    for insert to authenticated
    with check (
      public.is_family_member(family_id)
      and reporter_member is not null
      and public.is_self_member(reporter_member)
      and status = 'open'
      and resolution is null
      and reviewed_by is null
      and reviewed_at is null
    );
end
$$;
