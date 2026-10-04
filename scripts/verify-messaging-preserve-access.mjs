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

function session(db, label) {
  const app = `messaging-synthetic-${process.pid}-${++serial}-${label}`;
  const child = spawn(executable('psql'), [
    ...connection, '-d', db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  ], { env: { ...process.env, PGAPPNAME: app }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', pending = null;
  child.stdout.on('data', chunk => { output += chunk; finish(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.on('exit', code => {
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

const actor = (who = 'alice', role = 'authenticated') => `
  begin; set local statement_timeout = '12s'; set local deadlock_timeout = '100ms';
  select set_config('request.jwt.claim.sub', ${role === 'service_role' ? "''" : `fixture.id('${who}')::text`}, true);
  set local role ${role};`;
const send = text => `select (public.send_family_message(fixture.id('family'), fixture.id('mixed'),
  fixture.id('alice-member'), fixture.id('alice'), '${text}')).id;`;
const directUpdate = `update public.family_messages set content = 'synthetic updated'
  where id = fixture.id('mixed-message');`;
const directDelete = `delete from public.family_conversations where id = fixture.id('mixed');`;
const parentDelete = `delete from public.families where id = fixture.id('family');`;
async function waiting(db, target) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (command(db, `select count(*) from pg_stat_activity where application_name = '${target.app}' and wait_event_type = 'Lock';`) === '1') return;
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
    console.log('PASS ' + label);
  } finally {
    for (const client of [...sessions]) client.close();
    execFileSync(executable('dropdb'), [...connection, '--force', db]);
    databases.delete(db);
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

  for (const [kind, operation] of [['RPC send', send('synthetic parent order')], ['raw message UPDATE', directUpdate], ['raw conversation DELETE', directDelete]]) {
    await check(`${kind} first linearizes before parent-family cascade`, async db => {
      const first = session(db, 'member-first'), parent = session(db, 'parent-second');
      await first.run(actor() + operation);
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
      else if (result instanceof Error) assert(/active household|Household unavailable/.test(result.message), result.message);
      assert.equal(command(db, `select count(*) from public.family_messages where family_id=fixture.id('family');`), '0');
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
  console.log('All 17 synthetic concurrency checks passed; temporary databases removed.');
} finally {
  for (const client of [...sessions]) client.close();
  for (const db of databases) execFileSync(executable('dropdb'), [...connection, '--force', db]);
}
