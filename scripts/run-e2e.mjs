import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { e2eServerEnv } from './e2e-server-env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = process.env.PLAYWRIGHT_PORT ?? '3107';
const env = e2eServerEnv(process.env, port);

function run(modulePath, args) {
  const result = spawnSync(process.execPath, [modulePath, ...args], {
    cwd: root,
    env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer(server) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready (code ${server.exitCode}).`);
    }

    try {
      const response = await fetch(`http://localhost:${port}/robots.txt`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }

    await sleep(250);
  }

  throw new Error('Timed out waiting for the Next.js E2E server.');
}

async function stopServer(server) {
  if (server.exitCode !== null) return;

  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');

  await Promise.race([
    exited,
    sleep(5_000).then(() => {
      if (server.exitCode !== null) return;

      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        server.kill('SIGKILL');
      }
    }),
  ]);
}

if (process.env.PLAYWRIGHT_SKIP_BUILD !== '1') {
  const buildStatus = run('node_modules/next/dist/bin/next', ['build', '--webpack']);
  if (buildStatus !== 0) process.exit(buildStatus);
}

const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-p', port],
  { cwd: root, env, stdio: 'inherit' },
);

let testStatus = 1;
try {
  await waitForServer(server);
  testStatus = run('node_modules/@playwright/test/cli.js', ['test', ...process.argv.slice(2)]);
} finally {
  await stopServer(server);
}

process.exit(testStatus);
