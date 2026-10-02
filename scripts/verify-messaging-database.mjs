// Executes the actual messaging migrations and role probes in a NEW disposable
// local cluster. Never accepts a connection URL or touches an existing server.
// Windows: node scripts/verify-messaging-database.mjs --bin "C:/Program Files/PostgreSQL/17/bin"
// Optional --advisors runs Supabase CLI security advisors on ONLY this cluster.
import { execFile, execFileSync } from 'node:child_process';
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
  const child = execFile(join(bin, 'psql' + suffix), base, { cwd: root, encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
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
    '0014_core_platform.sql', '0017_conversation_participants.sql', '01081_messages_enhance.sql',
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
  for (const name of ['message-sender-check.sql', 'conversation-owner-check.sql', 'a-read-receipt-is-the-readers-own-check.sql']) {
    file(`docs/audit/${name}`);
  }
  console.log('PASS: existing message sender, conversation owner and receipt/reaction regression probes.');
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
