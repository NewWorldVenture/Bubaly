import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { sendFamilyMessage } from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';
import { createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './e2e/helpers/durable-session';

// This is a real GoTrue/PostgREST integration gate, never a modeled JWT test.
// Ordinary unit runs visibly skip it; an explicit but incomplete opt-in fails.
const gate = process.env.BUBALY_MESSAGES_AUTHENTICATED_RPC_GATE;
const integration = gate === undefined ? describe.skip : describe;
const nativeFetch = globalThis.fetch.bind(globalThis);
type Client = SupabaseClient<Database>;
function requireProof(value: unknown, message: string): asserts value {
  // Never include provider responses, credentials or private payloads in errors.
  if (!value) throw new Error(message);
}

async function requireOwnedStack() {
  const env = process.env;
  requireProof(gate === '1' && process.platform === 'linux' && env.CI === 'true'
    && env.GITHUB_ACTIONS === 'true' && env.GITHUB_JOB === 'e2e'
    && env.GITHUB_REPOSITORY?.toLowerCase() === 'newworldventure/bubaly'
    && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && env.RUNNER_TEMP && env.E2E_MESSAGES_PARALLEL_FINISHED === '1', 'Messaging gate requires its owned isolated CI phase.');
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DATABASE_URL', 'SUPABASE_DB_URL', 'PGHOST', 'PGPORT',
    'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS']) {
    requireProof(!Object.hasOwn(env, key), 'Messaging gate refuses connection overrides.');
  }
  requireProof(!env.PLAYWRIGHT_EXTERNAL_SERVER && !env.PLAYWRIGHT_PORT, 'Messaging gate refuses server overrides.');
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'TWILIO_ACCOUNT_SID']) {
    requireProof(!env[key], 'Messaging gate refuses outbound provider configuration.');
  }
  const origin = requireLocalOrigin(env.NEXT_PUBLIC_SUPABASE_URL);
  requireProof(['localhost', '127.0.0.1'].includes(new URL(origin).hostname) && new URL(origin).port === '54321'
    && env.SUPABASE_SERVICE_ROLE_KEY && env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'Messaging gate requires disposable loopback credentials.');
  const run = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const receipt = JSON.parse(readFileSync(join(env.RUNNER_TEMP, `bubaly-bill-stack-${run}.json`), 'utf8'));
  requireProof(receipt.run === run && /^[a-f0-9-]{36}$/.test(receipt.nonce)
    && Number.isFinite(receipt.startedAt) && Array.isArray(receipt.ids) && receipt.ids.length > 0
    && receipt.ids.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
    && receipt.ids.includes(receipt.db), 'Messaging gate requires captured immutable stack identity.');
  const docker = (args: string[], input?: string) => {
    const result = spawnSync('docker', ['--config', join(env.RUNNER_TEMP!, `bubaly-bill-docker-${run}`),
      '--host', 'unix:///var/run/docker.sock', ...args], { input, encoding: 'utf8', timeout: 15_000,
      maxBuffer: 1_000_000, env: { PATH: env.PATH, HOME: env.RUNNER_TEMP, NODE_ENV: 'test' } });
    requireProof(result.status === 0, 'Owned local Docker identity query failed.');
    return result.stdout.trim();
  };
  requireProof(/^project_id = "bubaly"$/m.test(readFileSync('supabase/config.toml', 'utf8')), 'Unexpected disposable project.');
  const ids = docker(['ps', '-aq', '--no-trunc', '--filter', 'label=com.supabase.cli.project=bubaly']).split(/\r?\n/).filter(Boolean).sort();
  requireProof(JSON.stringify(ids) === JSON.stringify(receipt.ids), 'Captured stack actors changed.');
  const rows = ids.map(id => JSON.parse(docker(['inspect', '--format',
    '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}', id])));
  requireProof(rows.every((row, i) => row.id === ids[i] && row.project === 'bubaly'
    && Date.parse(row.created) >= receipt.startedAt), 'Unowned container identity.');
  const db = rows.filter(row => row.id === receipt.db && row.name === '/supabase_db_bubaly'
    && row.running && /supabase\/postgres:15\./.test(row.image));
  const gateway = rows.filter(row => row.name === '/supabase_kong_bubaly' && row.running);
  requireProof(db.length === 1 && gateway.length === 1
    && gateway[0].ports['8000/tcp']?.some((binding: { HostPort: string }) => binding.HostPort === '54321'), 'Owned PG15/gateway identity missing.');
  requireProof(docker(['ps', '-q', '--no-trunc', '--filter', 'publish=54321']) === gateway[0].id, 'Loopback port is not the captured gateway.');
  const sql = (query: string) => docker(['exec', '-i', '--user', 'postgres', receipt.db, 'psql', '-X', '--no-password',
    '-q', '-t', '-A', '--host', '/var/run/postgresql', '--port', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'], query);
  requireProof(sql("select current_database() || ':' || current_setting('server_version_num')::integer / 10000;") === 'postgres:15'
    && env.BUBALY_BILL_STACK_MARKER === `${run}:${receipt.nonce}`
    && sql('select value from bill_e2e_private.marker;') === env.BUBALY_BILL_STACK_MARKER, 'Owned SQL marker mismatch.');
  for (const host of ['127.0.0.1', '::1']) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port: 3107 });
      const finish = (absent: boolean) => { socket.destroy(); if (absent) resolve(); else reject(new Error('Next listener absence is unproven.')); };
      socket.setTimeout(1500); socket.once('connect', () => finish(false)); socket.once('timeout', () => finish(false));
      socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
    });
  }
  return origin;
}

