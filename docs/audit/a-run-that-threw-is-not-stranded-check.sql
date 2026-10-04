-- Behavioural proof for the shape `releaseRun` (lib/ai/runs/store.ts) must
-- leave behind when a slice throws, against the real `claim_ai_runs` (0263).
--
-- The recovery pass at the top of claim_ai_runs returns an `executing` run to
-- `ready` — or, once `attempt` has reached `max_attempts`, dead-letters it —
-- ONLY while `lease_expires_at is not null and lease_expires_at < now()`; the
-- candidate query then takes only `ready` and `scheduled_followup`. So an
-- `executing` run whose lease has been CLEARED belongs to nobody and is never
-- looked at again. releaseRun used to do exactly that after a throw, and both
-- call sites said the recovery pass would retry the run. It could not.
--
-- Three rows, one call. Wrapped in a transaction that is rolled back, so the
-- claim it performs leaves no seeded run `executing` behind.
begin;
do $$
declare
  fam      uuid;
  trapped  uuid;
  released uuid;
  spent    uuid;
  claimed  uuid[];
  r        public.family_automation_runs%rowtype;
  n        int;
begin
  delete from public.families where name = 'Stranded-run probe';
  insert into public.families (name) values ('Stranded-run probe') returning id into fam;

  -- 1. The trap: executing, no lease. What releaseRun used to leave behind.
  insert into public.family_automation_runs (family_id, state, status, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, 'executing', 'approved', 1, 5, now() - interval '1 minute', null, null) returning id into trapped;
  -- 2. What it leaves behind now, once its shortened lease has run out: our lease, in the past.
  insert into public.family_automation_runs (family_id, state, status, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, 'executing', 'approved', 1, 5, now() - interval '1 minute', gen_random_uuid(), now() - interval '1 second') returning id into released;
  -- 3. The same, with its attempts spent.
  insert into public.family_automation_runs (family_id, state, status, attempt, max_attempts, run_after, lease_owner, lease_expires_at)
    values (fam, 'executing', 'approved', 5, 5, now() - interval '1 minute', gen_random_uuid(), now() - interval '1 second') returning id into spent;

  select coalesce(array_agg(c.id), '{}') into claimed from public.claim_ai_runs(50, 120) as c(id);

  -- 1. Never looked at: not recovered, not claimed, exactly as it was.
  select * into r from public.family_automation_runs where id = trapped;
  if trapped = any(claimed) then raise exception 'a lease-less executing run was claimed; the TS rule that releaseRun must not clear the lease has lost its reason'; end if;
  if r.state <> 'executing' or r.lease_owner is not null or r.lease_expires_at is not null or r.attempt <> 1 then
    raise exception 'a lease-less executing run was touched by the recovery pass (state %, attempt %)', r.state, r.attempt;
  end if;

  -- 2. Recovered and re-claimed in the same call: a new worker, a new lease, one more attempt.
  select * into r from public.family_automation_runs where id = released;
  if not (released = any(claimed)) then raise exception 'a run whose lease ran out was not picked up again'; end if;
  if r.state <> 'executing' or r.attempt <> 2 or r.lease_owner is null or r.lease_expires_at is null or r.lease_expires_at <= now() then
    raise exception 'the recovered run is not held by a new worker (state %, attempt %, lease until %)', r.state, r.attempt, r.lease_expires_at;
  end if;

  -- 3. Dead-lettered, not retried for ever: failed, said why, stamped, and on the timeline.
  select * into r from public.family_automation_runs where id = spent;
  if spent = any(claimed) then raise exception 'a run with no attempts left was claimed again'; end if;
  if r.state <> 'failed' or r.status <> 'failed' or r.completed_at is null or r.lease_owner is not null
     or r.error <> 'Run abandoned after the maximum number of attempts.' then
    raise exception 'a run with no attempts left was not dead-lettered (state %, error %)', r.state, r.error;
  end if;
  select count(*) into n from public.ai_run_events where run_id = spent and event_type = 'run_failed';
  if n <> 1 then raise exception 'the dead-lettered run has % run_failed events on its timeline, not one', n; end if;

  raise notice 'OK  a run whose lease ran out is recovered or dead-lettered; one with no lease is never looked at';
end $$;
rollback;
