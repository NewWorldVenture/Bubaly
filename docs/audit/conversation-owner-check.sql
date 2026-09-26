-- A family conversation is not any member's to wipe (0342).
--
-- As the CHILD: deleting the parent-created Family Chat (which cascades to
-- its messages), renaming it, and creating a conversation in the parent's
-- name must be refused. Controls: the child creates their own conversation
-- and the messages survive.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ee91';
  uPar uuid := '00000000-0000-4000-8000-00000000ee9a';
  uKid uuid := '00000000-0000-4000-8000-00000000ee9b';
  conv uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'conv-parent@example.com'), (uKid, 'conv-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Conversation family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uKid, 'Kid', 'child', true);
  insert into public.family_conversations (family_id, name, kind, created_by) values (fam, 'Family Chat', 'group', uPar) returning id into conv;
  insert into public.family_messages (conversation_id, family_id, sender_id, content, kind) values (conv, fam, uPar, 'Dinner at 6', 'text');

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.family_conversations where id = conv;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted the Family Chat and its messages (rows: %)', n; failures := failures + 1; end if;
  update public.family_conversations set name = 'Hacked' where id = conv;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child renamed the Family Chat (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.family_conversations (family_id, name, kind, created_by) values (fam, 'From Mom', 'group', uPar);
    raise warning 'BREACH: a child created a conversation in the parent''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  insert into public.family_conversations (family_id, name, kind, created_by) values (fam, 'Kid chat', 'group', uKid);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a child could not start a conversation (rows: %)', n; failures := failures + 1; end if;
  reset role;

  select count(*) into n from public.family_messages where conversation_id = conv;
  if n <> 1 then raise warning 'CONTROL FAILED: the Family Chat lost its messages (%)', n; failures := failures + 1; end if;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'conversation-owner-check: % failure(s)', failures;
  end if;
end
$probe$;