function client(origin: string, key: string, transport: typeof fetch = nativeFetch, jwt?: string): Client {
  return createClient<Database>(origin, key, { auth: { persistSession: false, autoRefreshToken: false },
    global: { ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}), fetch: (input, init) => {
      requireProof(new URL(input instanceof Request ? input.url : String(input)).origin === origin, 'Unexpected outbound messaging origin.');
      return transport(input, { ...init, redirect: 'error', signal: AbortSignal.any([
        AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : []),
      ]) });
    } },
  });
}

function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    const value = alphabet.indexOf(char); requireProof(value >= 0, 'Invalid disposable TOTP seed.');
    bits += value.toString(2).padStart(5, '0');
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bits.match(/.{8}/g)?.map(value => parseInt(value, 2)) ?? [])).update(counter).digest();
  return ((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Genuine RPC boundary was not reached.')), 15_000);
  })]); } finally { clearTimeout(timer); }
}

type Observation = { op: string; status: number; code?: string; empty?: boolean };
type Mode = 'actor JWT' | 'elevated executor with real actor identity';
async function fixture(origin: string) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const admin = client(origin, serviceKey), manager = client(origin, anon), actor = client(origin, anon);
  const accounts: OwnedAccount[] = [];
  const dispose = async () => {
    // Both account/household identities were generated here; no broad deletes.
    let failed = false;
    // Remove the manager's shared family before deleting the invited user.
    for (const account of accounts) { try { await account.dispose(); } catch { failed = true; } }
    requireProof(!failed, 'Owned messaging cleanup failed.');
  };
  try {
    const owner = await createOwnedAccount(origin, serviceKey); accounts.push(owner);
    const sender = await createOwnedAccount(origin, serviceKey); accounts.push(sender);
    for (const [db, account] of [[manager, owner], [actor, sender]] as const) {
      const login = await db.auth.signInWithPassword({ email: account.email, password: account.password });
      requireProof(!login.error && login.data.user?.id === account.userId, 'Owned real Auth sign-in failed.');
    }
    const enrollment = await manager.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Owned messaging manager' });
    requireProof(!enrollment.error && enrollment.data?.type === 'totp', 'Owned GoTrue TOTP enrollment failed.');
    const verified = await manager.auth.mfa.challengeAndVerify({ factorId: enrollment.data.id, code: totp(enrollment.data.totp.secret) });
    const level = await manager.auth.mfa.getAuthenticatorAssuranceLevel();
    requireProof(!verified.error && !level.error && level.data?.currentLevel === 'aal2', 'Owned manager genuine AAL2 failed.');
    const membership = await admin.from('family_members').insert({ family_id: owner.familyId, user_id: sender.userId,
      role: 'adult', display_name: 'Owned messaging actor', is_active: true }).select('id').single();
    const ownerMember = await manager.from('family_members').select('id').eq('family_id', owner.familyId).eq('user_id', owner.userId).single();
    requireProof(!membership.error && membership.data && !ownerMember.error && ownerMember.data, 'Owned memberships missing.');
    const memberId = membership.data.id;
    const conversation = await manager.rpc('create_family_conversation', { p_family_id: owner.familyId,
      p_participant_ids: [memberId, ownerMember.data.id], p_name: 'Owned RPC race', p_kind: 'direct' });
    requireProof(!conversation.error && conversation.data?.id, 'Genuine private conversation RPC failed.');
    const conversationId = conversation.data.id;
    const session = await actor.auth.getSession();
    requireProof(!session.error && session.data.session?.user.id === sender.userId, 'Owned actor session missing.');
    const jwt = session.data.session.access_token;
    async function active(value: boolean) {
      const changed = await manager.from('family_members').update({ is_active: value }).eq('id', memberId)
        .eq('family_id', owner.familyId).eq('user_id', sender.userId).select('id,is_active').single();
      requireProof(!changed.error && changed.data?.id === memberId && changed.data.is_active === value, 'Genuine manager membership commit failed.');
      const fresh = await manager.from('family_members').select('id,is_active').eq('id', memberId).eq('family_id', owner.familyId).eq('user_id', sender.userId).single();
      requireProof(!fresh.error && fresh.data?.is_active === value, 'Committed membership state was not freshly visible.');
    }
    async function snapshot() {
      const result = await admin.from('family_messages').select('*').eq('family_id', owner.familyId).eq('conversation_id', conversationId).order('id');
      requireProof(!result.error && result.data, 'Owned persisted-message read failed.');
      return result.data;
    }
    function attempt(mode: Mode, key: string, pause?: 'send_family_message' | 'find_family_message', now?: Date) {
      const entered = deferred(), release = deferred(), journal: Observation[] = [];
      let paused = false, memberRead = false, conversationRead = false;
      const transport: typeof fetch = async (input, init) => {
        const request = new Request(input, init), url = new URL(request.url), op = url.pathname.split('/').at(-1)!;
        if (request.method === 'POST' && ['send_family_message', 'find_family_message'].includes(op)) {
          const body = await request.clone().json();
          requireProof(body.p_family_id === owner.familyId && body.p_conversation_id === conversationId
            && body.p_member_id === memberId && body.p_user_id === sender.userId && body.p_idempotency_key === key,
          'RPC request did not retain its owned service identity.');
          if (op === pause && !paused) {
            requireProof(memberRead && conversationRead, 'RPC paused without genuine successful preflights.');
            if (pause === 'send_family_message') requireProof(journal.some(row => row.op === 'find_family_message' && row.status === 200 && row.empty), 'Send boundary requires a genuine empty duplicate probe.');
            paused = true; entered.resolve(); await bounded(release.promise);
          }
        }
        const response = await nativeFetch(request);
        if (url.pathname.startsWith('/rest/v1/')) {
          const body = await response.clone().json().catch(() => null);
          const single = Array.isArray(body) ? (body.length === 1 ? body[0] : null) : body;
          if (request.method === 'GET' && op === 'family_members') memberRead = response.ok && single?.id === memberId && single?.is_active === true && single?.user_id === sender.userId;
          if (request.method === 'GET' && op === 'family_conversations') conversationRead = response.ok && single?.id === conversationId && single?.is_archived === false;
          journal.push({ op, status: response.status, ...(body?.code === '42501' ? { code: '42501' } : {}),
            ...(op === 'find_family_message' ? { empty: Array.isArray(body) && body.length === 0 } : {}) });
        }
        // The actual response, including error and private rows, is untouched.
        return response;
      };
      const db = client(origin, mode === 'actor JWT' ? anon : serviceKey, transport, mode === 'actor JWT' ? jwt : undefined);
      const scope: ServiceScope = { db, familyId: owner.familyId, userId: sender.userId, memberId,
        role: 'adult', actorKind: 'member', tz: 'UTC', idempotencyKey: key, ...(now ? { now } : {}) };
      return { entered, release, journal, run: () => sendFamilyMessage(scope, { conversationId, content: 'Owned private RPC sentinel' }) };
    }
    return { active, snapshot, attempt, dispose, memberId, senderId: sender.userId, conversationId };
  } catch {
    await dispose(); throw new Error('Owned messaging real-Auth fixture setup failed.');
  }
}

