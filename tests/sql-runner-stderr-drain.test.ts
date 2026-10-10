import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync('scripts/verify-messaging-preserve-access.mjs', 'utf8');
const sessionSource = source.slice(source.indexOf('function session('), source.indexOf('\nconst actor ='));
const sqlState = '42501: An active household member is required';
const childProgram = `process.stdin.once('data', () => {
  process.stdout.write('synthetic-actor-id\\n', () => {
    process.stderr.write('ERROR: ${sqlState}\\n', () => process.exit(3));
  });
});`;

async function diagnostic(helperSource: string): Promise<string> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const context = vm.createContext({
    assert, randomUUID, setTimeout, clearTimeout, process,
    serial: 0, sessions: new Set(), connection: [],
    executable: () => process.execPath,
    // Never launch psql/createdb or read any database configuration. Execute
    // the actual helper against a real Node child whose stderr is delayed.
    spawn: (_command: string, _args: string[], options: SpawnOptions) => {
      child = spawn(process.execPath, ['-e', childProgram], {
        env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const current = child;
      // Pause after the helper installs its data listener, before child I/O.
      queueMicrotask(() => current.stderr.pause());
      current.once('exit', () => {
        resumeTimer = setTimeout(() => current.stderr.resume(), 100);
      });
      return current;
    },
  });
  const createSession = vm.runInContext(helperSource + '\nsession;', context) as
    (database: string, label: string) => { run: (sql: string) => Promise<string> };
  try {
    return await Promise.race([
      createSession('unused-synthetic-database', 'stderr-drain').run('synthetic input')
        .then(() => { throw new Error('Child exit was incorrectly accepted as success'); },
          (error: Error) => error.message),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Child diagnostic exceeded three seconds')), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    clearTimeout(resumeTimer);
    child?.stderr.resume();
    if (child && child.exitCode === null) child.kill();
  }
}

it('retains a SQLSTATE delivered after process exit and detects the original diagnostic loss', async () => {
  const original = await diagnostic(sessionSource.replace("child.on('close',", "child.on('exit',"));
  expect(original).toContain('psql exited 3');
  expect(original).not.toContain(sqlState);

  const corrected = await diagnostic(sessionSource);
  expect(corrected).toContain('psql exited 3');
  expect(corrected).toContain(sqlState);
  expect(corrected).toContain('synthetic-actor-id');
}, 8_000);
