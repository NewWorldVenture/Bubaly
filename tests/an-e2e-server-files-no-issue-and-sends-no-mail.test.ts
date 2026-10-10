// The E2E server's real flows reach their real side effects. Submitting
// feedback runs onFeedbackSubmitted, which files a GitHub issue and emails the
// super admins (the built-in allowlist included) whenever those providers'
// keys are configured. The suite's browser routing never sees those requests,
// because the server makes them. And the server's environment is the caller's,
// plus whatever `.env*` files Next loads from the checkout.
//
// scripts/e2e-server-env.mjs blanks the two providers' keys for the server
// both entry points start (scripts/run-e2e.mjs and playwright.config.ts). Every
// value below is synthetic, and no request leaves the test: fetch is stubbed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { OUTBOUND_PROVIDER_KEYS_OFF, e2eServerEnv } from '../scripts/e2e-server-env.mjs';

const { onFeedbackSubmitted } = await import('@/lib/feedback/notify');

const KEYS = ['GITHUB_TOKEN', 'GITHUB_FEEDBACK_TOKEN', 'RESEND_API_KEY'] as const;
const SYNTHETIC = {
  GITHUB_TOKEN: 'synthetic-github-token-not-real',
  GITHUB_FEEDBACK_TOKEN: 'synthetic-feedback-token-not-real',
  RESEND_API_KEY: 'synthetic-resend-key-not-real',
};
const REPO = 'synthetic-owner/synthetic-repo';

describe('the E2E server environment', () => {
  it('blanks both providers’ keys, whatever the caller holds, and changes nothing else', () => {
    const env = e2eServerEnv({ ...SYNTHETIC, GITHUB_FEEDBACK_REPO: REPO, CRON_SECRET: 'ci-only-fixture' }, '3107');
    for (const key of KEYS) expect(env[key], key).toBe('');
    expect(env).toMatchObject({
      GITHUB_FEEDBACK_REPO: REPO,
      CRON_SECRET: 'ci-only-fixture',
      PLAYWRIGHT_PORT: '3107',
      PLAYWRIGHT_EXTERNAL_SERVER: '1',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3107',
    });
  });

  it('is what both entry points start the server with', async () => {
    const saved = process.env.PLAYWRIGHT_EXTERNAL_SERVER;
    delete process.env.PLAYWRIGHT_EXTERNAL_SERVER;
    try {
      vi.resetModules();
      const { default: config } = await import('../playwright.config');
      const server = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
      expect(server?.env).toMatchObject(OUTBOUND_PROVIDER_KEYS_OFF);
    } finally {
      if (saved === undefined) delete process.env.PLAYWRIGHT_EXTERNAL_SERVER; else process.env.PLAYWRIGHT_EXTERNAL_SERVER = saved;
    }
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('scripts/run-e2e.mjs', 'utf8')).toMatch(/^const env = e2eServerEnv\(process\.env, port\);$/m);
  });

  // `next start` loads `.env*` through @next/env, which fills only the keys the
  // process does not already have. The blank holds only if an empty string
  // counts as having one, so this runs the installed loader, in a child
  // process (it caches the first environment it sees), over a synthetic
  // `.env.local` and `.env.production` that set every key.
  it('holds over a checkout’s .env files, as the installed Next loader reads them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-env-'));
    try {
      const lines = Object.entries(SYNTHETIC).map(([k, v]) => `${k}=${v}`).join('\n');
      writeFileSync(join(dir, '.env.local'), `${lines}\n`);
      writeFileSync(join(dir, '.env.production'), `${lines}\n`);
      const probe = `
        const { loadEnvConfig } = require('@next/env');
        loadEnvConfig(process.argv[1], false, { info() {}, error() {} });
        process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(KEYS)}.map((k) => [k, process.env[k] ?? null]))));`;
      const read = (env: Record<string, string | undefined>) => {
        const run = spawnSync(process.execPath, ['-e', probe, dir], { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        return JSON.parse(run.stdout) as Record<string, string | null>;
      };
      const base = { PATH: process.env.PATH, NODE_ENV: 'production' };
      // Control: without the blanks, the files' synthetic keys are loaded.
      expect(read(base)).toEqual(SYNTHETIC);
      // With them, every key stays blank.
      expect(read(e2eServerEnv(base, '3107'))).toEqual({ GITHUB_TOKEN: '', GITHUB_FEEDBACK_TOKEN: '', RESEND_API_KEY: '' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a submitted idea, on a server started that way', () => {
  const saved: Record<string, string | undefined> = {};
  let requested: string[];

  beforeEach(() => {
    for (const k of [...KEYS, 'GITHUB_FEEDBACK_REPO', 'GITHUB_REPO']) saved[k] = process.env[k];
    requested = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      requested.push(url);
      if (url === `https://api.github.com/repos/${REPO}/issues`) {
        return new Response(JSON.stringify({ number: 7, html_url: `https://github.com/${REPO}/issues/7`, title: 't', state: 'open', state_reason: null, body: null, updated_at: '2026-10-10T00:00:00Z', labels: [] }), { status: 201 });
      }
      if (url === 'https://api.resend.com/emails') return new Response('{"id":"synthetic"}', { status: 200 });
      throw new Error(`unexpected request in a hermetic test: ${url}`);
    }));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  async function submit(env: Record<string, string | undefined>) {
    for (const k of KEYS) process.env[k] = env[k];
    process.env.GITHUB_FEEDBACK_REPO = REPO;
    const db = createInMemorySupabase();
    db.seed('feedback_ideas', [{ id: 'idea-1', title: 'Synthetic idea' }]);
    await onFeedbackSubmitted(db as never, { id: 'idea-1', title: 'Synthetic idea', kind: 'idea' });
    return requested.map((u) => new URL(u).host);
  }

  it('files an issue and sends mail when the keys are configured (control)', async () => {
    const hosts = await submit({ ...SYNTHETIC });
    expect(hosts).toContain('api.github.com');
    expect(hosts).toContain('api.resend.com');
  });

  it('files no issue and sends no mail with the E2E server’s environment', async () => {
    expect(await submit(e2eServerEnv({ ...SYNTHETIC }, '3107'))).toEqual([]);
  });
});
