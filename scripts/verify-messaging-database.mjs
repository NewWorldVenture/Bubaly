// Executes the actual messaging migrations and role probes in a NEW disposable
// local cluster. Never accepts a connection URL or touches an existing server.
// Windows: node scripts/verify-messaging-database.mjs --bin "C:/Program Files/PostgreSQL/17/bin"
// Optional --advisors runs Supabase CLI security advisors on ONLY this cluster.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args[0] !== '--bin' || ![2, 3].includes(args.length) || (args.length === 3 && args[2] !== '--advisors'))
  throw new Error('Pass --bin with a local PostgreSQL bin directory, optionally followed by --advisors.');
const advisors = args[2] === '--advisors';
const bin = resolve(args[1]);
const suffix = process.platform === 'win32' ? '.exe' : '';
for (const name of ['initdb', 'pg_ctl', 'psql']) {
  if (!existsSync(join(bin, name + suffix))) throw new Error(`Missing local PostgreSQL executable: ${name}`);
}
const tempBase = realpathSync(tmpdir());
const work = mkdtempSync(join(tempBase, 'bubaly-messaging-pg-'));
const data = join(work, 'data');
const log = join(work, 'postgres.log');
const port = await new Promise((resolvePort, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const base = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'];
const run = (name, commandArgs, input) => execFileSync(join(bin, name + suffix), commandArgs, {
  cwd: root, input, encoding: 'utf8', timeout: 120_000,
  // A Windows server process inherits pg_ctl's pipes even with -l; waiting for
  // their EOF would block until the server stopped. Its log goes to our file.
  stdio: name === 'pg_ctl' ? 'ignore' : ['pipe', 'pipe', 'pipe'],
});
const sql = input => run('psql', base, input);
const file = name => run('psql', [...base, '-f', join(root, name)]);
const concurrentSql = input => new Promise((resolveQuery, reject) => {
  const child = execFile(join(bin, 'psql' + suffix), base, {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr })); else resolveQuery(stdout);
  });
  child.stdin.end(input);
});
const concurrently = async queries => {
  // Wait for every client before cluster cleanup, even if one probe fails.
  const results = await Promise.allSettled(queries);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
};
const waitForBackendLock = async (pid, description) => {
  sql(`do $$ declare attempt integer; begin
    for attempt in 1..600 loop
      if exists (select 1 from pg_locks where pid = ${Number(pid)} and not granted) then return; end if;
      perform pg_sleep(0.01);
    end loop;
    raise exception 'Timed out waiting for ${description}';
  end $$;`);
};
const startConcurrentSql = (input, readyMarker) => {
  let stdout = ''; let stderr = ''; let readySeen = false; let child;
  let resolveReady; let rejectReady;
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise; rejectReady = rejectReadyPromise;
  });
  const done = new Promise((resolveDone, rejectDone) => {
    child = spawn(join(bin, 'psql' + suffix), base, { cwd: root, windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const marker = stdout.match(new RegExp(`${readyMarker}=(\\d+)`));
      if (marker && !readySeen) { readySeen = true; resolveReady(Number(marker[1])); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timeout);
      if (!readySeen) rejectReady(error);
      rejectDone(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (!readySeen) rejectReady(new Error(`${readyMarker} was not emitted; ${stderr || stdout}`));
      if (code === 0) resolveDone(stdout);
      else rejectDone(Object.assign(new Error(`Concurrent PostgreSQL session exited with status ${code}.`), { stderr, stdout }));
    });
    child.stdin.end(input);
  });
  return { ready, done };
};
let started = false;
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  // Use loopback TCP only. Linux's default Unix socket directory is commonly
  // owned by the packaged service, not the non-root CI user running this probe.
  const socketOptions = process.platform === 'win32' ? '' : " -c unix_socket_directories=''";
  run('pg_ctl', ['-D', data, '-l', log, '-o', `-h 127.0.0.1 -p ${port}${socketOptions}`, '-w', 'start']);
  started = true;
  const bootstrap = readFileSync(join(root, 'docs/audit/pg-bootstrap.sh'), 'utf8');
  const shims = bootstrap.match(/psql[^\r\n]*<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/);
  if (!shims) throw new Error('Could not locate the shared Supabase audit shims.');
  sql(shims[1]);
  // Supabase owns this schema in production. The local shim models the columns
  // its Realtime authorization policies evaluate; no Realtime service is faked.
  sql(`create schema realtime;
    grant usage on schema realtime to authenticated;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create table realtime.messages(id uuid default gen_random_uuid(), topic text, extension text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;`);
  const migrations = [
    '0001_extensions_enums.sql', '0002_tables.sql', '0003_functions_triggers.sql', '0004_rls.sql',
    '0014_core_platform.sql', '0015_todos.sql', '0017_conversation_participants.sql', '0082_family_tree.sql', '01081_messages_enhance.sql',
    '01100_family_profile.sql', '0163_messages_audio_read_fix.sql', '0216_family_media_bucket.sql',
    '0225_pin_definer_search_path.sql', '0293_notifications_related_id_is_a_key.sql', '0301_notification_authorship.sql',
    '0367_a_message_is_its_senders.sql', '0368_a_conversation_is_not_anyones_to_wipe.sql',
    '0388_a_notification_is_written_by_bubaly_not_by_a_member.sql', '0418_a_public_bucket_serves_what_you_put_in_it.sql',
    '0459_family_media_is_read_by_the_family.sql', '0463_a_read_receipt_is_the_readers_own.sql',
  ];
  for (const name of migrations) file(`supabase/migrations/${name}`);
  file('docs/audit/messaging-legacy-fixture.sql');
  file('supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql');
  file('supabase/migrations/0476_messaging_notifications_preferences.sql');
  // Full-replay CI also reapplies migrations to an existing schema.
  file('supabase/migrations/0475_messaging_conversation_privacy_and_delivery.sql');
  file('supabase/migrations/0476_messaging_notifications_preferences.sql');
  console.log('PASS: both messaging migrations apply again to the existing schema.');
  const result = file('docs/audit/messaging-participant-boundaries.probe.sql');
  console.log(result.trim());
  console.log(file('docs/audit/messaging-notification.probe.sql').trim());
  console.log(file('docs/audit/messaging-membership-lifecycle.probe.sql').trim());
  for (const name of ['message-sender-check.sql', 'conversation-owner-check.sql', 'a-read-receipt-is-the-readers-own-check.sql',
    'family-media-answers-to-the-family-check.sql', 'removed-member-access-check.sql']) {
    file(`docs/audit/${name}`);
  }
  // Reuse the actual global policy sweep without the unrelated marketplace
  // deal fixture, whose tables are not part of this focused migration replay.
  const dealProbe = readFileSync(join(root, 'docs/audit/marketplace-deal-terms-check.sql'), 'utf8');
  const sweepStart = dealProbe.indexOf('-- The class, not the two names:');
  if (sweepStart < 0) throw new Error('Could not locate the shared UPDATE-policy symmetry assertion.');
  sql(dealProbe.slice(sweepStart));
  console.log('PASS: existing sender, owner, receipt/reaction, family-media, removed-member and UPDATE-policy symmetry probes.');
  const seed = readFileSync(join(root, 'supabase/seed_messages_one_family.sql'), 'utf8');
  const legacySeed = readFileSync(join(root, 'supabase/seed_messages.sql'), 'utf8');
  sql(`begin;
    update auth.users set email='newworldventurellc@gmail.com' where id='00000000-0000-4000-8000-000000004751';
    ${seed}
    ${seed}
    ${legacySeed}
    ${legacySeed}
    do $$ begin
      if (select count(*) from public.family_messages where sender_avatar='seed:messages') <> 520 then
        raise exception 'Message seed is not repeatable'; end if;
      if (select count(*) from public.family_conversations where family_id='00000000-0000-4000-8000-0000000047f1' and is_family_chat) <> 1 then
        raise exception 'Message seed duplicated canonical chat'; end if;
      if exists (select 1 from public.family_messages msg join public.family_conversations c on c.id=msg.conversation_id
        where msg.sender_avatar='seed:messages' and c.kind='direct' and (cardinality(c.participant_ids) <> 2
          or (msg.sender_id is not null and not exists (select 1 from public.family_members m
            where m.id=any(c.participant_ids) and m.user_id=msg.sender_id)))) then
        raise exception 'Message seed has invalid direct participants or sender'; end if;
      if not exists (select 1 from public.family_conversations c join public.family_messages m on m.conversation_id=c.id
        where c.is_archived and m.sender_avatar='seed:messages') then
        raise exception 'Message seed lost archived history'; end if;
      if (select count(*) from public.family_messages where content like '%[seed:msg]%') <> 500 then
        raise exception 'Legacy message seed is not repeatable'; end if;
    end $$;
    rollback;`);
  console.log('PASS: message seed runs twice without duplicate messages/canonical chats and preserves valid DM rosters and archived history.');
  if (advisors) {
    const command = ['--yes', 'supabase', 'db', 'advisors', '--db-url', `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
      '--type', 'security', '--level', 'warn', '--fail-on', 'none'];
    try {
      console.log(execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npx',
        process.platform === 'win32' ? ['/d', '/s', '/c', `npx.cmd ${command.join(' ')}`] : command,
        { cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    } catch (error) {
      // A CLI telemetry shutdown failure must not hide an actual completed
      // advisor report. Do not accept connection/query failures as success.
      const lines = String(error.stdout ?? '').trim().split(/\r?\n/).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      });
      const report = lines.find(line => line?.message === 'db advisors' && Array.isArray(line.results));
      const errors = lines.filter(line => line?._tag === 'Error');
      if (!report || errors.length === 0 || errors.some(line => line.error?.message !== 'Timeout while shutting down PostHog. Some events may not have been sent.')) throw error;
      console.log(JSON.stringify(report));
      console.warn('Advisors returned results; the CLI subsequently failed while shutting down telemetry.');
    }
  }
  sql(`insert into public.families(id, name, created_by) values
    ('00000000-0000-4000-8000-0000000047f3', 'Concurrent creation', '00000000-0000-4000-8000-000000004751');
    insert into public.family_members(family_id, user_id, display_name, role) values
    ('00000000-0000-4000-8000-0000000047f3', '00000000-0000-4000-8000-000000004752', 'Bob', 'adult');`);
  const asUser = (id, statement) => `begin; set local role authenticated;
    set local request.jwt.claim.sub='00000000-0000-4000-8000-00000000475${id}';
    ${statement}; select pg_sleep(0.1); commit;`;
  await concurrently([1, 2].map(id => concurrentSql(asUser(id,
    "select public.ensure_family_conversation('00000000-0000-4000-8000-0000000047f3')"))));
  await concurrently([1, 3].map(id => concurrentSql(asUser(id, `select public.create_family_conversation(
    '00000000-0000-4000-8000-0000000047f1',
    array['00000000-0000-4000-8000-0000000047a1','00000000-0000-4000-8000-0000000047a3']::uuid[],
    'Concurrent direct', 'direct')`))));
  await concurrently([1, 2].map(id => concurrentSql(asUser(id,
    "select public.toggle_family_message_reaction('00000000-0000-4000-8000-0000000047b1', '👍')"))));
  await concurrently([1, 2].map(id => concurrentSql(asUser(id,
    "select public.mark_conversation_read_through('00000000-0000-4000-8000-0000000047c1', '00000000-0000-4000-8000-0000000047b1')"))));
  sql(`do $$ begin
    if (select count(*) from public.family_conversations where family_id='00000000-0000-4000-8000-0000000047f3' and is_family_chat) <> 1
      then raise exception 'Concurrent ensure duplicated canonical chat'; end if;
    if (select count(*) from public.family_conversations where name='Concurrent direct') <> 1
      then raise exception 'Concurrent create duplicated DM'; end if;
    if not (select reactions->'👍' ?& array['00000000-0000-4000-8000-000000004751','00000000-0000-4000-8000-000000004752']
      from public.family_messages where id='00000000-0000-4000-8000-0000000047b1')
      then raise exception 'Concurrent reactions overwrote a caller'; end if;
    if not (select read_by @> array['00000000-0000-4000-8000-000000004751','00000000-0000-4000-8000-000000004752']::uuid[]
      from public.family_messages where id='00000000-0000-4000-8000-0000000047b1')
      then raise exception 'Concurrent read receipts overwrote a caller'; end if;
  end $$;`);
  console.log('PASS: independent sessions create one canonical chat, one DM, and preserve simultaneous reactions and read receipts.');

  // A message send and membership removal must have a serial order. First let
  // the trigger take its membership lock, then require deactivation to wait
  // until that message transaction commits.
  const familyId = '00000000-0000-4000-8000-0000000047f1';
  const memberId = '00000000-0000-4000-8000-0000000047a1';
  const aliceId = '00000000-0000-4000-8000-000000004751';
  const wholeChatId = '00000000-0000-4000-8000-0000000047c3';
  const sendFirst = startConcurrentSql(`begin;
    set local role authenticated;
    set local request.jwt.claim.sub='${aliceId}';
    insert into public.family_messages(id, family_id, conversation_id, sender_id, content)
      values ('00000000-0000-4000-8000-0000000047b4', '${familyId}', '${wholeChatId}', '${aliceId}', 'Send before removal');
    select pg_advisory_xact_lock(834, 1);
    select pg_backend_pid() as backend_pid \\gset
    \\echo SEND_LOCK_HELD=:backend_pid
    select pg_sleep(8);
    commit;`, 'SEND_LOCK_HELD');
  const sendFirstOutcome = sendFirst.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  let deactivateAfter;
  try {
    await sendFirst.ready;
    deactivateAfter = startConcurrentSql(`begin;
      select pg_backend_pid() as backend_pid \\gset
      \\echo DEACTIVATION_STARTED=:backend_pid
      update public.family_members set is_active=false where id='${memberId}';
      \\echo DEACTIVATION_UPDATED=:backend_pid
      commit;`, 'DEACTIVATION_STARTED');
    const deactivationOutcome = deactivateAfter.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const deactivationPid = await deactivateAfter.ready;
    const order = await Promise.race([
      waitForBackendLock(deactivationPid, 'deactivation to block on the message lock').then(() => 'blocked'),
      deactivationOutcome.then(() => 'finished'),
    ]);
    if (order !== 'blocked') throw new Error('Membership deactivation completed before the in-flight send released its row lock.');
    const outcomes = await Promise.all([sendFirstOutcome, deactivationOutcome]);
    if (outcomes.some(outcome => !outcome.ok)) throw outcomes.find(outcome => !outcome.ok).error;
  } catch (error) {
    await Promise.all([sendFirstOutcome, deactivateAfter?.done.then(value => ({ ok: true, value }), err => ({ ok: false, error: err }))].filter(Boolean));
    throw error;
  }
  sql(`do $$ begin
    if not exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b4')
      then raise exception 'Send-first lock ordering lost its committed message'; end if;
    if (select is_active from public.family_members where id='${memberId}')
      then raise exception 'Send-first lock ordering did not complete the later deactivation'; end if;
  end $$;
  update public.family_members set is_active=true where id='${memberId}';`);

  // Reverse the ordering: removal owns the row first. The send must wait, then
  // recheck is_active after the update commits and fail without inserting.
  const deactivateFirst = startConcurrentSql(`begin;
    update public.family_members set is_active=false where id='${memberId}';
    select pg_advisory_xact_lock(834, 2);
    select pg_backend_pid() as backend_pid \\gset
    \\echo DEACTIVATION_LOCK_HELD=:backend_pid
    select pg_sleep(8);
    commit;`, 'DEACTIVATION_LOCK_HELD');
  const deactivateFirstOutcome = deactivateFirst.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  let sendAfter;
  try {
    await deactivateFirst.ready;
    sendAfter = startConcurrentSql(`begin;
      set local role authenticated;
      set local request.jwt.claim.sub='${aliceId}';
      select pg_backend_pid() as backend_pid \\gset
      \\echo SEND_AFTER_STARTED=:backend_pid
      insert into public.family_messages(id, family_id, conversation_id, sender_id, content)
        values ('00000000-0000-4000-8000-0000000047b5', '${familyId}', '${wholeChatId}', '${aliceId}', 'Send after removal');
      commit;`, 'SEND_AFTER_STARTED');
    const sendAfterOutcome = sendAfter.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const sendAfterPid = await sendAfter.ready;
    const order = await Promise.race([
      waitForBackendLock(sendAfterPid, 'send to wait for the in-flight deactivation').then(() => 'blocked'),
      sendAfterOutcome.then(() => 'finished'),
    ]);
    if (order !== 'blocked') throw new Error('Send completed before the deactivation released its row lock.');
    const deactivationOutcome = await deactivateFirstOutcome;
    if (!deactivationOutcome.ok) throw deactivationOutcome.error;
    const outcome = await sendAfterOutcome;
    if (outcome.ok) throw new Error('A send after committed membership deactivation was accepted.');
    if (!String(outcome.error.stderr ?? '').includes('The sender must be an active household member')) throw outcome.error;
  } catch (error) {
    await Promise.all([deactivateFirstOutcome, sendAfter?.done.then(value => ({ ok: true, value }), err => ({ ok: false, error: err }))].filter(Boolean));
    throw error;
  }
  sql(`do $$ begin
    if exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b5')
      then raise exception 'Removal-first lock ordering inserted a message'; end if;
    if (select is_active from public.family_members where id='${memberId}')
      then raise exception 'Removal-first lock ordering unexpectedly reactivated the member'; end if;
  end $$;`);

  // The same active-member ordering applies to every authenticated UPDATE
  // (content, receipts, reactions, and pins) and hard DELETE, not just INSERT.
  // Use separate messages for delete-first and delete-after-removal fixtures.
  sql(`update public.family_members set is_active=true where id='${memberId}';
    insert into public.family_messages(id, family_id, conversation_id, sender_id, content) values
      ('00000000-0000-4000-8000-0000000047b6', '${familyId}', '${wholeChatId}', '${aliceId}', 'Delete before removal'),
      ('00000000-0000-4000-8000-0000000047b7', '${familyId}', '${wholeChatId}', '${aliceId}', 'Delete after removal');`);
  const membershipWriteRace = async ({ name, writeFirstSql, writeAfterSql, firstStateCheck, deniedStateCheck }) => {
    const tag = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    sql(`update public.family_members set is_active=true where id='${memberId}';`);
    const writeFirst = startConcurrentSql(`begin;
      set local role authenticated;
      set local request.jwt.claim.sub='${aliceId}';
      ${writeFirstSql};
      select pg_backend_pid() as backend_pid \\gset
      \\echo ${tag}_WRITE_LOCK_HELD=:backend_pid
      select pg_sleep(3);
      commit;`, `${tag}_WRITE_LOCK_HELD`);
    const writeFirstOutcome = writeFirst.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    let revokeAfter;
    try {
      await writeFirst.ready;
      revokeAfter = startConcurrentSql(`begin;
        select pg_backend_pid() as backend_pid \\gset
        \\echo ${tag}_REVOKE_STARTED=:backend_pid
        update public.family_members set is_active=false where id='${memberId}';
        commit;`, `${tag}_REVOKE_STARTED`);
      const revokeOutcome = revokeAfter.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      const revokePid = await revokeAfter.ready;
      const order = await Promise.race([
        waitForBackendLock(revokePid, `${name} deactivation to wait for the message write`).then(() => 'blocked'),
        revokeOutcome.then(() => 'finished'),
      ]);
      if (order !== 'blocked') throw new Error(`${name} did not serialize before membership deactivation.`);
      const outcomes = await Promise.all([writeFirstOutcome, revokeOutcome]);
      if (outcomes.some(outcome => !outcome.ok)) throw outcomes.find(outcome => !outcome.ok).error;
    } catch (error) {
      await Promise.all([writeFirstOutcome, revokeAfter?.done.then(value => ({ ok: true, value }), err => ({ ok: false, error: err }))].filter(Boolean));
      throw error;
    }
    sql(`do $$ begin
      if not coalesce((${firstStateCheck}), false) then raise exception '${name} write-first ordering lost its committed mutation'; end if;
      if (select is_active from public.family_members where id='${memberId}')
        then raise exception '${name} write-first ordering did not complete the later deactivation'; end if;
    end $$;
    update public.family_members set is_active=true where id='${memberId}';`);

    // Reverse the order. A deactivation that owns the membership row first
    // must make this write wait, then fail its active-member check.
    const revokeFirst = startConcurrentSql(`begin;
      update public.family_members set is_active=false where id='${memberId}';
      select pg_advisory_xact_lock(834, ${name === 'content edit' ? 3 : 4});
      select pg_backend_pid() as backend_pid \\gset
      \\echo ${tag}_REVOKE_LOCK_HELD=:backend_pid
      select pg_sleep(3);
      commit;`, `${tag}_REVOKE_LOCK_HELD`);
    const revokeFirstOutcome = revokeFirst.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    let writeAfter;
    try {
      await revokeFirst.ready;
      writeAfter = startConcurrentSql(`begin;
        set local role authenticated;
        set local request.jwt.claim.sub='${aliceId}';
        select pg_backend_pid() as backend_pid \\gset
        \\echo ${tag}_WRITE_AFTER_STARTED=:backend_pid
        ${writeAfterSql};
        commit;`, `${tag}_WRITE_AFTER_STARTED`);
      const writeAfterOutcome = writeAfter.done.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
      const writePid = await writeAfter.ready;
      const order = await Promise.race([
        waitForBackendLock(writePid, `${name} to wait for the in-flight deactivation`).then(() => 'blocked'),
        writeAfterOutcome.then(() => 'finished'),
      ]);
      if (order !== 'blocked') throw new Error(`${name} completed before the in-flight deactivation released its row lock.`);
      const revokeOutcome = await revokeFirstOutcome;
      if (!revokeOutcome.ok) throw revokeOutcome.error;
      const outcome = await writeAfterOutcome;
      if (outcome.ok) throw new Error(`${name} after committed membership deactivation was accepted.`);
      if (!String(outcome.error.stderr ?? '').includes('An active household member is required')) throw outcome.error;
    } catch (error) {
      await Promise.all([revokeFirstOutcome, writeAfter?.done.then(value => ({ ok: true, value }), err => ({ ok: false, error: err }))].filter(Boolean));
      throw error;
    }
    sql(`do $$ begin
      if not coalesce((${deniedStateCheck}), false) then raise exception '${name} after-removal write changed or removed the message'; end if;
      if (select is_active from public.family_members where id='${memberId}')
        then raise exception '${name} removal-first ordering unexpectedly reactivated the member'; end if;
    end $$;`);
    console.log(`PASS: two-session ${name} and membership-removal races serialize in both lock orderings.`);
  };

  await membershipWriteRace({
    name: 'content edit',
    writeFirstSql: "update public.family_messages set content='Edited before removal' where id='00000000-0000-4000-8000-0000000047b1'",
    writeAfterSql: "update public.family_messages set content='Edited after removal' where id='00000000-0000-4000-8000-0000000047b1'",
    firstStateCheck: "(select content = 'Edited before removal' from public.family_messages where id='00000000-0000-4000-8000-0000000047b1')",
    deniedStateCheck: "(select content = 'Edited before removal' from public.family_messages where id='00000000-0000-4000-8000-0000000047b1')",
  });
  await membershipWriteRace({
    name: 'hard delete',
    writeFirstSql: "delete from public.family_messages where id='00000000-0000-4000-8000-0000000047b6'",
    writeAfterSql: "delete from public.family_messages where id='00000000-0000-4000-8000-0000000047b7'",
    firstStateCheck: "not exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b6')",
    deniedStateCheck: "exists (select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b7')",
  });
  // Service-role maintenance has auth.uid() = NULL and keeps its prior bypass.
  sql(`insert into public.family_messages(id, family_id, conversation_id, sender_id, content)
      values ('00000000-0000-4000-8000-0000000047b8', '${familyId}', '${wholeChatId}', '${aliceId}', 'Service write');
    set role service_role;
    set request.jwt.claim.sub='';
    update public.family_messages set content='Service edit' where id='00000000-0000-4000-8000-0000000047b8';
    delete from public.family_messages where id='00000000-0000-4000-8000-0000000047b8';
    reset role;
    do $$ begin
      if exists(select 1 from public.family_messages where id='00000000-0000-4000-8000-0000000047b8') then
        raise exception 'Service-role delete behavior changed'; end if;
    end $$;`);
  console.log('PASS: service-role message update/delete remains available without an authenticated membership lock.');
  console.log(`Messaging database checks passed on disposable PostgreSQL at 127.0.0.1:${port}.`);
} catch (error) {
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  if (started && existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  // Only remove this exact mkdtemp-created child of the resolved temp directory.
  const target = realpathSync(work);
  if (target !== resolve(work) || !target.startsWith(tempBase + sep) || dirname(target) !== tempBase
    || !target.slice(tempBase.length + 1).startsWith('bubaly-messaging-pg-')) throw new Error('Refusing unsafe cluster cleanup.');
  rmSync(target, { recursive: true, force: true });
}
