// Synthetic concurrency checks. Requires an independently started disposable
// localhost cluster and verifies its exact data directory before creating any DB.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, args) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), args[i + 1]]);
  return pairs;
}, []));
assert(options['postgres-bin'] && options['expected-data-dir'],
  'Supply --postgres-bin, --port and --expected-data-dir for your disposable cluster.');
assert(/^\d{4,5}$/.test(options.port ?? ''), 'An explicit localhost port is required.');
const executable = name => join(options['postgres-bin'], name + (process.platform === 'win32' ? '.exe' : ''));
const connection = ['-h', '127.0.0.1', '-p', options.port, '-U', 'postgres'];
const command = (db, sql) => execFileSync(executable('psql'), [
  ...connection, '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql,
], { encoding: 'utf8', timeout: 20_000 }).trim();
const actualDirectory = command('postgres', 'show data_directory;');
const normalized = value => resolve(value).replaceAll('\\', '/').toLowerCase();
assert.equal(normalized(actualDirectory), normalized(options['expected-data-dir']),
  'Refusing writes: connected postmaster is not the explicitly named disposable cluster.');
const databases = new Set();
const sessions = new Set();
let serial = 0;
let completedChecks = 0;

function session(db, label) {
  const app = `messaging-synthetic-${process.pid}-${++serial}-${label}`;
  const child = spawn(executable('psql'), [
    ...connection, '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
  ], { env: { ...process.env, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', pending = null;
  child.stdout.on('data', chunk => { output += chunk; finish(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  // A process can exit before its stderr pipe is drained. Authorization and
  // deadlock controls must inspect the complete SQLSTATE diagnostic.
  child.on('close', code => {
    if (pending) { const job = pending; pending = null; clearTimeout(job.timer); job.reject(new Error(`psql exited ${code}: ${errors}\n${output}`)); }
  });
  function finish() {
    if (!pending || !output.includes(pending.marker)) return;
    const job = pending; pending = null; clearTimeout(job.timer);
    const text = output.slice(0, output.indexOf(job.marker)).trim();
    output = output.slice(output.indexOf(job.marker) + job.marker.length);
    job.resolve(text);
  }
  const api = {
    app,
    run(sql) {
      assert.equal(pending, null, 'Commands within a session must be sequential.');
      return new Promise((resolve, reject) => {
        const marker = 'done_' + randomUUID();
        const timer = setTimeout(() => {
          pending = null; child.kill(); reject(new Error(`psql timeout: ${errors}\n${output}`));
        }, 15_000);
        pending = { marker, resolve, reject, timer };
        child.stdin.write(sql + '\n\\echo ' + marker + '\n');
      });
    },
    close() { child.stdin.end('\\q\n'); sessions.delete(api); },
  };
  sessions.add(api);
  return api;
}

const actor = (who = 'alice', role = 'authenticated', deadlockTimeout = '100ms') => `
  begin; set local statement_timeout = '12s'; set local deadlock_timeout = '${deadlockTimeout}';
  select set_config('request.jwt.claim.sub', ${role === 'service_role' ? "''" : `fixture.id('${who}')::text`}, true);
  set local role ${role};`;
const send = text => `select (public.send_family_message(fixture.id('family'), fixture.id('mixed'),
  fixture.id('alice-member'), fixture.id('alice'), '${text}')).id;`;
const directUpdate = `update public.family_messages set content = 'synthetic updated'
  where id = fixture.id('mixed-message');`;
const directDelete = `delete from public.family_conversations where id = fixture.id('mixed');`;
const parentDelete = `delete from public.families where id = fixture.id('family');`;
async function waiting(db, target, blocker) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (command(db, `select count(*) from pg_stat_activity where application_name = '${target.app}' and wait_event_type = 'Lock'
      ${blocker ? `and (select pid from pg_stat_activity where application_name='${blocker.app}')=any(pg_blocking_pids(pid))` : ''};`) === '1') return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected a real lock wait: ' + target.app);
}
async function denied(result) {
  const error = await result;
  assert(error instanceof Error && /active household|Household unavailable/.test(error.message),
    `Expected an authorization refusal after the wait; got ${error}`);
  assert(!/deadlock detected|40P01/.test(error.message), 'A deadlock is not an authorization result.');
}

async function check(label, work) {
  const db = `synthetic_messaging_${process.pid}_${++serial}`;
  execFileSync(executable('createdb'), [...connection, db]);
  databases.add(db);
  try {
    execFileSync(executable('psql'), [...connection, '-d', db, '-X', '-q', '-v', 'ON_ERROR_STOP=1',
      '-v', 'keep_fixture=true', '-f', 'tests/fixtures/messaging-preserve-access.sql'], { stdio: 'pipe', timeout: 20_000 });
    // Match main 0003/0004 family deletion authorization for cascade races.
    command(db, `create or replace function public.is_family_admin(p_family_id uuid) returns boolean
      language sql stable security definer set search_path = '' as $$ select exists (
        select 1 from public.family_members where family_id=p_family_id and user_id=auth.uid()
          and role='parent' and is_active) $$;
      alter table public.families enable row level security;
      drop policy if exists families_select on public.families;
      drop policy if exists families_delete on public.families;
      create policy families_select on public.families for select to authenticated using(public.is_family_member(id));
      create policy families_delete on public.families for delete to authenticated using(public.is_family_admin(id));
      grant select,delete on public.families to authenticated;`);
    await work(db);
    completedChecks++;
    console.log('PASS ' + label);
  } finally {
    for (const client of [...sessions]) client.close();
    execFileSync(executable('dropdb'), [...connection, '--force', db]);
    databases.delete(db);
  }
}

// A scheduling-only BEFORE ROW barrier runs after the actual UPDATE/DELETE has
// locked its member row, before the production parent-admission/AFTER triggers.
// It changes no data and is installed only in this runner's disposable DB.
function pauseMembership(db) {
  command(db, `create function fixture.pause_membership() returns trigger
    language plpgsql security definer set search_path='' as $$
    begin
      if old.id=fixture.id('parent-member') then perform pg_advisory_xact_lock(4917476); end if;
      if tg_op='DELETE' then return old; end if; return new;
    end $$;
    create trigger synthetic_pause_membership before update or delete on public.family_members
      for each row execute function fixture.pause_membership();
    delete from public.family_model_dirty where family_id=fixture.id('family');`);
}
const deactivateParent = `update public.family_members set is_active=false where id=fixture.id('parent-member');`;
async function membershipDeletionRace(db, { unprotected = false, role = 'authenticated', accountCascade = false } = {}) {
  pauseMembership(db);
  if (unprotected) command(db, `drop trigger trg_family_members_scope_lock on public.family_members;
    drop trigger trg_family_members_parent_lock on public.family_members;`);
  const gate = session(db, 'membership-scheduling-gate'), mutation = session(db, 'ordinary-membership-mutation'), deletion = session(db, 'queued-parent-delete');
  await gate.run('begin; select pg_advisory_xact_lock(4917476);');
  const operation = accountCascade ? `delete from auth.users where id=fixture.id('parent');` : deactivateParent;
  const pendingMutation = mutation.run(actor('parent', role) + operation + 'commit;').catch(error => error);
  await waiting(db, mutation, gate);
  const pendingDeletion = deletion.run(actor('parent', 'authenticated', '10s') + parentDelete + 'commit;').catch(error => error);
  await waiting(db, deletion, mutation);
  await gate.run('commit;');
  const mutationResult = await pendingMutation, deletionResult = await pendingDeletion;
  if (unprotected) {
    assert(mutationResult instanceof Error && /40P01: deadlock detected/.test(mutationResult.message), String(mutationResult));
    assert(/mark_model_dirty\(\)|family_model_dirty/.test(mutationResult.message), mutationResult.message);
    assert(!(deletionResult instanceof Error), String(deletionResult));
    assert.equal(command(db, `select count(*) from public.families where id=fixture.id('family');`), '0');
  } else if (role === 'authenticated') {
    assert(!(mutationResult instanceof Error), String(mutationResult));
    assert(deletionResult instanceof Error && /42501: An active household member is required/.test(deletionResult.message), String(deletionResult));
    assert(!/40P01|deadlock detected/.test(deletionResult.message), deletionResult.message);
    assert.equal(command(db, `select is_active from public.family_members where id=fixture.id('parent-member');`), 'f');
    assert.equal(command(db, `select count(*) from public.family_model_dirty where family_id=fixture.id('family');`), '1');
    assert.equal(command(db, `select count(*) from public.families where id=fixture.id('family');`), '1');
  } else {
    assert(mutationResult instanceof Error && /55P03: Household is changing\. Retry the membership change\./.test(mutationResult.message), String(mutationResult));
    assert(!/40P01|deadlock detected/.test(mutationResult.message), mutationResult.message);
    assert(!(deletionResult instanceof Error), String(deletionResult));
    assert.equal(command(db, `select count(*) from public.families where id=fixture.id('family');`), '0');
    if (accountCascade) assert.equal(command(db, `select count(*) from auth.users where id=fixture.id('parent');`), '1');
  }
}

try {
  await check('concurrent canonical creation creates one empty chat without adoption', async db => {
    command(db, `delete from public.family_conversations where is_family_chat;`);
    const first = session(db, 'ensure-first'), second = session(db, 'ensure-second');
    const id = await first.run(actor() + `select public.ensure_family_conversation(fixture.id('family'));`);
    const pending = second.run(actor('bob') + `select public.ensure_family_conversation(fixture.id('family')); commit;`);
    await waiting(db, second); await first.run('commit;');
    assert.equal((await pending).split('\n').at(-1), id.split('\n').at(-1));
    assert.equal(command(db, `select count(*) from public.family_conversations where is_family_chat;`), '1');
    assert.equal(command(db, `select count(*) from public.family_messages where conversation_id in
      (select id from public.family_conversations where is_family_chat);`), '0');
  });

  await check('concurrent sends serialize metadata updates without shared-lock upgrades', async db => {
    const first = session(db, 'send-first'), second = session(db, 'send-second');
    await first.run(actor() + send('synthetic concurrent first'));
    const pending = second.run(actor() + send('synthetic concurrent second') + 'commit;');
    await waiting(db, second); await first.run('commit;'); await pending;
    assert.equal(command(db, `select count(*) from public.family_messages where content like 'synthetic concurrent%';`), '2');
  });

  for (const role of ['authenticated', 'service_role']) {
    await check(`removal first rejects late ${role} RPC send`, async db => {
      const removal = session(db, 'remove-first'), late = session(db, 'late-send');
      await removal.run(`begin; update public.family_members set is_active=false where id=fixture.id('alice-member');`);
      const pending = late.run(actor('alice', role) + send('synthetic revoked')).catch(error => error);
      await waiting(db, late); await removal.run('commit;'); await denied(pending);
      assert.equal(command(db, `select count(*) from public.family_messages where content='synthetic revoked';`), '0');
    });
  }

  await check('removal first prevents elevated actor from creating a canonical chat', async db => {
    command(db, 'delete from public.family_conversations where is_family_chat;');
    const removal = session(db, 'remove-first'), late = session(db, 'late-ensure');
    await removal.run(`begin; update public.family_members set is_active=false where id=fixture.id('alice-member');`);
    const pending = late.run(actor('alice', 'service_role') + `select public.ensure_family_conversation(
      fixture.id('family'), fixture.id('alice-member'), fixture.id('alice')); commit;`).catch(error => error);
    await waiting(db, late); await removal.run('commit;'); await denied(pending);
    assert.equal(command(db, 'select count(*) from public.family_conversations where is_family_chat;'), '0');
  });

  await check('removal first rejects elevated retry reads of private history', async db => {
    const content = command(db, `select content from public.family_messages where id=fixture.id('mixed-message');`);
    const removal = session(db, 'remove-first'), late = session(db, 'late-probe');
    await removal.run(`begin; update public.family_members set is_active=false where id=fixture.id('alice-member');`);
    const pending = late.run(actor('alice', 'service_role') + `select id from public.find_family_message(
      fixture.id('family'),fixture.id('mixed'),fixture.id('alice-member'),fixture.id('alice'),
      '${content.replaceAll("'", "''")}', 'text', null, '2000-01-01'::timestamptz); commit;`).catch(error => error);
    await waiting(db, late); await removal.run('commit;'); await denied(pending);
    assert.equal(command(db, `select count(*) from public.family_messages where id=fixture.id('mixed-message');`), '1');
  });

  await check('send first commits before subsequent membership removal', async db => {
    const first = session(db, 'send-first'), removal = session(db, 'remove-second');
    await first.run(actor() + send('synthetic linearized'));
    const pending = removal.run(`begin; update public.family_members set is_active=false where id=fixture.id('alice-member'); commit;`);
    await waiting(db, removal); await first.run('commit;'); await pending;
    assert.equal(command(db, `select count(*) from public.family_messages where content='synthetic linearized';`), '1');
  });

  for (const [kind, operation] of [['raw message UPDATE', directUpdate], ['raw conversation DELETE/cascade', directDelete]]) {
    await check(`removal first blocks ${kind}`, async db => {
      const originalContent = command(db, `select content from public.family_messages where id=fixture.id('mixed-message');`);
      const removal = session(db, 'remove-first'), late = session(db, 'late-write');
      await removal.run(`begin; update public.family_members set is_active=false where id=fixture.id('alice-member');`);
      const pending = late.run(actor() + operation + 'commit;').catch(error => error);
      await waiting(db, late); await removal.run('commit;');
      const result = await pending;
      if (result instanceof Error) assert(/active household/.test(result.message), result.message);
      assert.equal(command(db, `select content from public.family_messages where id=fixture.id('mixed-message');`), originalContent);
      assert.equal(command(db, `select count(*) from public.family_conversations where id=fixture.id('mixed');`), '1');
    });
  }

  for (const [kind, operation] of [['RPC send', send('synthetic parent order')], ['RPC reaction', "select (public.toggle_family_message_reaction(fixture.id('mixed-message'),'👍')).id;"], ['raw message UPDATE', directUpdate], ['raw conversation DELETE', directDelete]]) {
    await check(`${kind} first linearizes before parent-family cascade`, async db => {
      const first = session(db, 'member-first'), parent = session(db, 'parent-second');
      await first.run(actor() + operation);
      if (kind === 'RPC reaction') assert.equal(await first.run("select reactions->'👍' ? fixture.id('alice')::text from public.family_messages where id=fixture.id('mixed-message');"), 't');
      const pending = parent.run(actor('parent') + parentDelete + 'commit;');
      await waiting(db, parent); await first.run('commit;'); await pending;
      assert.equal(command(db, `select count(*) from public.families where id=fixture.id('family');`), '0');
      assert.equal(command(db, `select count(*) from public.family_messages where family_id=fixture.id('family');`), '0');
    });
    await check(`parent-family cascade first refuses late ${kind}`, async db => {
      const parent = session(db, 'parent-first'), late = session(db, 'member-second');
      await parent.run(actor('parent') + parentDelete);
      const pending = late.run(actor() + operation + 'commit;').catch(error => error);
      await waiting(db, late); await parent.run('commit;');
      const result = await pending;
      if (kind === 'RPC send') await denied(Promise.resolve(result));
      else if (kind === 'RPC reaction') {
        assert(result instanceof Error && /42501: (Message unavailable|An active household member(?:ship)? is required)/.test(result.message), String(result));
        assert(!/40P01|deadlock detected/.test(result.message), result.message);
      }
      else if (result instanceof Error) assert(/active household|Household unavailable/.test(result.message), result.message);
      assert.equal(command(db, `select count(*) from public.family_messages where family_id=fixture.id('family');`), '0');
    });
  }
  for (const unprotected of [true, false]) {
    await check(`reaction SELECT-row/family-delete inversion ${unprotected ? 'original deadlock control' : 'admission prevents deadlock'}`, async db => {
      // Gate the UPDATE before the normal statement scope trigger. Under the old
      // RPC the message is already locked here but family admission has not run.
      command(db, `create function fixture.reaction_update_gate() returns trigger language plpgsql security definer as $$
        begin perform pg_advisory_xact_lock(834,777); return null; end $$;
        create trigger aaa_synthetic_reaction_gate before update on public.family_messages for each statement
          execute function fixture.reaction_update_gate();`);
      if (unprotected) {
        command(db, `create or replace function public.toggle_family_message_reaction(p_message_id uuid,p_emoji text)
          returns public.family_messages language plpgsql security invoker set search_path='' as $$
          declare result public.family_messages; begin
            select * into result from public.family_messages where id=p_message_id and deleted_at is null for update;
            update public.family_messages set reactions=jsonb_set(reactions,array[p_emoji],to_jsonb(array[auth.uid()::text]))
              where id=p_message_id returning * into result;
            return result;
          end $$;`);
      }
      const gate=session(db,'reaction-window-gate'), reaction=session(db,'reaction-window'), deletion=session(db,'reaction-window-delete');
      await gate.run('begin; select pg_advisory_xact_lock(834,777);');
      const pendingReaction=reaction.run(actor('alice','authenticated','100ms') +
        `select (public.toggle_family_message_reaction(fixture.id('mixed-message'),'👍')).id; commit;`).catch(error=>error);
      await waiting(db,reaction,gate);
      const pendingDeletion=deletion.run(actor('parent','authenticated','10s')+parentDelete+'commit;').catch(error=>error);
      await waiting(db,deletion,reaction);
      await gate.run('commit;');
      const reactionResult=await pendingReaction, deletionResult=await pendingDeletion;
      if(unprotected) {
        assert(reactionResult instanceof Error && /40P01: deadlock detected/.test(reactionResult.message),String(reactionResult));
        assert(!(deletionResult instanceof Error),String(deletionResult));
      } else {
        assert(!(reactionResult instanceof Error),String(reactionResult));
        assert(!(deletionResult instanceof Error),String(deletionResult));
      }
      assert.equal(command(db,`select count(*) from public.families where id=fixture.id('family');`),'0');
      assert.equal(command(db,`select count(*) from public.family_messages where family_id=fixture.id('family');`),'0');
    });
  }
  await check('two parent deletes in different active families follow one lock order', async db => {
    command(db, `insert into public.family_members(family_id,user_id,display_name,role)
      values(fixture.id('other-family'),fixture.id('parent'),'Shared parent','parent');`);
    const first = session(db, 'delete-family-a'), second = session(db, 'delete-family-b');
    await first.run(actor('parent') + parentDelete);
    const pending = second.run(actor('parent') + `delete from public.families where id=fixture.id('other-family'); commit;`);
    await waiting(db, second); await first.run('commit;'); await pending;
    assert.equal(command(db, 'select count(*) from public.families;'), '0');
  });

  await check('authenticated RPC for family B locks scope before parent deletes family A', async db => {
    command(db, `insert into public.family_members(family_id,user_id,display_name,role)
      values(fixture.id('other-family'),fixture.id('parent'),'Shared parent','parent');`);
    const first = session(db, 'rpc-family-b'), deletion = session(db, 'delete-family-a');
    const target = `fixture.id('other-family')`;
    const member = `(select id from public.family_members where family_id=${target} and user_id=fixture.id('parent'))`;
    await first.run(actor('parent') + `select messaging_private.lock_actor(${target},${member},fixture.id('parent'));`);
    const pending = deletion.run(actor('parent') + parentDelete + 'commit;');
    await waiting(db, deletion);
    await first.run(`select (public.send_family_message(${target},public.ensure_family_conversation(${target}),
      ${member},fixture.id('parent'),'synthetic family B order')).id; commit;`);
    await pending;
    assert.equal(command(db, `select count(*) from public.family_messages where family_id=${target}
      and content='synthetic family B order';`), '1');
  });
  await check('unprotected main lifecycle reproduces the original ordinary UPDATE dirty-marker deadlock',
    db => membershipDeletionRace(db, { unprotected: true }));
  await check('ordinary authenticated membership UPDATE linearizes before queued parent deletion and preserves its dirty mark',
    db => membershipDeletionRace(db));
  await check('inverted service membership UPDATE receives a retry lock error rather than deadlocking',
    db => membershipDeletionRace(db, { role: 'service_role' }));
  await check('auth-account FK membership cascade receives a retry lock error under inverted parent deletion',
    db => membershipDeletionRace(db, { role: 'service_role', accountCascade: true }));
  await check('explicitly inverted authenticated manual row lock receives a retry lock error', async db => {
    command(db, `delete from public.family_model_dirty where family_id=fixture.id('family');`);
    const first = session(db, 'manual-member-first'), deletion = session(db, 'manual-parent-second');
    await first.run(actor('parent') + `select id from public.family_members where id=fixture.id('parent-member') for update;`);
    const pending = deletion.run(actor('parent', 'authenticated', '10s') + parentDelete + 'commit;').catch(error => error);
    await waiting(db, deletion, first);
    const result = await first.run(deactivateParent + 'commit;').catch(error => error);
    assert(result instanceof Error && /55P03: Household is changing\. Retry the membership change\./.test(result.message), String(result));
    assert(!(await pending instanceof Error));
    assert.equal(command(db, `select count(*) from public.families where id=fixture.id('family');`), '0');
  });
  await check('concurrent authenticated self-edits serialize without actor read-lock upgrades', async db => {
    const first = session(db, 'self-edit-first'), second = session(db, 'self-edit-second');
    await first.run(actor('parent') + `update public.family_members set display_name='First synthetic edit' where id=fixture.id('parent-member');`);
    const pending = second.run(actor('parent') + `update public.family_members set display_name='Second synthetic edit' where id=fixture.id('parent-member'); commit;`);
    await waiting(db, second, first);
    await first.run('commit;'); await pending;
    assert.equal(command(db, `select display_name from public.family_members where id=fixture.id('parent-member');`), 'Second synthetic edit');
  });
  await check('service membership write does not lock an unrelated family deletion', async db => {
    command(db, `update public.family_members set role='parent' where id=fixture.id('cross-member');
      delete from public.family_model_dirty where family_id=fixture.id('family');`);
    const first = session(db, 'service-target-family'), other = session(db, 'unrelated-family-delete');
    await first.run(actor('parent', 'service_role') + `update public.family_members set display_name='Synthetic server edit' where id=fixture.id('parent-member');`);
    await other.run(actor('cross') + `delete from public.families where id=fixture.id('other-family'); commit;`);
    assert.equal(command(db, `select count(*) from public.families where id=fixture.id('other-family');`), '0');
    await first.run('commit;');
    assert.equal(command(db, `select count(*) from public.family_model_dirty where family_id=fixture.id('family');`), '1');
  });
  await check('family deletion first gives a late authenticated membership edit a retry without partial mutation', async db => {
    const deletion = session(db, 'family-delete-first'), late = session(db, 'late-membership-edit');
    const original = command(db, `select display_name from public.family_members where id=fixture.id('alice-member');`);
    await deletion.run(actor('parent') + parentDelete);
    const result = await late.run(actor() + `update public.family_members set display_name='Late synthetic edit' where id=fixture.id('alice-member'); commit;`).catch(error => error);
    assert(result instanceof Error && /55P03: Household is changing\. Retry the membership change\./.test(result.message), String(result));
    await deletion.run('rollback;');
    assert.equal(command(db, `select display_name from public.family_members where id=fixture.id('alice-member');`), original);
  });
  console.log(`All ${completedChecks} synthetic concurrency checks passed; temporary databases removed.`);
} finally {
  for (const client of [...sessions]) client.close();
  for (const db of databases) execFileSync(executable('dropdb'), [...connection, '--force', db]);
}
