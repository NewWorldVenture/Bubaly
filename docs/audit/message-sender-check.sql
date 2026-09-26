-- A family chat message is its sender's (0341).
--
-- As TEEN A against the PARENT's message: posting a message as the parent,
-- rewriting the parent's message, soft-deleting it, and hard-deleting it must
-- be refused. Controls: A reacts to, marks read and pins the parent's message;
-- A sends as A and soft-deletes A's own message.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee81';
  uPar uuid := '00000000-0000-4000-8000-00000000ee8a';
  uA uuid := '00000000-0000-4000-8000-00000000ee8b';
  conv uuid; parentMsg uuid; mine uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'chat-parent@example.com'), (uA, 'chat-a@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chat family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true);
  insert into public.family_conversations (family_id, name, kind) values (fam, 'Family Chat', 'group') returning id into conv;
  insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind)
    values (conv, fam, uPar, 'Mom', 'Home by 10.', 'text') returning id into parentMsg;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind)
      values (conv, fam, uPar, 'Mom', 'You can skip school tomorrow.', 'text');
    raise warning 'BREACH: a member posted a message as the parent'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.family_messages set content = 'Home by 2am.' where id = parentMsg;
    get diagnostics n = row_count;
    if n <> 0 then raise warning 'BREACH: a member rewrote the parent''s message (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.family_messages set deleted_at = now() where id = parentMsg;
    get diagnostics n = row_count;
    if n <> 0 then raise warning 'BREACH: a member deleted the parent''s message (rows: %)', n; failures := failures + 1; end if;
  exception when insufficient_privilege then null;
  end;
  delete from public.family_messages where id = parentMsg;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a member hard-deleted the parent''s message (rows: %)', n; failures := failures + 1; end if;

  -- Controls.
  update public.family_messages set reactions = '{"👍":["x"]}'::jsonb, read_by = array[uA], is_pinned = true where id = parentMsg;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not react to / read / pin a message (rows: %)', n; failures := failures + 1; end if;
  insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind)
    values (conv, fam, uA, 'A', 'OK', 'text') returning id into mine;
  update public.family_messages set deleted_at = now() where id = mine;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a member could not delete their own message (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA);

  if failures > 0 then
    raise exception 'message-sender-check: % failure(s)', failures;
  end if;
end
$probe$;