integration('authenticated messaging RPC removal boundaries (explicit isolated opt-in)', () => {
  let origin: string;
  beforeAll(async () => { origin = await requireOwnedStack(); }, 60_000);
  const modes: Mode[] = ['actor JWT', 'elevated executor with real actor identity'];
  for (const mode of modes) {
    for (const scenario of ['healthy durable retry', 'removal before first send', 'removal before cached find'] as const) {
      it(`${mode}: ${scenario}`, async () => {
        // Production services log raw DB failures. Keep those in memory here and
        // assert only their expected operation labels, never attach their data.
        const labels: string[] = [];
        const log = vi.spyOn(console, 'error').mockImplementation((label: unknown) => {
          labels.push(typeof label === 'string' && /^\[service:[a-z]+\] [a-z ]+$/.test(label) ? label : 'unexpected service diagnostic');
        });
        let owned: Awaited<ReturnType<typeof fixture>> | undefined;
        let pending: ReturnType<typeof sendFamilyMessage> | undefined;
        let release: (() => void) | undefined;
        try {
          owned = await fixture(origin);
          const key = `owned-rpc-${randomUUID()}`;
          const first = owned.attempt(mode, key);
          if (scenario !== 'removal before first send') {
            const sent = await first.run();
            requireProof(sent.ok && sent.data.id && sent.data.conversation_id === owned.conversationId
              && sent.data.sender_id === owned.senderId
              && sent.data.content === 'Owned private RPC sentinel', 'Healthy real RPC send did not persist the owned identity.');
            expect(first.journal.some(row => row.op === 'send_family_message' && row.status === 200)).toBe(true);
          }
          const original = await owned.snapshot();
          expect(original.length).toBe(scenario === 'removal before first send' ? 0 : 1);
          const later = new Date(Date.now() + 11 * 60_000);
          if (original.length) requireProof(Date.parse(original[0].created_at) < later.getTime() - 10 * 60_000, 'Durable retry must be beyond the old duplicate time window.');
          if (scenario === 'healthy durable retry') {
            const retry = owned.attempt(mode, key, undefined, later), result = await retry.run();
            requireProof(result.ok && result.data.id === original[0].id, 'Durable key did not recover the original message.');
            expect(retry.journal.some(row => row.op === 'find_family_message' && row.status === 200 && row.empty === false)).toBe(true);
            expect(retry.journal.some(row => row.op === 'send_family_message')).toBe(false);
          } else {
            const op = scenario === 'removal before first send' ? 'send_family_message' : 'find_family_message';
            const raced = owned.attempt(mode, key, op, later); release = raced.release.resolve;
            pending = raced.run();
            // Attach rejection handling immediately while the manager commits.
            void pending.catch(() => {});
            await bounded(raced.entered.promise);
            await owned.active(false);
            raced.release.resolve();
            const refused = await pending; pending = undefined;
            expect(!refused.ok && !('data' in refused)).toBe(true);
            expect(raced.journal.some(row => row.op === op && row.status === 403 && row.code === '42501')).toBe(true);
            if (op === 'send_family_message') expect(raced.journal.some(row => row.op === 'find_family_message' && row.status === 403 && row.code === '42501')).toBe(true);
            if (op === 'find_family_message') expect(raced.journal.some(row => row.op === 'send_family_message')).toBe(false);
            expect(JSON.stringify(await owned.snapshot()) === JSON.stringify(original)).toBe(true);
            await owned.active(true);
            const restored = await owned.attempt(mode, key, undefined, later).run();
            requireProof(restored.ok && (original.length === 0 || restored.data.id === original[0].id), 'Reactivation healthy control failed.');
          }
          const final = await owned.snapshot();
          expect(final.length).toBe(1);
          if (original.length) expect(JSON.stringify(final) === JSON.stringify(original)).toBe(true);
          expect(labels.every(label => ['[service:messages] duplicate probe failed', '[service:messages] send failed'].includes(label))).toBe(true);
          if (scenario === 'healthy durable retry') expect(labels.length).toBe(0);
        } finally {
          release?.();
          if (pending) await pending.catch(() => {});
          try {
            if (owned) { try { await owned.active(true); } finally { await owned.dispose(); } }
          } finally { log.mockRestore(); }
        }
      }, 120_000);
    }
  }
});
