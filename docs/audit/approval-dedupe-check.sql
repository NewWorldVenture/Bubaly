-- ── One pending approval per request ────────────────────────────────────────
-- `openApprovalRequest` was an unguarded INSERT, so a resent chat message — a
-- flaky connection mid-answer, a double-tapped send, a reloaded tab, Bubaly's
-- own retry — filed TWO pending approvals for one intent. A parent sees two
-- cards that look like the same thing they wanted, approves both, and the
-- resource is written twice. That is where a gated family's duplicate actually
-- comes from: the tool ledger's idempotency reservation cannot help, because
-- `executeTool` returns `pending_approval` BEFORE it reserves.
--
-- The application computes `dedupe_key` and checks before inserting, but that
-- check is a lookup, and a lookup loses a race. `0273`'s partial unique index is
-- what makes it correct. This proves the index, not the lookup — the unit tests
-- drive the application against a fake, and a fake cannot tell you whether the
-- real index exists or whether its predicate is right.
--
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/approval-dedupe-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

do $$
declare
  fam uuid;
  other uuid;
  a uuid;
begin
  select id into fam from public.families order by created_at limit 1;
  if fam is null then raise exception 'approval dedupe check needs a seeded family'; end if;

  insert into public.approval_requests (family_id, domain, title, dedupe_key)
  values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1') returning id into a;

  -- 1. The resend. This is the whole point.
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1');
    raise exception 'DEDUPE FAIL: a second PENDING approval was filed for the same ask';
  exception when unique_violation then null;
  end;

  -- 2. A decided request is history. Asking again for something already
  --    approved is a NEW request and must be allowed, or a family could never
  --    repeat anything they had once been granted.
  update public.approval_requests set status = 'approved' where id = a;
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1');
  exception when unique_violation then
    raise exception 'DEDUPE FAIL: the index is not restricted to pending rows, so a family cannot ask again for something already approved';
  end;

  -- 3. Two families are not each other's duplicates.
  select id into other from public.families where id <> fam limit 1;
  if other is not null then
    begin
      insert into public.approval_requests (family_id, domain, title, dedupe_key)
      values (other, 'tasks', 'Add task: "Bins"', 'probe-k1');
    exception when unique_violation then
      raise exception 'DEDUPE FAIL: the index is not scoped to a family';
    end;
  end if;

  -- 4. Every row that existed before 0273 has no key, and a caller that supplies
  --    none must keep exactly the old behaviour rather than colliding with every
  --    other keyless row in the family.
  begin
    insert into public.approval_requests (family_id, domain, title) values (fam, 'tasks', 'probe legacy 1');
    insert into public.approval_requests (family_id, domain, title) values (fam, 'tasks', 'probe legacy 2');
  exception when unique_violation then
    raise exception 'DEDUPE FAIL: keyless rows collide, which would break every approval filed before 0273';
  end;

  raise notice '0273 approval dedupe: OK (resend refused, re-ask after approval allowed, family-scoped, keyless rows unaffected)';
  raise exception 'probe-rollback';
exception when others then
  if sqlerrm = 'probe-rollback' then return; end if;
  raise;
end $$;

-- The block above always raises to discard its fixtures, so nothing it inserted
-- survives for the next probe (or the next run) to trip over.
select '0273 approval dedupe probe: ALL INVARIANTS PASSED' as result;
