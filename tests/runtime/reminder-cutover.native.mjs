import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { TABLES, MIGRATIONS, literal, sha } from '../../scripts/run-reminder-cutover-rehearsal.mjs';

// This ordered native rehearsal deliberately has no missing-service skip path.
// Every request uses a synthetic identity against the driver's owned loopback relay.
// Minimal prerequisite tables are witnesses for DDL/hold effects, not a production clone.
const NAMES = [
  'declared predecessor lacks every selected prerequisite and uses actual application logins',
  'all declared relations admit healthy ordinary service writes before a hold',
  'three-table and twelve-table negative controls demonstrably leave required relations writable',
  'failed exclusive-lock acquisition leaves no partial hold',
  'an in-flight real application transaction blocks installation until it commits',
  'a prepared old session and spoofed settings cannot write after installation',
  'complete hold blocks all four statement operations and real HTTP writes',
  'ordinary callers cannot become the maintenance session or edit the barrier',
  'full 0256 commits every table effect under the hold',
  'a failed full 0272 transaction rolls back its own effects while 0256 stays committed',
  'full 0272 and 0327 install their real policy contracts',
  'full 0486 backfills the real source audience under the hold',
  '0487 commits its exact raw transaction and a lost acknowledgement requires reconciliation',
  'new definer writers remain blocked through the real service and ordinary API logins',
  'a failed removal leaves the complete hold intact',
  'removing the synthetic hold removes precisely its trigger and private-schema footprint',
  'the actual old reminder-first wire sequence strands an OPEN card after the schema changes',
  'the reinstalled barrier prevents the old split writer from saving another stranded card',
  'a committed parent with no next receipt keeps the reconciliation gate closed',
  'maintenance reconciliation uses the real writer and preserves exact one-copy receipts',
  'post-removal native acceptance preserves named, unnamed and foreign-family boundaries',
  'ordinary recurrence retry creates one trusted next occurrence',
  'full migration reapplication preserves trusted identities and complete schema effects',
];
const expectOk = response => {
  assert(response.status >= 200 && response.status < 300, 'Expected healthy native HTTP response: ' + response.status + ' ' + (response.data?.code ?? ''));
  return response.data;
};
const expectHold = response => {
  assert.equal(response.status, 403);
  assert.equal(response.data?.code, '42501');
  assert.equal(response.data?.message, 'Synthetic cutover write hold');
};
const holdSqlFailure = result => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERROR:\s+42501:\s+Synthetic cutover write hold/);
};
const field = table => table === 'family_members' ? 'display_name' : table === 'families' ? 'name' : table === 'family_insurance_policies' ? 'insurer' : 'title';

