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
-- THE MECHANISM, AND HOW IT IS ATTRIBUTED
-- ---------------------------------------------------------------------------
-- This boundary is NOT RLS. It is a UNIQUE INDEX, and the governing migration
-- is `0273_approval_requests_pending_once.sql`:
--
--   create unique index if not exists approval_requests_pending_once
--     on public.approval_requests (family_id, dedupe_key)
--     where status = 'pending' and dedupe_key is not null;
--
-- The attribution is MEASURED by the block below, not argued from a reading of
-- the corpus:
--
--   * 1 and 1b do not settle for SQLSTATE 23505. They read the violated
--     constraint's name off the error (GET STACKED DIAGNOSTICS ...
--     CONSTRAINT_NAME) and require `approval_requests_pending_once`. A 23505
--     from any other unique index, or one raised by a trigger or a function
--     (which names no constraint at all), fails them by name.
--   * 5 reads that index back out of pg_index and requires exactly what 0273
--     wrote: unique, valid, on public.approval_requests, keyed on
--     (family_id, dedupe_key) in that order with no expression, and 0273's
--     predicate. An index re-created under the same name with a wider key or
--     another predicate cannot inherit 0273's credit.
--
-- What the corpus says, for the reader. This is corroboration, not the proof:
-- it is the kind of list that goes stale, which is why nothing below depends
-- on it.
--
--   * `grep -rln approval_requests supabase/migrations` names TEN files. 0093
--     creates the table, its first policies and a trigger (below); 0250 only
--     points a foreign key AT it from another table; 0251 adds columns, a
--     CHECK on payload_kind that admits NULL, three NON-unique indexes, and
--     drops and re-creates the policies; 0252 and 0255 re-create the INSERT
--     policy; 0273 is the index; 0304, 0327 and 0329 name it only in comments;
--     0344 adds two triggers (below) and touches no policy.
--   * `approval_requests_pending_once` appears only in 0273, and no migration
--     after 0273 touches `approval_requests.dedupe_key` (the other
--     `dedupe_key` hits in the corpus are other tables'). The only other
--     unique index on the table is its primary key on `id`.
--   * The table carries THREE triggers, all BEFORE UPDATE — none fires on the
--     INSERTs that 1 and 1b make:
--       approval_requests_updated_at          0093:176-184
--       approval_requests_decision_is_earned  0344:332-335
--       approval_requests_rule_is_immutable   0344:364-367
--     The first is attached by dynamic SQL, `EXECUTE format('CREATE TRIGGER
--     %I_updated_at BEFORE UPDATE ON public.%I ...', t, t)` in a loop over an
--     array literal, so the table's name never sits next to the word
--     "trigger" and `grep trigger | grep approval` cannot find it. An earlier
--     revision of this header said "the table carries no trigger at all" on
--     the strength of exactly that grep. Grep `EXECUTE format` too — and ask
--     pg_trigger, which is the only list that cannot be incomplete. A BEFORE
--     INSERT trigger attached the same way tomorrow could raise 23505 in 1;
--     1's constraint-name check is what catches it, not this list.
--     2's UPDATE (status only) passes through all three: set_updated_at
--     stamps updated_at; approval_decision_is_earned returns NEW at once for a
--     session that bypasses RLS (0344 tests rolsuper / rolbypassrls, and the
--     session is measured below); approval_rule_is_immutable compares only
--     approval_model and required_approvals, which 2 leaves alone.
--   * No migration creates a RULE (`grep -rin "create rule\|do instead"` is
--     empty), and none sets FORCE ROW LEVEL SECURITY on anything.
--
-- THE SESSION, MEASURED
-- ---------------------------------------------------------------------------
-- The probe never switches role. The block measures that its session bypasses
-- row-level security (superuser or BYPASSRLS — `postgres` in CI and in the
-- command at the foot of this header) and refuses to run otherwise. For 1 the
-- role is no longer a premise at all — a policy or a grant refuses an INSERT
-- with 42501, never with 23505 naming an index — but 2 marks a row approved
-- with no votes, which 0344's approval_requests_decision_is_earned refuses
-- (42501) for any caller that does not bypass RLS. So it is checked, and the
-- check mirrors the trigger's own test.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusal it gives meaning to
-- ---------------------------------------------------------------------------
-- 1 asserts that the resend raises `unique_violation` and then SWALLOWS it. A
-- swallowed error is an unattributed error. A later partial unique index on
-- (family_id, title) with 0273's own predicate, filed for some unrelated
-- reason, would keep 1-4 green with 0273's index dropped outright if all 1
-- checked were the SQLSTATE: 1 still raises 23505 on the identical title, 2 is
-- still allowed because the row is no longer pending, 3 is still allowed
-- because the family differs, and 4 is still allowed because keyless rows are
-- outside that predicate too. The resend defect would be back in production
-- with a passing probe over it.
--
-- One key is all the boundary is, so the control is the same session, the same
-- table and the same four-column INSERT, twice: TWO pending approvals in one
-- family, same domain, same title, differing in the ONE thing the index keys
-- on — `dedupe_key` — and BOTH must land and both must read back exactly as
-- written. Two different asks in one family are not duplicates of each other,
-- so this is a true statement about this schema, not a convenient one.
--
-- The first of the two is the row 1 then collides with, and it sits INSIDE the
-- control on purpose. Everything the second write holds constant is therefore
-- IDENTICAL to what 1 collides with, so the only difference between the write
-- that must be refused and the write that must land is the indexed key. And a
-- grant, a CHECK or a raising trigger that stops every INSERT on this table is
-- reported as this control failing, with its SQLSTATE, rather than as a bare
-- error from a fixture before any control had run.
--
-- The control names the SAME FOUR COLUMNS as the write under test, which is the
-- INSERT analogue of naming the same columns in an UPDATE. A column-level
-- `revoke insert (dedupe_key) on approval_requests` — or a NOT NULL or a CHECK
-- added to any of the four — kills 1's INSERT before the index ever sees it.
-- The control reddens first, in the same statement shape, and names which of
-- the two sentences failed. A control that dropped `dedupe_key` from its column
-- list would sail straight past that revoke.
--
-- What a failing control catches, stated as the cases:
--
--   * 23505 from the second write — a unique key that EXCLUDES dedupe_key,
--     (family_id, title) say, is refusing writes 0273 permits, so 1's green is
--     measuring a key nobody audited and 0273's index may be gone. The control
--     is blind BY CONSTRUCTION to a key that CONTAINS dedupe_key plus more:
--     (family_id, title, dedupe_key) lets it land and still refuses 1. That
--     case belongs to 1b (vary everything but the key, the resend must STILL
--     be refused) and to 5 (the index is exactly 0273's) — and it is not
--     benign, because 0273 hashes dedupe_key over domain, capability, asker
--     and payload only, so two sends of one intent that render a different
--     title share the key and would both land;
--   * 42501 / 23502 / 23514 / P0001 from either write — a grant, a column
--     privilege, a NOT NULL, a CHECK or a raising trigger makes this INSERT
--     impossible for this session, so 1 cannot reach the index and proves
--     nothing about it;
--   * a row that does not read back as written — a BEFORE INSERT trigger that
--     returns NULL (0 rows, no error) or rewrites NEW (clears dedupe_key,
--     changes status, moving the row outside 0273's predicate) would let the
--     control "land" without the two rows differing only in the key. The
--     table has no INSERT trigger today, so this arm is insurance, not a third
--     of the control's value. The rule case is narrower than it sounds: an
--     INSERT ... RETURNING into a table carrying a DO INSTEAD rule without a
--     RETURNING clause raises 0A000 (the case above), and a rule that
--     redirects the row elsewhere is caught by the read-back.
--
-- 2, 3 and 4 are each a positive case too, and they are kept: 2 varies
-- `status`, 3 varies `family_id`, 4 varies key-presence. None of them varies
-- `dedupe_key` alone, which is why none of them is this control. 3 no longer
-- depends on the seed holding a second family: when it holds only one, 3 files
-- its own, inside this block, and discards it with everything else.
--
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/approval-dedupe-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails.

do $$
declare
  fam uuid;
  other uuid;
  other_src text := 'a seeded family';
  a uuid;
  ctl uuid;
  n int;
  control_ok boolean := false;
  ctl_err text;
  bypass boolean;
  hit text;
  st text;
  idx regclass;
  idx_unique boolean;
  idx_valid boolean;
  idx_ready boolean;
  idx_plain boolean;
  idx_rel regclass;
  idx_cols text[];
  idx_pred text;
begin
  select id into fam from public.families order by created_at limit 1;
  if fam is null then raise exception 'approval dedupe check needs a seeded family'; end if;

  -- The session, measured (see the header). The same test 0344's
  -- approval_decision_is_earned makes before it lets 2's UPDATE through.
  select r.rolsuper or r.rolbypassrls into bypass
    from pg_catalog.pg_roles r where r.rolname = current_user;
  if not coalesce(bypass, false) then
    raise exception 'approval dedupe check must run as a role that bypasses row-level security (superuser or BYPASSRLS — the header documents postgres), and % does not: 2 marks a vote-less row approved, which 0344''s approval_requests_decision_is_earned refuses for any other caller', current_user;
  end if;

  -- ── NEGATIVE CONTROL: two INSERTs one key apart, and BOTH MUST LAND ──────
  -- Mechanism under test: the UNIQUE INDEX `approval_requests_pending_once`
  -- from 0273. Not RLS; and the three triggers this table carries are all
  -- BEFORE UPDATE (see the header), so none of them sees these INSERTs.
  --
  -- Same session, same table, same four columns, same family, same domain, same
  -- title, same pending status. The ONE thing changed between the two is the
  -- value the index keys on. If 1's refusal below comes from that index, both
  -- land. If it comes from a unique constraint over the columns held constant
  -- — one over (family_id, title), say, filed later for an unrelated reason —
  -- the second is refused, and the probe goes red, because 1's attribution was
  -- wrong and 0273's index could be gone without a single check noticing. If
  -- a grant, a column privilege, a NOT NULL, a CHECK or a raising trigger
  -- stands in the way, one of the two is refused, and 1 was never reaching the
  -- index at all.
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1') returning id into a;
    get diagnostics n = row_count;
    if n <> 1 or a is null then
      ctl_err := format('the first INSERT raised nothing but stored %s row(s) and returned id %s', n, coalesce(a::text, 'NULL'));
    else
      insert into public.approval_requests (family_id, domain, title, dedupe_key)
      values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1-control') returning id into ctl;
      get diagnostics n = row_count;
      if n <> 1 or ctl is null then
        ctl_err := format('the second INSERT raised nothing but stored %s row(s) and returned id %s', n, coalesce(ctl::text, 'NULL'));
      else
        -- Read back what was STORED, not what was sent: a BEFORE INSERT
        -- trigger that rewrites NEW would otherwise let the pair differ in
        -- more than the key, or put a row outside 0273's predicate.
        select count(*) into n
          from public.approval_requests r
         where (r.id, r.dedupe_key) in ((a, 'probe-k1'), (ctl, 'probe-k1-control'))
           and r.family_id = fam
           and r.domain = 'tasks'
           and r.title = 'Add task: "Bins"'
           and r.status = 'pending';
        if n <> 2 then
          ctl_err := format('both INSERTs reported a stored row, but %s of the 2 read back as written (this family, domain, title, pending, its own dedupe_key), so something rewrote them on the way in', n);
        else
          control_ok := true;
        end if;
      end if;
    end if;
  exception when others then
    control_ok := false;
    ctl_err := format('%s: %s', sqlstate, sqlerrm);
  end;

  -- A failed control makes 1 unreadable, so the boundary is reported neither as
  -- holding nor as broken: it is reported as UNPROVEN, and the build is red
  -- either way. Say WHY here, while the reason is still in hand.
  if not control_ok then
    raise exception 'approval dedupe boundary UNPROVEN (the control this probe rests on did not hold): two PENDING approvals in one family differing ONLY in dedupe_key did not both land as written in this session (%) — so a refusal in 1 cannot be attributed to approval_requests_pending_once, and 0273''s index may not be what is refusing the resend', ctl_err;
  end if;

  -- The control's second row does not outlive the control. Nothing in 1-5 keys
  -- on 'probe-k1-control', so a survivor would change no assertion; the delete
  -- is checked anyway, so that "1-5 meet exactly the fixture they were written
  -- against" is measured rather than asserted.
  delete from public.approval_requests where id = ctl;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'approval dedupe probe: the control row % was not removed (% row(s) deleted), so 1-5 would not meet the fixture they were written against', ctl, n;
  end if;

  -- 1. The resend. This is the whole point — and it must be refused BY 0273's
  --    index, named, not by whatever else can raise 23505.
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1');
    raise exception 'DEDUPE FAIL: a second PENDING approval was filed for the same ask';
  exception when unique_violation then
    get stacked diagnostics hit = constraint_name;
    if hit is distinct from 'approval_requests_pending_once' then
      raise exception 'DEDUPE FAIL (attribution): the resend was refused with unique_violation, but by %, not approval_requests_pending_once — 0273''s index is not what stops a second pending card', coalesce(nullif(hit, ''), 'no named constraint (a trigger or a function raised 23505)');
    end if;
  end;

  -- 1b. The key is no WIDER than (family_id, dedupe_key). The control above
  --     pins it from one side (vary the key -> must land); this pins it from
  --     the other (vary everything BUT the key -> must STILL be refused).
  --     0273 hashes dedupe_key over domain, capability, asker and payload, so
  --     a resend of one intent can differ from the pending row in its title,
  --     summary, priority, expiry or timestamps and still carry the same key.
  --     Every NOT NULL column the resend held constant is varied here —
  --     except `status`, which 0273's predicate pins to 'pending' — and so are
  --     expires_at and the hashed columns, so a unique key that also contains
  --     ANY of them lets this land and fails the probe.
  begin
    insert into public.approval_requests
      (family_id, dedupe_key, domain, capability, requested_by_kind, agent,
       title, summary, payload, approval_model, required_approvals, approvals,
       priority, plan_step_ids, consequences, expires_at, created_at, updated_at)
    values
      (fam, 'probe-k1', 'probe-other-domain', 'probe-other-capability', 'member', 'probe-agent',
       'Add task: "Bins" (resent, re-rendered)', 'probe: the same ask, rendered differently',
       '{"probe": "a different payload"}'::jsonb, 'two_parent', 2, '[{"probe": true}]'::jsonb,
       'urgent', array[gen_random_uuid()], '["probe"]'::jsonb,
       now() + interval '7 days', now() - interval '1 hour', now() - interval '1 hour');
    raise exception 'DEDUPE FAIL: a resend sharing the pending request''s family and dedupe_key was filed because it differed in columns outside the key (title, domain, priority, ...) — the unique key is wider than (family_id, dedupe_key), so a resend whose rendering changed files a second pending card';
  exception when unique_violation then
    get stacked diagnostics hit = constraint_name;
    if hit is distinct from 'approval_requests_pending_once' then
      raise exception 'DEDUPE FAIL (attribution): a resend differing only outside the key was refused, but by %, not approval_requests_pending_once', coalesce(nullif(hit, ''), 'no named constraint (a trigger or a function raised 23505)');
    end if;
  end;

  -- 2. A decided request is history. Asking again for something already
  --    approved is a NEW request and must be allowed, or a family could never
  --    repeat anything they had once been granted. The flip is read back
  --    first: if it did not happen, the re-ask below would collide with a row
  --    that is still pending and blame the index's predicate for it.
  update public.approval_requests set status = 'approved' where id = a;
  get diagnostics n = row_count;
  select r.status into st from public.approval_requests r where r.id = a;
  if n <> 1 or st is distinct from 'approved' then
    raise exception 'approval dedupe probe: the pending row could not be marked approved (% row(s) updated, status now %), so 2 would be testing a row that is still pending', n, coalesce(st, 'NULL');
  end if;
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (fam, 'tasks', 'Add task: "Bins"', 'probe-k1');
  exception when unique_violation then
    raise exception 'DEDUPE FAIL: the index is not restricted to pending rows, so a family cannot ask again for something already approved';
  end;

  -- 3. Two families are not each other's duplicates. A seeded second family is
  --    used when there is one; otherwise one is filed here and discarded with
  --    the rest of the block, so this check never silently does nothing.
  select id into other from public.families where id <> fam limit 1;
  if other is null then
    insert into public.families (name) values ('approval dedupe probe: another family')
    returning id into other;
    other_src := 'a family this probe filed';
  end if;
  begin
    insert into public.approval_requests (family_id, domain, title, dedupe_key)
    values (other, 'tasks', 'Add task: "Bins"', 'probe-k1');
  exception when unique_violation then
    raise exception 'DEDUPE FAIL: the index is not scoped to a family';
  end;

  -- 4. Every row that existed before 0273 has no key, and a caller that supplies
  --    none must keep exactly the old behaviour rather than colliding with every
  --    other keyless row in the family.
  begin
    insert into public.approval_requests (family_id, domain, title) values (fam, 'tasks', 'probe legacy 1');
    insert into public.approval_requests (family_id, domain, title) values (fam, 'tasks', 'probe legacy 2');
  exception when unique_violation then
    raise exception 'DEDUPE FAIL: keyless rows collide, which would break every approval filed before 0273';
  end;

  -- 5. The index is the one 0273 wrote — the assertion the governing migration
  --    itself makes, read from the catalog rather than from the file. 1 and 1b
  --    prove an index by this NAME refuses a resend; this proves the name has
  --    not been re-used for a different key or a different predicate.
  idx := to_regclass('public.approval_requests_pending_once');
  if idx is null then
    raise exception 'DEDUPE FAIL: public.approval_requests_pending_once does not exist';
  end if;
  select i.indisunique, i.indisvalid, i.indisready, i.indrelid::regclass,
         i.indexprs is null,
         array(select att.attname::text
                 from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                 join pg_catalog.pg_attribute att
                   on att.attrelid = i.indrelid and att.attnum = k.attnum
                order by k.ord),
         pg_get_expr(i.indpred, i.indrelid)
    into idx_unique, idx_valid, idx_ready, idx_rel, idx_plain, idx_cols, idx_pred
    from pg_catalog.pg_index i
   where i.indexrelid = idx;
  if not (coalesce(idx_unique, false) and coalesce(idx_valid, false) and coalesce(idx_ready, false)
          and coalesce(idx_plain, false)
          and idx_rel = 'public.approval_requests'::regclass
          and idx_cols = array['family_id', 'dedupe_key']
          and idx_pred = $p$((status = 'pending'::text) AND (dedupe_key IS NOT NULL))$p$) then
    raise exception 'DEDUPE FAIL: approval_requests_pending_once is not the index 0273 wrote (unique %, valid %, ready %, no expressions %, on %, key %, predicate %)',
      idx_unique, idx_valid, idx_ready, idx_plain, idx_rel, idx_cols, coalesce(idx_pred, 'none');
  end if;

  raise notice '0273 approval dedupe: OK (session % bypasses RLS; control: two pending rows one dedupe_key apart both LANDED and read back as written; resend refused BY approval_requests_pending_once; a resend differing in every column but the key still refused by it; re-ask after approval allowed; family-scoped, against %; keyless rows unaffected; the index is exactly 0273''s key and predicate)', current_user, other_src;
  raise exception 'probe-rollback';
exception when others then
  if sqlerrm = 'probe-rollback' then return; end if;
  raise;
end $$;

-- The block above always raises to discard its fixtures, so nothing it inserted
-- survives for the next probe (or the next run) to trip over.
select '0273 approval dedupe probe: ALL INVARIANTS PASSED' as result;
