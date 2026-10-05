-- A read receipt, and a reaction, are the reader's own. (DB-RPC-M02, 0463)
--
-- 0367 leaves `read_by`, `reactions` and `is_pinned` open to every member of
-- the family, because other members legitimately change them. The product only
-- ever changes the CALLER's own entry. Before 0463 a child could, in one
-- update, erase Dad's read receipt and Dad's 👍 from Mom's message, mark it
-- read for someone who never opened it, and react in someone else's name; and
-- a sender could post a message already "read" by everyone.
--
-- Refused, as the child: removing another reader, adding another reader,
-- removing another's reaction, adding a reaction in another's name, a
-- malformed reactions value, and (as the sender) an insert pre-read by others.
-- Controls: the child marks it read through mark_conversation_read (the real
-- path), toggles their own reaction on and off, and pins it; the sender posts
-- a message read by themselves; the service role is untouched.
--
-- Rolled back: nothing here outlives the assertion.
\set ON_ERROR_STOP on
set client_min_messages = warning;

begin;

do $probe$
declare
  mom  uuid := '00000000-0000-4000-8000-0000000d6301';
  kid  uuid := '00000000-0000-4000-8000-0000000d6302';
  dad  uuid := '00000000-0000-4000-8000-0000000d6303';
  fam  uuid := '00000000-0000-4000-8000-0000000d6311';
  conv uuid;
  msg  uuid;
  other uuid;
  rb   uuid[];
  rx   jsonb;
  pin  boolean;
  refused boolean;
  failures int := 0;
begin
  insert into auth.users (id, email) values
    (mom, 'receipt-mom@example.test'), (kid, 'receipt-kid@example.test'), (dad, 'receipt-dad@example.test')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Receipts', mom) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, mom, 'Mom', 'parent', true), (fam, kid, 'Kid', 'child', true), (fam, dad, 'Dad', 'parent', true)
  on conflict (family_id, user_id) do update set is_active = true;
  insert into public.family_conversations (family_id, name, kind, member_ids)
    values (fam, 'Family', 'group', array[mom, kid, dad]) returning id into conv;
  -- Seeded by the server (no session), as a message Mom and Dad have read and Dad has 👍'd.
  insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, read_by, reactions)
    values (conv, fam, mom, 'Mom', 'Home by 10.', 'text', array[mom, dad],
            jsonb_build_object('👍', jsonb_build_array(dad::text)))
    returning id into msg;

  perform set_config('request.jwt.claim.sub', kid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', kid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ── refused ─────────────────────────────────────────────────────────────
  refused := false;
  begin
    update public.family_messages set read_by = array[mom] where id = msg;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise warning 'BREACH: a child erased Dad''s read receipt'; failures := failures + 1; end if;

  refused := false;
  begin
    update public.family_messages set read_by = array[mom, dad, kid, '00000000-0000-4000-8000-0000000d6304'::uuid] where id = msg;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise warning 'BREACH: a child marked the message read for someone else'; failures := failures + 1; end if;

  refused := false;
  begin
    update public.family_messages set reactions = '{}'::jsonb where id = msg;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise warning 'BREACH: a child erased Dad''s reaction'; failures := failures + 1; end if;

  refused := false;
  begin
    update public.family_messages
       set reactions = jsonb_build_object('👍', jsonb_build_array(dad::text), '😡', jsonb_build_array(mom::text))
     where id = msg;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise warning 'BREACH: a child reacted in Mom''s name'; failures := failures + 1; end if;

  refused := false;
  begin
    update public.family_messages set reactions = jsonb_build_object('👍', 'everyone') where id = msg;
  exception when invalid_parameter_value then refused := true;
  end;
  if not refused then raise warning 'BREACH: a malformed reactions value replaced Dad''s reaction'; failures := failures + 1; end if;

  -- ── the child's own entries still work ──────────────────────────────────
  perform public.mark_conversation_read(conv);
  select read_by into rb from public.family_messages where id = msg;
  if not (rb @> array[mom, dad, kid]) then
    raise warning 'REGRESSION: mark_conversation_read no longer adds the reader (read_by = %)', rb;
    failures := failures + 1;
  end if;

  begin
    update public.family_messages
       set reactions = jsonb_build_object('👍', jsonb_build_array(dad::text, kid::text))
     where id = msg;
    update public.family_messages
       set reactions = jsonb_build_object('👍', jsonb_build_array(dad::text), '❤️', jsonb_build_array(kid::text))
     where id = msg;
    update public.family_messages set is_pinned = true where id = msg;
  exception when insufficient_privilege or invalid_parameter_value then
    raise warning 'REGRESSION: a child can no longer react to or pin a message (%)', sqlerrm;
    failures := failures + 1;
  end;

  reset role;
  select read_by, reactions, is_pinned into rb, rx, pin from public.family_messages where id = msg;
  if not (rb @> array[mom, dad]) or rx -> '👍' is distinct from jsonb_build_array(dad::text) or not pin then
    raise warning 'BREACH or REGRESSION: after the child, read_by=% reactions=% pinned=%', rb, rx, pin;
    failures := failures + 1;
  end if;

  -- ── the sender: may not post a message pre-read by others ────────────────
  perform set_config('request.jwt.claim.sub', mom::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', mom::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  refused := false;
  begin
    insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, read_by)
      values (conv, fam, mom, 'Mom', 'Already read by everyone', 'text', array[mom, dad, kid]);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise warning 'BREACH: a sender posted a message already read by others'; failures := failures + 1; end if;

  begin
    insert into public.family_messages (conversation_id, family_id, sender_id, sender_name, content, kind, read_by)
      values (conv, fam, mom, 'Mom', 'Read by me', 'text', array[mom]) returning id into other;
  exception when insufficient_privilege then
    raise warning 'REGRESSION: a sender can no longer post a message (%)', sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  -- ── the service role is unaffected ──────────────────────────────────────
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    update public.family_messages set read_by = '{}', reactions = '{}' where id = msg;
  exception when insufficient_privilege then
    raise warning 'REGRESSION: the server can no longer rewrite receipts (%)', sqlerrm;
    failures := failures + 1;
  end;

  if failures > 0 then
    raise exception 'a read receipt or reaction is not its reader''s own: % finding(s)', failures;
  end if;
  raise notice 'OK: a member cannot add or remove another member''s read receipt or reaction, or post a message pre-read by others; the reader still marks read, reacts, unreacts and pins, and the server is untouched.';
end
$probe$;

rollback;
