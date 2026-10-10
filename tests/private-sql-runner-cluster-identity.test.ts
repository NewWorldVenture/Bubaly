import { basename, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyApprovalPrivateRead } from '../scripts/verify-approval-private-read.mjs';
import { verifyAiCopyPrivateRead } from '../scripts/verify-ai-copy-private-read.mjs';

const harness = vi.hoisted(() => ({ identity: '', calls: [] as { name: string; args: string[] }[] }));
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((file: string, args: string[]) => {
    const name = basename(file).replace(/\.exe$/, '');
    harness.calls.push({ name, args });
    if (name !== 'psql') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('show data_directory; show port; show server_version;')) {
      return { status: 0, stdout: harness.identity, stderr: '' };
    }
    const isAi = args.some((arg) => arg.endsWith('ai-copy-private-read.sql'));
    if (args.includes('skip_guard=true')) {
      const message = args.includes('old_inactive=true')
        ? 'FAIL: inactive owner cannot read private tool receipt'
        : isAi ? 'FAIL: unrelated child cannot read private request' : 'FAIL: unrelated child cannot read private draft';
      return { status: 1, stdout: '', stderr: message };
    }
    return { status: 0, stderr: '', stdout: isAi
      ? 'AI copy assertion count: 98\nAI copy private read and household quota assertions PASS\nROLLBACK\n'
      : 'approval private read: actual-role ownership, review, revocation and inherited restriction assertions PASS\nROLLBACK\n' };
  }),
}));

const dataDir = resolve('synthetic-runner-cluster');
const options = { postgresBin: resolve('synthetic-pg-bin'), expectedDataDir: dataDir, port: 55443 };
beforeEach(() => { harness.calls.length = 0; harness.identity = `${dataDir}\n5432\n17.10\n`; });

// These are subprocess-boundary identity checks, not substitute SQL/RLS tests.
// The hosted standalone steps execute the real PostgreSQL role contracts.
describe.each([
  ['approval', verifyApprovalPrivateRead],
  ['AI copies', verifyAiCopyPrivateRead],
] as const)('%s runner cluster identity', (_name, verify) => {
  it('accepts an explicitly declared translated port and keeps all connections on loopback', () => {
    const receipt = verify({ ...options, expectedServerPort: 5432 });
    expect(receipt).toMatchObject({ host: '127.0.0.1', port: '55443', serverPort: '5432' });
    expect(harness.calls.some((call) => call.name === 'createdb')).toBe(true);
    expect(harness.calls.some((call) => call.name === 'dropdb')).toBe(true);
    for (const call of harness.calls) expect(call.args.slice(0, 4)).toEqual(['-h', '127.0.0.1', '-p', '55443']);
  });

  it('keeps the same-port default for a direct local cluster', () => {
    harness.identity = `${dataDir}\n55443\n17.10\n`;
    expect(verify(options).serverPort).toBe('55443');
  });

  it.each([
    ['undeclared translation', {}, `${dataDir}\n5432\n17.10\n`],
    ['different server port', { expectedServerPort: 5432 }, `${dataDir}\n5433\n17.10\n`],
    ['different data directory', { expectedServerPort: 5432 }, `${resolve('unowned-cluster')}\n5432\n17.10\n`],
    ['missing identity', { expectedServerPort: 5432 }, ''],
    ['incomplete identity', { expectedServerPort: 5432 }, `${dataDir}\n5432\n`],
    ['malformed port', { expectedServerPort: 5432 }, `${dataDir}\n5432junk\n17.10\n`],
  ])('refuses %s before creating a database', (_case, overrides, identity) => {
    harness.identity = identity;
    expect(() => verify({ ...options, ...overrides })).toThrow('no database was created');
    expect(harness.calls.map((call) => call.name)).toEqual(['psql']);
  });

  it.each([0, 65536, '5432junk', ''])('rejects invalid expected server port %s before connecting', (expectedServerPort) => {
    expect(() => verify({ ...options, expectedServerPort })).toThrow('Explicit PostgreSQL');
    expect(harness.calls).toEqual([]);
  });
});