export async function rehearse(r, report) {
  report.cases = NAMES.map(name => ({ name, status: 'not-executed' }));
  report.expectedCases = NAMES.length;
  let caseIndex = 0;
  async function check(name, fn) {
    assert.equal(NAMES[caseIndex], name);
    const entry = report.cases[caseIndex++];
    entry.status = 'running';
    try { entry.evidence = await fn(); entry.status = 'passed'; }
    catch (error) { entry.status = 'failed'; throw error; }
  }
  const id = () => crypto.randomUUID();
  const family = id(), foreign = id();
  const users = Object.fromEntries(['parent', 'teen', 'unnamed', 'foreign', 'inactive'].map(name => [name, id()]));
  const members = Object.fromEntries(Object.keys(users).map(name => [name, id()]));
  const policies = { named: id(), hidden: id(), foreign: id() };
  const rows = Object.fromEntries(TABLES.map(table => [table, id()]));
  rows.family_members = members.parent;
  if (TABLES.includes('families')) rows.families = family;
  if (TABLES.includes('family_insurance_policies')) rows.family_insurance_policies = policies.named;
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  r.users = users;
  const app = (actor, route, method, body) => r.request(actor === 'service' ? 'service_role' : actor === 'anon' ? 'anon' : 'authenticated', users[actor], route, method, body);
  const cardDraft = key => ({
    family_id: family, member_id: members.teen, kind: 'insurance', title: 'Synthetic cutover renewal',
    detail: 'Synthetic cutover detail', confidence: 95, urgency: 1, status: 'open', action_type: 'create_reminder',
    action_label: 'Renew', payload: { title: 'Synthetic cutover renewal' },
    source_kind: 'family_insurance_policies', source_id: policies.named, dedupe_key: key,
    expires_at: future, resolved_at: null, resolved_by: null, created_by: users.parent,
  });
  const patch = table => app('service', '/' + table + '?id=eq.' + rows[table], 'PATCH', { [field(table)]: 'Synthetic ' + id() });
  const triggers = () => r.json("select coalesce(json_agg(x order by x.relname),'[]') from(select c.relname,t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='cutover_statement_hold' and not t.tgisinternal)x;");
  const assertCompleteHold = () => {
    const actual = triggers();
    assert.deepEqual(actual.map(row => row.relname), [...TABLES].sort());
    assert(actual.every(row => row.tgenabled === 'A'));
    assert.deepEqual(r.json('select to_json(tables) from cutover_hold.identity;'), TABLES);
  };
  const prepareHold = () => r.sql(r.fixture('reminder-cutover-hold.sql'), { singleTransaction: true });
  const installHold = () => { r.sql("select cutover_hold.install('complete');"); assertCompleteHold(); };
  const removeHold = () => {
    r.sql('begin; select cutover_hold.remove(); drop schema cutover_hold cascade; commit;');
    assert.deepEqual(triggers(), []);
    assert.equal(r.json("select to_json(to_regnamespace('cutover_hold') is null);"), true);
  };
  async function transaction(login, sql) {
    const session = r.session(login);
    session.child.stdin.write(sql + "\nselect 'READY:'||pg_backend_pid();\n");
    await r.wait(() => session.stdout.includes('READY:'), 'Owned transaction did not become ready');
    const pid = Number(/READY:(\d+)/.exec(session.stdout)?.[1]);
    assert(pid > 0);
    return { session, pid };
  }
  async function finish(session, command = 'rollback;') {
    if (!session.closed) session.child.stdin.end(command + '\n\\q\n');
    await session.done;
  }
  const blockersOf = pid => r.json(`select coalesce(json_agg(x),'[]') from(select pid,usename,pg_blocking_pids(pid) blockers from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)))x;`);
  const stage = index => {
    assert(index !== 4, '0487 must retain its own transaction');
    const text = r.migration(index);
    const result = r.sql(text, { singleTransaction: true });
    assert.equal(result.status, 0);
    return { file: MIGRATIONS[index][0], rawSha256: sha(text), wrapper: 'psql --single-transaction', observedExit: 0 };
  };
  const currentCard = cardId => r.json(`select row_to_json(c) from public.autopilot_suggestions c where id=${literal(cardId)};`);
  const familyCreateArgs = card => ({
    p_card_id: card.id, p_expected_updated_at: card.updated_at, p_at: future,
    p_source_tag: 'autopilot-source:' + sha(JSON.stringify({ synthetic: card.id })),
  });
  const actualReceipt = cardId => r.json(`select json_build_object(
    'card',(select count(*) from public.autopilot_suggestions where id=${literal(cardId)}),
    'family',(select count(*) from public.family_reminders where autopilot_origin and autopilot_card_id=${literal(cardId)}),
    'legacy',(select count(*) from public.reminders where autopilot_origin and autopilot_card_id=${literal(cardId)}));`);
  const needsReconciliation = cardId => { const observed = actualReceipt(cardId); return observed.card !== 1 || observed.family + observed.legacy !== 1; };

  await check(NAMES[0], async () => {
    assert.equal(r.json("select to_json(to_regprocedure('public.is_self_member(uuid)') is null);"), true);
    assert.equal(r.json("select to_json(not exists(select 1 from information_schema.columns where table_schema='public' and column_name in('idempotency_key','autopilot_origin','autopilot_card_id','fingerprint','receipt_document_id')));"), true);
    r.sql(`insert into auth.users(id,email) values ${Object.entries(users).map(([name, uid]) => `(${literal(uid)},${literal(name + '@synthetic.invalid')})`).join(',')};
      insert into public.families(id,name) values(${literal(family)},'Synthetic family'),(${literal(foreign)},'Synthetic other family');
      insert into public.family_members(id,family_id,user_id,role,display_name,is_active) values ${Object.entries(users).map(([name, uid]) => `(${literal(members[name])},${literal(name === 'foreign' ? foreign : family)},${literal(uid)},${literal(name === 'parent' || name === 'foreign' ? 'parent' : 'teen')},${literal('Synthetic ' + name)},${name !== 'inactive'})`).join(',')};
      insert into public.family_insurance_policies(id,family_id,member_id,insurer) values
       (${literal(policies.named)},${literal(family)},${literal(members.teen)},'Synthetic named'),
       (${literal(policies.hidden)},${literal(family)},${literal(members.parent)},'Synthetic hidden'),
       (${literal(policies.foreign)},${literal(foreign)},${literal(members.foreign)},'Synthetic foreign');
      insert into public.autopilot_suggestions(id,family_id,member_id,kind,title,source_kind,source_id,action_type,dedupe_key)
       values(${literal(rows.autopilot_suggestions)},${literal(family)},null,'insurance','Synthetic historical card','family_insurance_policies',${literal(policies.named)},'create_reminder','synthetic-before-cutover');
      insert into public.family_reminders(id,family_id,title,created_by) values(${literal(rows.family_reminders)},${literal(family)},'Synthetic manual',${literal(users.parent)});
      insert into public.reminders(id,family_id,title,remind_at,related_type,related_id) values(${literal(rows.reminders)},${literal(family)},'Synthetic historical legacy',${literal(future)},'renewal',${literal(policies.named)});
      ${['documents', 'calendar_events', 'todo_items', 'chore_assignments', 'meal_plans', 'grocery_items', 'transactions'].map(table => `insert into public.${table}(id,family_id,title) values(${literal(rows[table])},${literal(family)},'Synthetic witness');`).join('\n')}
      insert into public.event_rsvps(id,family_id,member_id,event_id,title) values(${literal(rows.event_rsvps)},${literal(family)},${literal(members.teen)},${literal(rows.calendar_events)},'Synthetic RSVP');
      create function public.cutover_session_identity() returns json language sql security invoker set search_path=pg_catalog,public as $body$
       select json_build_object('session',session_user,'current',current_user,'actor',auth.uid(),'super',(select rolsuper from pg_roles where rolname=session_user),'bypass',(select rolbypassrls from pg_roles where rolname=session_user))
      $body$;
      revoke all on function public.cutover_session_identity() from public,anon;
      grant execute on function public.cutover_session_identity() to authenticated,service_role;`);
    r.sql("notify pgrst,'reload schema';");
    await r.wait(async () => (await app('parent', '/rpc/cutover_session_identity', 'POST', {})).status === 200, 'Identity routine schema refresh');
    const ordinary = expectOk(await app('parent', '/rpc/cutover_session_identity', 'POST', {}));
    const service = expectOk(await app('service', '/rpc/cutover_session_identity', 'POST', {}));
    assert.deepEqual(ordinary, { session: 'authenticator', current: 'authenticated', actor: users.parent, super: false, bypass: false });
    assert.equal(service.session, 'authenticator'); assert.equal(service.current, 'service_role'); assert.equal(service.super, false);
    assert.equal(r.json("select to_json(pg_has_role('authenticator','cutover_maint','MEMBER'));"), false);
    return { actualOrdinarySession: ordinary.session, actualServiceSession: service.session, maintenance: 'cutover_maint', initialPrerequisitesAbsent: true };
  });
  await check(NAMES[1], async () => {
    for (const table of TABLES) {
      const result = expectOk(await patch(table)); assert.equal(result.length, 1); assert.equal(result[0].id, rows[table]);
    }
    return { healthyRealRowWrites: TABLES };
  });
  await check(NAMES[2], async () => {
    prepareHold(); r.sql("select cutover_hold.install('three-table-negative-control');");
    const core = new Set(['autopilot_suggestions', 'family_reminders', 'reminders']);
    const refused = [], admitted = [];
    for (const table of TABLES) {
      const result = await patch(table);
      if (core.has(table)) { expectHold(result); refused.push(table); }
      else { assert.equal(expectOk(result).length, 1); admitted.push(table); }
    }
    assert.equal(refused.length, 3); assert.equal(admitted.length, TABLES.length - 3);
    removeHold();
    prepareHold(); r.sql("select cutover_hold.install('twelve-table-negative-control');");
    const unguardedDependencies = ['families', 'family_insurance_policies'];
    for (const table of TABLES) {
      if (unguardedDependencies.includes(table)) assert.equal(expectOk(await patch(table)).length, 1);
      else expectHold(await patch(table));
    }
    // A real audience source change is allowed by the twelve-table barrier.
    const reassigned = expectOk(await app('service', '/family_insurance_policies?id=eq.' + policies.named, 'PATCH', { member_id: members.parent }));
    assert.equal(reassigned[0].member_id, members.parent);
    expectOk(await app('service', '/family_insurance_policies?id=eq.' + policies.named, 'PATCH', { member_id: members.teen }));
    removeHold();
    return { threeTable: { refused, admitted }, twelveTable: { unguardedDependencies, realAudienceSourceReassignmentAdmitted: true }, interpretation: 'The same required hold assertion fails for every admitted relation.' };
  });
  await check(NAMES[3], async () => {
    prepareHold();
    // A late alphabetical target makes partial-lock acquisition observable.
    const { session } = await transaction('cutover_old_writer', `begin;set local role service_role;update public.transactions set title='Synthetic in flight' where id=${literal(rows.transactions)};`);
    try {
      const failed = r.sql("select cutover_hold.install('complete');", { allowFailure: true });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /55P03/);
      assert.deepEqual(triggers(), []); assert.deepEqual(r.json('select to_json(tables) from cutover_hold.identity;'), []);
    } finally { await finish(session); }
    return { sqlstate: '55P03', triggerCount: 0, identityTableCount: 0 };
  });
  let oldPrepared;
  await check(NAMES[4], async () => {
    const held = await transaction('cutover_old_writer', `begin;set local role service_role;update public.calendar_events set title='Synthetic drain write' where id=${literal(rows.calendar_events)};`);
    const installer = r.session();
    try {
      installer.child.stdin.end("select cutover_hold.install('complete');\n\\q\n");
      let observed;
      await r.wait(() => { observed = blockersOf(held.pid); return observed.length > 0; }, 'Installer did not actually wait on the application writer', 1500);
      assert(observed.every(row => row.usename === 'cutover_maint'));
      await finish(held.session, 'commit;'); await installer.done; assert.equal(installer.code, 0); assertCompleteHold();
      return { actualBlockingPid: held.pid, waitingMaintenanceSessions: observed.length, completeAfterCommit: true };
    } finally { await finish(held.session); if (!installer.closed) await finish(installer); }
  });
  await check(NAMES[5], async () => {
    // Prepare predates a replacement installation, rather than merely an ordinary fresh statement.
    removeHold();
    oldPrepared = await transaction('cutover_old_writer', `set role service_role;prepare old_update as update public.calendar_events set title='Synthetic cached writer' where id=${literal(rows.calendar_events)};begin isolation level repeatable read;select count(*) from public.calendar_events;`);
    // A read transaction also holds a table lock: prove bounded refusal, then keep the prepared connection alive across COMMIT.
    prepareHold();
    const failed = r.sql("select cutover_hold.install('complete');", { allowFailure: true });
    assert.match(failed.stderr, /55P03/); assert.deepEqual(triggers(), []);
    oldPrepared.session.child.stdin.write("commit;\nselect 'OLD_COMMITTED';\n");
    await r.wait(() => oldPrepared.session.stdout.includes('OLD_COMMITTED'), 'Old snapshot did not end');
    installHold();
    oldPrepared.session.child.stdin.end("select set_config('cutover.maintenance','true',false);set application_name='cutover_maint';execute old_update;\n");
    await oldPrepared.session.done;
    assert.notEqual(oldPrepared.session.code, 0); assert.match(oldPrepared.session.stderr, /42501:\s+Synthetic cutover write hold/);
    return { preparedBeforeInstall: true, oldSnapshotInitiallyPreventedInstall: true, spoofedSettingsRefused: true };
  });
  await check(NAMES[6], async () => {
    for (const table of TABLES) {
      expectHold(await patch(table));
      // Empty statement controls avoid incidental FK/unique changes. Real-row UPDATE controls above calibrate health.
      for (const command of [
        `insert into public.${table} select * from public.${table} where false`,
        `update public.${table} set ${field(table)}=${field(table)} where false`,
        `delete from public.${table} where false`,
        `truncate public.${table} cascade`,
      ]) holdSqlFailure(r.sql(`begin;set local role service_role;${command};rollback;`, { login: 'cutover_old_writer', allowFailure: true }));
    }
    assertCompleteHold();
    return { realHttpWritesRefused: TABLES.length, statementOperationsRefused: TABLES.length * 4, emptyStatementsNotClaimedAsRowMutations: true };
  });
  await check(NAMES[7], async () => {
    for (const command of ["set role cutover_maint", "set session authorization cutover_maint", "update cutover_hold.identity set maintenance_name=session_user"]) {
      const failed = r.sql(command, { login: 'authenticator', allowFailure: true });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /42501/);
    }
    // A corrupted OID binding under the same admitted login name must fail closed.
    const oid = r.json("select to_json(maintenance_oid::bigint) from cutover_hold.identity;");
    r.sql("update cutover_hold.identity set maintenance_oid=0;");
    try { holdSqlFailure(r.sql(`update public.calendar_events set title='Synthetic wrong OID' where id=${literal(rows.calendar_events)};`, { allowFailure: true })); }
    finally { r.sql(`update cutover_hold.identity set maintenance_oid=${Number(oid)};`); }
    return { roleAndSessionSpoofingDenied: true, sameNameWrongOidDenied: true };
  });
  await check(NAMES[8], async () => {
    const applied = stage(0);
    const columns = r.json("select json_agg(table_name order by table_name) from information_schema.columns where table_schema='public' and column_name='idempotency_key';");
    assert.deepEqual(columns, ['calendar_events', 'chore_assignments', 'family_reminders', 'grocery_items', 'meal_plans', 'todo_items']);
    const transactionColumns = r.json("select json_agg(column_name order by column_name) from information_schema.columns where table_schema='public' and table_name='transactions' and column_name in('fingerprint','source','receipt_document_id');");
    assert.deepEqual(transactionColumns, ['fingerprint', 'receipt_document_id', 'source']);
    assert.equal(r.json("select to_json(count(*)) from pg_indexes where schemaname='public' and (indexname like 'uq_%_idempotency' or indexname='uq_transactions_fingerprint');"), 7);
    const indexes = r.json("select json_agg(json_build_object('valid',i.indisvalid,'unique',i.indisunique,'predicate',pg_get_expr(i.indpred,i.indrelid))) from pg_index i join pg_class c on c.oid=i.indexrelid where c.relname in('uq_calendar_events_idempotency','uq_family_reminders_idempotency','uq_todo_items_idempotency','uq_chore_assignments_idempotency','uq_meal_plans_idempotency','uq_grocery_items_idempotency','uq_transactions_fingerprint');");
    assert.equal(indexes.length, 7); assert(indexes.every(index => index.valid && index.unique && /(?:idempotency_key|fingerprint) IS NOT NULL/.test(index.predicate)));
    assert.equal(r.json("select to_json(count(*)) from pg_constraint where conname='transactions_receipt_document_id_fkey' and conrelid='public.transactions'::regclass;"), 1);
    assertCompleteHold();
    return applied;
  });
  await check(NAMES[9], async () => {
    const payload = 'begin;\n' + r.migration(1) + '\nselect 1/0;\ncommit;';
    const failed = r.sql(payload, { allowFailure: true });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /22012/);
    assert.equal(r.json("select to_json(to_regprocedure('public.is_self_member(uuid)') is null);"), true);
    assert.equal(r.json("select to_json(count(*)) from pg_policies where tablename='event_rsvps' and policyname='Members can manage event_rsvps';"), 1);
    assert.equal(r.json("select to_json(count(*)) from pg_indexes where indexname='uq_family_reminders_idempotency';"), 1);
    return { failedPayloadSha256: sha(payload), rollbackObserved: true, earlier0256StillCommitted: true, chainAtomic: false };
  });
  await check(NAMES[10], async () => {
    const applied = [stage(1), stage(2)];
    assert.equal(r.json("select to_json(count(*)) from pg_policies where tablename='event_rsvps' and policyname in('event_rsvps_select','event_rsvps_insert','event_rsvps_update','event_rsvps_delete');"), 4);
    assert.equal(r.json("select to_json(count(*)) from pg_policies where tablename='autopilot_suggestions' and policyname in('autopilot_suggestions_no_client_delete_guard','autopilot_suggestions_resolver_guard','autopilot_suggestions_resolver_update_guard');"), 3);
    assertCompleteHold();
    return { applied };
  });
  await check(NAMES[11], async () => {
    assert.equal(currentCard(rows.autopilot_suggestions).member_id, null);
    const applied = stage(3);
    assert.equal(currentCard(rows.autopilot_suggestions).member_id, members.teen);
    assert.equal(r.json("select to_json(count(*)) from pg_policies where tablename='autopilot_suggestions' and policyname in('autopilot_suggestions_audience_read_guard','autopilot_suggestions_audience_update_guard') and permissive='RESTRICTIVE';"), 2);
    return applied;
  });
  await check(NAMES[12], async () => {
    const payload = r.migration(4);
    assert.match(payload, /\nBEGIN;/); assert.match(payload, /\nCOMMIT;\s*$/);
    // Deliberately lose the completion of an owned process AFTER real SQL commits.
    // This is process-ack fault injection, not a claim of an observed production network fault.
    const lost = r.session();
    lost.child.stdin.end(payload + "\nselect 'COMMIT_OBSERVED:'||pg_backend_pid();select pg_sleep(20);\n");
    await r.wait(() => lost.stdout.includes('COMMIT_OBSERVED:'), '0487 never reached its committed fault-injection point');
    const pid = Number(/COMMIT_OBSERVED:(\d+)/.exec(lost.stdout)?.[1]); assert(pid > 0);
    const killed = r.json(`select to_json(pg_terminate_backend(pid)) from pg_stat_activity where pid=${pid} and usename='cutover_maint' and datname='cutover_runtime';`);
    assert.equal(killed, true); await lost.done; assert.notEqual(lost.code, 0);
    const committed = r.json("select json_build_object('originColumns',(select count(*) from information_schema.columns where table_schema='public' and table_name in('family_reminders','reminders') and column_name in('autopilot_origin','autopilot_card_id')),'routines',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('create_card_family_reminder','create_card_legacy_reminder','create_card_legacy_reminder_service','repeat_card_family_reminder')));");
    assert.deepEqual(committed, { originColumns: 4, routines: 4 });
    const owners = r.json("select json_agg(json_build_object('name',p.proname,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('create_card_family_reminder','create_card_legacy_reminder','create_card_legacy_reminder_service','repeat_card_family_reminder');");
    assert.equal(owners.length, 4); assert(owners.every(row => row.owner === 'cutover_maint' && row.definer));
    const tables = r.json("select json_agg(json_build_object('name',relname,'owner',pg_get_userbyid(relowner),'rls',relrowsecurity)) from pg_class where oid in('public.family_reminders'::regclass,'public.reminders'::regclass,'public.autopilot_suggestions'::regclass);");
    assert.equal(tables.length, 3); assert(tables.every(row => row.owner === 'cutover_maint' && row.rls));
    const acl = r.json("select json_build_object('anonymousHuman',has_function_privilege('anon','public.create_card_family_reminder(uuid,timestamptz,timestamptz,text)','execute'),'ordinaryService',has_function_privilege('authenticated','public.create_card_legacy_reminder_service(jsonb,timestamptz,uuid)','execute'),'privateCore',has_function_privilege('authenticated','reminder_origin_private.scan_copy(jsonb,timestamptz,uuid,boolean)','execute'));");
    assert.deepEqual(acl, { anonymousHuman: false, ordinaryService: false, privateCore: false });
    assert.equal(r.json("select to_json(to_regprocedure('extensions.digest(text,text)') is not null and to_regprocedure('public.digest(text,text)') is null);"), true);
    assertCompleteHold(); await r.reload();
    return { rawSha256: sha(payload), ownTransactionPreserved: true, injectedAcknowledgementFailure: true, processExit: lost.code, committedStateReconciled: committed, retried: false, receiptIsSupabaseLedger: false };
  });
  await check(NAMES[13], async () => {
    const body = { p_card: cardDraft('held-service-' + id()), p_at: future, p_actor: null };
    expectHold(await app('service', '/rpc/create_card_legacy_reminder_service', 'POST', body));
    expectHold(await app('parent', '/rpc/create_card_legacy_reminder', 'POST', { p_card: cardDraft('held-parent-' + id()), p_at: future }));
    assert.equal(r.json("select to_json(count(*)) from public.autopilot_suggestions where dedupe_key like 'held-%';"), 0);
    return { definerOwnerCouldNotBypassSessionBarrier: true, cardsWritten: 0 };
  });
  await check(NAMES[14], async () => {
    const held = await transaction('cutover_old_writer', 'begin;set local role service_role;select count(*) from public.transactions;');
    try {
      const failed = r.sql('select cutover_hold.remove();', { allowFailure: true });
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /55P03/); assertCompleteHold();
    } finally { await finish(held.session); }
    return { sqlstate: '55P03', allTriggersAndIdentityRetained: true };
  });
  await check(NAMES[15], async () => {
    removeHold(); return { triggers: 0, privateNamespaceAbsent: true };
  });
  let stranded, repaired, parentReminder, committedParent;
  await check(NAMES[16], async () => {
    const draft = cardDraft('old-wire-' + id());
    // Historical scan writes the reminder FIRST; remErr keeps status OPEN but does not stop the following card POST.
    const reminder = await app('parent', '/reminders', 'POST', {
      family_id: family, title: draft.title, remind_at: future, member_id: null,
      related_type: 'renewal', related_id: policies.named, created_by: users.parent,
    });
    assert.equal(reminder.status, 403); assert.equal(reminder.data?.code, '42501');
    assert.equal(reminder.data?.message, 'Trusted reminder creation required');
    stranded = expectOk(await app('parent', '/autopilot_suggestions', 'POST', draft))[0];
    assert.equal(stranded.status, 'open'); assert.equal(stranded.payload.reminder_id, undefined);
    assert.deepEqual(actualReceipt(stranded.id), { card: 1, family: 0, legacy: 0 });
    const priorKeys = expectOk(await app('parent', '/autopilot_suggestions?select=id,dedupe_key,status&dedupe_key=eq.' + encodeURIComponent(draft.dedupe_key)));
    assert.equal(priorKeys.length, 1); assert.equal(priorKeys[0].status, 'open');
    assert.equal(needsReconciliation(stranded.id), true);
    const recurrenceCard = expectOk(await app('parent', '/autopilot_suggestions', 'POST', cardDraft('completed-before-hold-' + id())))[0];
    committedParent = expectOk(await app('parent', '/rpc/create_card_family_reminder', 'POST', familyCreateArgs(recurrenceCard)))[0];
    const completed = expectOk(await app('teen', '/family_reminders?id=eq.' + committedParent.id, 'PATCH', { status: 'completed', completed_at: new Date().toISOString() }));
    assert.equal(completed.length, 1); assert.equal(completed[0].status, 'completed');
    return { wireOrder: ['reminders INSERT refused', 'card INSERT committed OPEN', 'next prior-key read sees OPEN'], committedCardWithoutReceipt: true, exactOldApplicationExecutionClaimed: false };
  });
  await check(NAMES[17], async () => {
    prepareHold(); installHold();
    const draft = cardDraft('held-old-wire-' + id());
    expectHold(await app('parent', '/reminders', 'POST', { family_id: family, title: draft.title, remind_at: future, member_id: null, related_type: 'renewal', related_id: policies.named, created_by: users.parent }));
    expectHold(await app('parent', '/autopilot_suggestions', 'POST', draft));
    assert.equal(r.json(`select to_json(count(*)) from public.autopilot_suggestions where dedupe_key=${literal(draft.dedupe_key)};`), 0);
    return { bothIndependentRequestsHeld: true, committedStrandedCard: 0 };
  });
  await check(NAMES[18], async () => {
    assert.equal(needsReconciliation(stranded.id), true);
    assert.equal(r.json(`select to_json(count(*)) from public.autopilot_suggestions where id=${literal(stranded.id)} and status='open';`), 1);
    assert.equal(r.json(`select to_json(status) from public.family_reminders where id=${literal(committedParent.id)};`), 'completed');
    assert.equal(r.json(`select to_json(count(*)) from public.family_reminders where idempotency_key=${literal(sha('autopilot.repeat:' + committedParent.id))};`), 0);
    expectHold(await app('teen', '/rpc/repeat_card_family_reminder', 'POST', { p_parent_id: committedParent.id, p_at: future }));
    // No elapsed-time or empty-transaction check turns this committed multi-request gap into a completed workflow.
    assertCompleteHold();
    return { knownStrandedOperationRefusesResume: true, transactionDrainAloneInsufficient: true, fabricatedSuccess: false };
  });
  await check(NAMES[19], async () => {
    const source = currentCard(stranded.id), args = familyCreateArgs(source);
    const sql = `begin;set local role authenticated;select set_config('request.jwt.claim.sub',${literal(users.parent)},true);
      select to_json(r) from public.create_card_family_reminder(${literal(args.p_card_id)},${literal(args.p_expected_updated_at)},${literal(args.p_at)},${literal(args.p_source_tag)}) r;commit;`;
    const first = r.sql(sql);
    assert.equal(first.status, 0);
    repaired = r.json(`select row_to_json(r) from public.family_reminders r where autopilot_card_id=${literal(stranded.id)};`);
    assert.equal(repaired.autopilot_origin, true); assert.equal(repaired.family_id, family);
    r.sql(sql); assert.equal(needsReconciliation(stranded.id), false);
    const reconcileRepeat = `begin;set local role authenticated;select set_config('request.jwt.claim.sub',${literal(users.teen)},true);select id from public.repeat_card_family_reminder(${literal(committedParent.id)},${literal(future)});commit;`;
    r.sql(reconcileRepeat); r.sql(reconcileRepeat);
    assert.equal(r.json(`select to_json(count(*)) from public.family_reminders where idempotency_key=${literal(sha('autopilot.repeat:' + committedParent.id))};`), 1);
    parentReminder = repaired;
    // Maintenance SET ROLE is explicitly not ordinary-API authorization evidence.
    for (const actor of ['parent', 'teen']) assert.equal(expectOk(await app(actor, '/family_reminders?select=id&id=eq.' + repaired.id)).length, 1);
    for (const actor of ['unnamed', 'foreign', 'inactive']) assert.deepEqual(expectOk(await app(actor, '/family_reminders?select=id&id=eq.' + repaired.id)), []);
    expectHold(await patch('family_reminders'));
    assertCompleteHold();
    return { actualOneCopyReceipt: repaired.id, maintenanceReconciliationModelOnly: true, normalApiWritesStillHeld: true };
  });
  await check(NAMES[20], async () => {
    assert([...r.sessions].every(session => session.closed), 'A known old session is still active');
    removeHold();
    const named = expectOk(await app('teen', '/family_reminders?id=eq.' + repaired.id, 'PATCH', { status: 'completed', completed_at: new Date().toISOString() }));
    assert.equal(named.length, 1);
    for (const actor of ['unnamed', 'foreign', 'inactive']) {
      const denied = await app(actor, '/rpc/repeat_card_family_reminder', 'POST', { p_parent_id: repaired.id, p_at: future });
      assert.equal(denied.status, 403); assert.equal(denied.data?.code, '42501');
    }
    const foreignCopy = await app('foreign', '/rpc/create_card_legacy_reminder', 'POST', { p_card: cardDraft('foreign-forgery-' + id()), p_at: future });
    assert.equal(foreignCopy.status, 403); assert.equal(foreignCopy.data?.code, '42501');
    const serviceOnly = await app('parent', '/rpc/create_card_legacy_reminder_service', 'POST', { p_card: cardDraft('ordinary-service-' + id()), p_at: future, p_actor: null });
    assert.equal(serviceOnly.status, 403); assert.equal(serviceOnly.data?.code, '42501');
    const manual = expectOk(await app('parent', '/family_reminders', 'POST', { family_id: family, title: 'Synthetic manual after cutover', created_by: users.parent }));
    assert.equal(manual.length, 1); assert.equal(manual[0].autopilot_origin, false);
    return { namedMutation: true, unnamedForeignInactiveRpcDenied: true, ordinaryServiceOnlyDenied: true, manualHealthy: true, productionControlledAcceptanceClaimed: false };
  });
  await check(NAMES[21], async () => {
    const args = { p_parent_id: parentReminder.id, p_at: future };
    const first = expectOk(await app('teen', '/rpc/repeat_card_family_reminder', 'POST', args));
    const again = expectOk(await app('teen', '/rpc/repeat_card_family_reminder', 'POST', args));
    assert.equal(first.length, 1); assert.equal(again.length, 1); assert.equal(first[0].id, again[0].id);
    assert.equal(first[0].autopilot_origin, true); assert.equal(first[0].autopilot_card_id, stranded.id); assert.equal(first[0].family_id, family);
    assert.equal(first[0].status, 'active');
    assert.equal(r.json(`select to_json(count(*)) from public.family_reminders where idempotency_key=${literal(sha('autopilot.repeat:' + parentReminder.id))};`), 1);
    return { firstAndRetrySameReceipt: true, actualNextOccurrenceCount: 1 };
  });
  await check(NAMES[22], async () => {
    prepareHold(); installHold();
    const snapshot = () => r.json("select json_build_object('family',(select json_agg(x order by x.id) from(select id,autopilot_origin,autopilot_card_id,idempotency_key,tags from public.family_reminders)x),'legacy',(select json_agg(x order by x.id) from(select id,autopilot_origin,autopilot_card_id,related_type,related_id from public.reminders)x));");
    const before = snapshot();
    for (let index = 0; index < 4; index++) stage(index);
    r.sql(r.migration(4)); // exact file owns BEGIN/COMMIT; no enclosing -1 transaction
    assert.deepEqual(snapshot(), before); assertCompleteHold();
    removeHold();
    return { fullFilesReapplied: 5, identityRowsUnchanged: true, heldReservedFilesExecuted: 0 };
  });
  assert.equal(caseIndex, NAMES.length);
  assert(report.cases.every(test => test.status === 'passed'));
  report.expectedCases = NAMES.length;
}
