import { describe, expect, it, vi } from 'vitest';
import { FleetCliError, parseFleetCommand, readFleetResponseBody, runFleetCli, validateFleetRemoteUrl } from '../scripts/claude-fleet.mjs';
import { initializeFleetDatabase } from '../scripts/claude-fleet-init.mjs';
import { CLAUDE_FLEET_SCHEMA } from '@/lib/claude-fleet/schema';
import type { Client, ResultSet } from '@libsql/client';

const SECRET = 'synthetic-manager-secret-do-not-log';
const DATABASE_TOKEN = 'synthetic-database-token-do-not-log';
const MANAGER_ENV = {
  NODE_ENV: 'test' as const,
  CLAUDE_FLEET_MANAGER_URL: 'https://synthetic.vercel.app/api/admin/claude-fleet',
  CLAUDE_FLEET_MANAGER_SECRET: SECRET,
};
const DATABASE_ENV = {
  NODE_ENV: 'test' as const,
  CLAUDE_FLEET_DATABASE_URL: 'libsql://synthetic.turso.io',
  CLAUDE_FLEET_DATABASE_AUTH_TOKEN: DATABASE_TOKEN,
};

describe('Claude fleet management CLI', () => {
  const validCommands: Array<[string[], Record<string, string>]> = [
    [['submit', 'Synthetic', 'probe:1'], { action: 'submit', alias: 'Synthetic', requestKey: 'probe:1' }],
    [['continue', 'Synthetic', 'probe:2', 'job_one'], { action: 'continue', alias: 'Synthetic', requestKey: 'probe:2', previousJobId: 'job_one' }],
    [['status', 'job_one'], { action: 'status', jobId: 'job_one' }],
    [['result', 'job_one'], { action: 'result', jobId: 'job_one' }],
    [['cancel', 'job_one'], { action: 'cancel', jobId: 'job_one' }],
    ...['list', 'pause', 'resume', 'stop', 'tick'].map((action): [string[], Record<string, string>] => [[action], { action }]),
  ];
  it.each(validCommands)('parses only the privileged command schema: %j', (args, expected) => {
    expect(parseFleetCommand(args)).toEqual(expected);
  });

  const invalidCommands: string[][] = [
    [], ['submit'], ['submit', 'Synthetic', 'request', '--token', SECRET], ['list', 'extra'],
    ['continue', 'Synthetic', 'request'], ['status', '../outside'], ['submit', '../account', 'request'],
    ['submit', 'Synthetic', 'request with spaces'], ['submit', 'Synthetic', 'request', '--prompt', 'arbitrary work'],
    ['edit', 'Synthetic', 'request'], ['--help', 'extra'],
  ];
  it.each(invalidCommands.map((args): [string[]] => [args]))('rejects invalid or extra arguments without echoing input: %j', (args) => {
    expect(() => parseFleetCommand(args)).toThrow('invalid_arguments');
  });

  it.each([
    'http://synthetic.vercel.app/api/fleet', 'https://user:password@synthetic.vercel.app/api/fleet',
    'https://synthetic.vercel.app/api/fleet?secret=value', 'https://synthetic.vercel.app/api/fleet#secret',
    'https://localhost/api/fleet', 'https://localhost./api/fleet', 'https://a.localhost/api/fleet',
    'https://127.0.0.1/api/fleet', 'https://2130706433/api/fleet', 'https://10.0.0.1/api/fleet',
    'https://[::1]/api/fleet', 'https://a.local/api/fleet', 'https://internal/api/fleet',
    'https://a.internal/api/fleet', ' https://synthetic.vercel.app/api/fleet',
    'https://synthetic.vercel.app/api/\nfleet',
  ])('rejects insecure, credential-bearing or local manager endpoints: %s', (url) => {
    expect(() => validateFleetRemoteUrl(url)).toThrow('invalid_remote_url');
  });

  it('posts a bounded command with an environment bearer and forbids redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ job: { id: 'job_one', status: 'queued' }, reused: false }, { status: 202 }));
    const result = await runFleetCli(['submit', 'Synthetic', 'probe:1'], { env: MANAGER_ENV, fetchImpl });
    expect(result).toEqual({ job: { id: 'job_one', status: 'queued' }, reused: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([
      MANAGER_ENV.CLAUDE_FLEET_MANAGER_URL,
      expect.objectContaining({
        method: 'POST', redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: 'submit', alias: 'Synthetic', requestKey: 'probe:1' }),
      }),
    ]);
  });

  it('strips credential fields and redacts tokens echoed inside public output', async () => {
    const result = await runFleetCli(['result', 'job_one'], {
      env: MANAGER_ENV,
      fetchImpl: async () => Response.json({ job: { id: 'job_one', claimToken: 'fencing-token', apiKey: 'synthetic-key' },
        result: `${SECRET} sk-ant-api03-synthetic Bearer synthetic-authorization`, authToken: 'not-public' }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('fencing-token');
    expect(serialized).not.toContain('synthetic-key');
    expect(serialized).not.toContain('synthetic-authorization');
    expect(serialized).not.toContain('not-public');
    expect(result).toEqual({ job: { id: 'job_one' }, result: '[redacted] [redacted] Bearer [redacted]' });
  });

  it('normalizes transport and HTTP errors without returning secrets', async () => {
    await expect(runFleetCli(['list'], { env: MANAGER_ENV, fetchImpl: async () => { throw new Error(SECRET); } })).rejects.toMatchObject({ code: 'manager_request_failed', message: 'manager_request_failed' });
    await expect(runFleetCli(['list'], { env: MANAGER_ENV, fetchImpl: async () => new Response(SECRET, { status: 401 }) })).rejects.toMatchObject({ code: 'manager_unauthorized' });
    await expect(runFleetCli(['list'], { env: MANAGER_ENV, fetchImpl: async () => new Response(SECRET, { status: 503 }) })).rejects.toMatchObject({ code: 'manager_request_rejected' });
  });

  it('rejects malformed and oversized responses', async () => {
    for (const raw of ['not-json', '[]', 'null', JSON.stringify({ result: 'x'.repeat(131_073) })]) {
      await expect(runFleetCli(['list'], { env: MANAGER_ENV, fetchImpl: async () => new Response(raw) })).rejects.toMatchObject({ code: 'invalid_manager_response' });
    }
  });

  it('fails before fetch without a valid command or configured bearer', async () => {
    const fetchImpl = vi.fn();
    await expect(runFleetCli(['list'], { env: { ...MANAGER_ENV, CLAUDE_FLEET_MANAGER_SECRET: '' }, fetchImpl })).rejects.toThrow(FleetCliError);
    await expect(runFleetCli(['list'], { env: { ...MANAGER_ENV, CLAUDE_FLEET_MANAGER_SECRET: 'Bearer\nsecret' }, fetchImpl })).rejects.toThrow(FleetCliError);
    await expect(runFleetCli(['status', '../bad'], { env: MANAGER_ENV, fetchImpl })).rejects.toThrow(FleetCliError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shows help without reading credentials or contacting an endpoint', async () => {
    const fetchImpl = vi.fn();
    expect(await runFleetCli(['--help'], { env: { NODE_ENV: 'test' }, fetchImpl })).toMatchObject({ usage: expect.stringContaining('continue') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels streamed response immediately when a chunk exceeds the byte bound', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(131_073)); }, cancel,
    });
    await expect(readFleetResponseBody(body, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_manager_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('counts bytes across chunks and rejects overflow without reading the full body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536));
        controller.enqueue(new Uint8Array(65_537));
      }, cancel,
    });
    await expect(readFleetResponseBody(body, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_manager_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled body when the request deadline aborts', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const read = readFleetResponseBody(body, controller.signal);
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: 'invalid_manager_response' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

describe('explicit remote fleet database initialization', () => {
  function syntheticClient(paused = 1) {
    const result: ResultSet = {
      columns: ['schema_version', 'paused'], columnTypes: ['INTEGER', 'INTEGER'],
      rows: [{ length: 2, 0: 1, 1: paused, schema_version: 1, paused }],
      rowsAffected: 0, lastInsertRowid: undefined,
      toJSON: () => ({ columns: ['schema_version', 'paused'], rows: [[1, paused]] }),
    };
    return {
      batch: vi.fn(async () => []),
      execute: vi.fn(async () => result),
      close: vi.fn(),
    } satisfies Pick<Client, 'batch' | 'execute' | 'close'>;
  }

  it('requires the explicit confirmation argument before creating a client', async () => {
    const createClientImpl = vi.fn();
    for (const args of [[], ['--yes'], ['--confirm', 'extra'], ['--confirm', '--url', 'https://synthetic.turso.io']]) {
      await expect(initializeFleetDatabase(args, { env: DATABASE_ENV, createClientImpl })).rejects.toMatchObject({ code: 'explicit_confirmation_required' });
    }
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  it.each(['file:synthetic.db', ':memory:', 'http://synthetic.turso.io', 'https://localhost', 'libsql://127.0.0.1', 'libsql://user:password@synthetic.turso.io', 'libsql://synthetic.turso.io?authToken=secret'])('refuses local or credential-bearing database URLs: %s', async (url) => {
    const createClientImpl = vi.fn();
    await expect(initializeFleetDatabase(['--confirm'], { env: { ...DATABASE_ENV, CLAUDE_FLEET_DATABASE_URL: url }, createClientImpl })).rejects.toMatchObject({ code: 'invalid_remote_url' });
    expect(createClientImpl).not.toHaveBeenCalled();
  });

  it('executes explicit schema DDL as one write batch using only injected synthetic client', async () => {
    const client = syntheticClient();
    const createClientImpl = vi.fn(() => client);
    const result = await initializeFleetDatabase(['--confirm'], { env: DATABASE_ENV, createClientImpl });
    expect(createClientImpl).toHaveBeenCalledWith({ url: `${DATABASE_ENV.CLAUDE_FLEET_DATABASE_URL}`, authToken: DATABASE_TOKEN });
    expect(client.batch).toHaveBeenCalledWith([...CLAUDE_FLEET_SCHEMA], 'write');
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ initialized: true, schemaVersion: 1, paused: true });
    expect(JSON.stringify(result)).not.toContain(DATABASE_TOKEN);
  });

  it('reports existing pause state without asserting that initialization pauses an active fleet', async () => {
    const client = syntheticClient(0);
    expect(await initializeFleetDatabase(['--confirm'], { env: DATABASE_ENV, createClientImpl: () => client })).toMatchObject({ paused: false });
  });

  it('normalizes schema failures and still closes the synthetic client', async () => {
    const client = syntheticClient();
    client.batch.mockRejectedValueOnce(new Error(DATABASE_TOKEN));
    await expect(initializeFleetDatabase(['--confirm'], { env: DATABASE_ENV, createClientImpl: () => client })).rejects.toMatchObject({ code: 'schema_initialization_failed', message: 'schema_initialization_failed' });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('never exposes a credential in a client-close failure', async () => {
    const client = syntheticClient();
    client.close.mockImplementationOnce(() => { throw new Error(DATABASE_TOKEN); });
    await expect(initializeFleetDatabase(['--confirm'], { env: DATABASE_ENV, createClientImpl: () => client })).rejects.toMatchObject({ code: 'schema_initialization_failed', message: 'schema_initialization_failed' });
  });
});
