-- ── The Autopilot queue: open to append, closed to erase (0327) ────────────
--
-- `autopilot_suggestions` (0085_autopilot.sql) carries the same permissive
-- `FOR ALL TO authenticated USING (is_family_member(family_id))` as the tables
-- 0322-0325 narrowed, and the census filed it with them as "gated in-app on
-- isManager, not in RLS". It is not, and this probe exists to hold that line in
-- BOTH directions — because the obvious repair here breaks the product.
--
-- `runAutopilotScan` has two callers. app/api/cron/autopilot-scan/route.ts uses
-- `createServiceClient()`; app/api/autopilot/scan/route.ts uses `createServer()`
-- — the CALLER's own client — behind `resolveFeatureEntitlement(…,
-- '/dashboard/autopilot')`, which is plan-level and carries no role check, as
-- does `requireFeature` on the page itself. components/modules/autopilot-module
-- .tsx runs that scan automatically on open, and the scan THROWS when a write
-- is refused ("Autopilot could not save the suggestion"). Resolution is the
-- same: `resolveAutopilotSuggestionAction` is gated by plan, never by role, and
-- updates the row on the caller's client. So a manager-only INSERT or UPDATE
-- guard would 500 /dashboard/autopilot for every child in a Plus family.
--
-- 0327 therefore closes only what the application never does, and this probe
-- asserts the open half as loudly as the closed one:
--
--   1. a child CAN still insert a suggestion (the scan they trigger by opening
--      the page) and CAN still resolve one as themselves. If either of these
--      fails, the Autopilot page is broken for children and the guard went
--      further than the product allows;
--   2. a child CANNOT delete a suggestion — nothing in app/ or lib/ deletes
--      one; withdrawal is a status change, commented in lib/autopilot/history
--      .ts as "Withdraw without erasing the evidence". Deleting erases what
--      Bubaly proposed and what the household decided, including the
--      `dismissed` rows that are the record of a parent saying no;
--   3. a MANAGER cannot delete one either — this is not a role rule. If the
--      delete guard ever starts admitting managers it has been rewritten into
--      something 0327 did not claim;
--   4. the service role still can, so retention and tooling are unaffected;
--   5. a child CANNOT record that somebody ELSE resolved a suggestion —
--      `resolved_by` is pinned to the writer, the treatment 0320 gave
--      `audit_logs.actor_id`. /dashboard/autopilot and lib/home/completed.ts
--      render resolved rows back to the family as its own decision history;
--   6. a parent cannot sign for the child either — identity, not role;
--   7. reads are untouched;
--   8. `anon` holds no INSERT (0290's argument);
--   9. NEGATIVE CONTROL: drop the new guards, leaving 0085's permissive policy
--      exactly as it was, and require the erasure and the false attribution to
--      succeed again.
--
-- What this probe deliberately does NOT assert is that a child cannot author a
-- `kind='policy'` suggestion. They can, because `runPolicyScan` writes those on
-- the same client when the same child opens the page, and RLS cannot tell the
-- two apart. That leaves AUTHZ-006's mechanism live at the application layer:
-- `acceptPolicySuggestionAction` is manager-gated and believes the row's own
-- `payload` when it writes a `trust_policies` grant. The fix belongs in the
-- application — gate the scan and the resolve action on `isManager`, or
-- re-derive the proposal from `approval_requests` — and 0327's header says so.
-- It is recorded here rather than left as an unexplained gap in the assertions.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a
-- constraint violation is one RLS LET THROUGH; those are reported as breaches.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/autopilot-suggestion-write-check.sql

\set FA '00000000-0000-4000-8000-00000000dd10'
\set UP '00000000-0000-4000-8000-00000000dd11'
\set UK '00000000-0000-4000-8000-00000000dd12'

begin;

insert into auth.users (id, email) values (:'UP','dd-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','dd-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FA','Autopilot House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000dd13',:'FA',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

-- One open offer, and one a parent already said no to.
insert into public.autopilot_suggestions (id, family_id, kind, title, detail, dedupe_key, status)
  values ('00000000-0000-4000-8000-00000000dd14', :'FA', 'reminder', 'Dentist for Mia',
          'Six months since the last visit', 'probe-ap-open', 'open');
insert into public.autopilot_suggestions (id, family_id, kind, title, detail, dedupe_key, status, resolved_by, resolved_at)
  values ('00000000-0000-4000-8000-00000000dd15', :'FA', 'reminder', 'Book a tutor',
          'Two missed homework deadlines', 'probe-ap-dismissed', 'dismissed', :'UP', now());

grant select, insert, update, delete on public.autopilot_suggestions to authenticated;

do $$
declare
  n int;
  who uuid;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000dd10';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000dd11';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000dd12';
  open_s    constant uuid := '00000000-0000-4000-8000-00000000dd14';
  dismissed constant uuid := '00000000-0000-4000-8000-00000000dd15';
  scanned   uuid;
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. The open half. Opening /dashboard/autopilot runs a scan on THIS client.
  begin
    insert into public.autopilot_suggestions (family_id, kind, title, detail, dedupe_key, status, created_by)
      values (fam, 'reminder', 'Renew the car insurance', 'Expires in 12 days', 'probe-ap-scan', 'open', kid_u)
      returning id into scanned;
  exception
    when insufficient_privilege then
      failures := array_append(failures, 'a MEMBER could not insert a suggestion — /api/autopilot/scan runs on the caller''s client and throws, so /dashboard/autopilot is now a 500 for every child in the family');
    when unique_violation then
      failures := array_append(failures, 'the scan-insert fixture hit a unique index — the fixture is wrong, not the boundary');
  end;

  -- Resolving as themselves: the resolve action is plan-gated, never role-gated.
  update public.autopilot_suggestions
     set status = 'dismissed', resolved_at = now(), resolved_by = kid_u
   where id = open_s;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('a MEMBER could not resolve a suggestion as themselves (%s rows) — resolveAutopilotSuggestionAction carries no role check and would now fail for a child', n));
  end if;

  -- 2. Erasure. Nothing in the product deletes a suggestion.
  delete from public.autopilot_suggestions where id = dismissed;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s resolved suggestion(s) — the record of what a parent decided', n)); end if;

  delete from public.autopilot_suggestions where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child emptied the Autopilot queue (%s rows)', n)); end if;

  -- 3. The false attribution: the child dismisses, the parent gets the credit.
  begin
    update public.autopilot_suggestions
       set status = 'dismissed', resolved_at = now(), resolved_by = parent_u
     where id = open_s;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child recorded the PARENT as having resolved %s suggestion(s)', n)); end if;
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.autopilot_suggestions (family_id, kind, title, dedupe_key, status, resolved_by, resolved_at)
      values (fam, 'reminder', 'Parent already handled this', 'probe-ap-forged', 'executed', parent_u, now());
    failures := array_append(failures, 'a child INSERTED a suggestion already marked resolved by the parent');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s forged-resolver INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 4. Reads stay open, deliberately.
  select count(*) into n from public.autopilot_suggestions where family_id = fam;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ the Autopilot queue — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the parent ───────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  -- The positive control: a manager resolves as themselves.
  update public.autopilot_suggestions
     set status = 'executed', resolved_at = now(), resolved_by = parent_u
   where id = open_s;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not resolve a suggestion — the guard refuses everyone'); end if;

  -- Identity, not role: a parent cannot sign for the child either.
  begin
    update public.autopilot_suggestions set resolved_by = kid_u where id = dismissed;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, 'a PARENT attributed a resolution to the child — the pin is a role check, not an identity check'); end if;
  exception when insufficient_privilege then null;
  end;

  -- And a manager cannot delete either. 0327 closes DELETE for every client
  -- role because nothing in the product deletes, not because of who is asking.
  delete from public.autopilot_suggestions where id = dismissed;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a MANAGER deleted %s suggestion(s) — 0327''s delete guard has been rewritten into a role rule it never claimed', n)); end if;

  -- 5. The service role keeps its retention/tooling reach (BYPASSRLS).
  perform set_config('role','postgres', true);
  set local role service_role;
  delete from public.autopilot_suggestions where id = dismissed;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'the SERVICE role could not delete a suggestion — retention and tooling are broken'); end if;
  reset role;
  perform set_config('role','postgres', true);

  -- 6. The grant layer, which `to authenticated` guards cannot reach.
  if has_table_privilege('anon', 'public.autopilot_suggestions', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on autopilot_suggestions — the 0327 guards are `to authenticated` and would not apply');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop only the new restrictive guards. 0085's permissive "Members manage …"
  -- policy is left exactly as it was, which is the pre-0327 state.
  drop policy if exists autopilot_suggestions_no_client_delete_guard on public.autopilot_suggestions;
  drop policy if exists autopilot_suggestions_resolver_guard on public.autopilot_suggestions;
  drop policy if exists autopilot_suggestions_resolver_update_guard on public.autopilot_suggestions;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.autopilot_suggestions set resolved_by = parent_u, status = 'dismissed' where id = open_s;
  get diagnostics n = row_count;
  perform set_config('role','postgres', true);
  select resolved_by into who from public.autopilot_suggestions where id = open_s;
  if n = 0 or who is distinct from parent_u then
    failures := array_append(failures, 'with 0085''s policy alone the child STILL could not name the parent as resolver — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','authenticated', true);
  delete from public.autopilot_suggestions where id = open_s;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0085''s policy alone the child STILL could not erase a suggestion — this probe has never been shown to fail');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'the Autopilot queue is not held the way 0327 claims:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'autopilot-suggestion-write: OK (a member still appends and resolves as themselves, nobody signs for anyone else, no client role erases a row, the service role still can, anon holds no INSERT, negative control reproduced both escalations)';
end $$;

rollback;
