// The API sweep, the session maker and the storage audit create accounts,
// write objects and call every route with a service-role key in hand. They are
// meant for a local stack only, and each says so by refusing any other target
// before it does anything. This keeps that true for every script in the
// harness, including the next one, and runs the refusal rather than reading it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'scripts/api-audit';
const scripts = [...readdirSync(DIR).filter((f) => f.endsWith('.mjs')).map((f) => join(DIR, f)), 'scripts/page-audit-session.mjs'];
const reachesOut = (src: string) => /SERVICE_ROLE_KEY|ANON_KEY|createClient\(|fetch\(|--base/.test(src);
// sweep.mjs takes the sessions file sessions.mjs wrote, and refuses the base
// URL recorded in it; the others take --base or read the Supabase URL.
const sessions = join(mkdtempSync(join(tmpdir(), 'audit-harness-')), 'api-sessions.json');
writeFileSync(sessions, JSON.stringify({ base: 'https://www.bubaly.com', callers: {} }));
const argsFor = (file: string) => (file.endsWith('/sweep.mjs') ? [sessions] : ['--base', 'https://www.bubaly.com']);

describe('the audit harness refuses anything but a local stack', () => {
  it('finds the harness (guards the guard)', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(4);
  });

  it.each(scripts.filter((f) => reachesOut(readFileSync(f, 'utf8'))))('%s refuses a production target before doing anything', (file) => {
    const run = spawnSync(process.execPath, [file, ...argsFor(file)], {
      env: {
        PATH: process.env.PATH,
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'not-a-key',
        SUPABASE_SERVICE_ROLE_KEY: 'not-a-key',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(run.status, `${file} exited ${run.status}: ${run.stderr}`).toBe(1);
    expect(run.stderr).toMatch(/^Refusing: /m);
  });
});
