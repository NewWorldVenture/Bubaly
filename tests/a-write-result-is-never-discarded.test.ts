import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { between } from './helpers/source-order';
import { setAIConfig } from '@/lib/ai/settings';

/**
 * Audit C1-S9-76 — writes whose result was discarded outright:
 * `await db.from(t).insert(…);`, not even the error bound.
 *
 * The write ratchets (C1-S9-50/61) count updates and deletes that bind the
 * error but not the rows. This is the class below them: nothing bound at all.
 * Twenty-three sites. The one that mattered most was the platform AI config.
 */
type Outcome = { data?: unknown; error?: unknown };
function settingsDb(read: Outcome, write: Outcome = {}) {
  const writes: unknown[] = [];
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: read.error ? null : (read.data ?? null), error: read.error ?? null }) }) }),
      upsert: async (row: unknown) => { writes.push(row); return { error: write.error ?? null }; },
    }),
  };
  return { db: db as unknown as Parameters<typeof setAIConfig>[0], writes };
}
const STORED = { value: { provider: 'openai', model: 'gpt-x', openaiKey: 'sk-stored', anthropicKey: null } };

describe('the platform AI config is not wiped, and a failed save is not reported saved (C1-S9-76)', () => {
  it('a refused read throws before writing — it used to null a key the admin left blank', async () => {
    const { db, writes } = settingsDb({ error: { message: 'timeout' } });
    await expect(setAIConfig(db, { provider: 'openai', model: 'gpt-y', openaiKey: '' }, 'admin-1')).rejects.toBeTruthy();
    expect(writes, 'wrote a config built from an empty read').toEqual([]);
  });

  it('a refused write throws, so the admin action reports it', async () => {
    const { db } = settingsDb({ data: STORED }, { error: { message: 'rls' } });
    await expect(setAIConfig(db, { provider: 'openai', model: 'gpt-y', openaiKey: '' }, 'admin-1')).rejects.toBeTruthy();
    const action = readFileSync('app/(app)/admin/ai/actions.ts', 'utf8');
    expect(action).toMatch(/try \{\s*await setAIConfig\([\s\S]*?\} catch \(e\) \{[\s\S]*?return \{ ok: false/);
  });

  it('a blank key keeps the stored one (not over-tightened: the ordinary save still works)', async () => {
    const { db, writes } = settingsDb({ data: STORED });
    await setAIConfig(db, { provider: 'openai', model: 'gpt-y', openaiKey: '' }, 'admin-1');
    expect(writes).toHaveLength(1);
    expect((writes[0] as { value: { openaiKey: string; model: string } }).value).toMatchObject({ openaiKey: 'sk-stored', model: 'gpt-y' });
  });
});

describe('no write result is discarded outright (C1-S9-76)', () => {
  // Each remaining site, with its reason. A new one fails until it binds its
  // result or is classified; a classified one that disappears fails too.
  const ACCEPTED: Record<string, { count: number; why: string }> = {
    'lib/contact-center/sms-ingress.ts': {
      count: 1,
      why: 'an insert raced by design; the next line re-reads the row, and only that readback grants emission',
    },
    'lib/guardian/callbacks.ts': {
      count: 2,
      why: 'LOCKED by the parallel session (LIBRARY-10D7AA8F3175); audited, not edited — see C1-S9-61',
    },
  };

  const strip = (s: string) => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*\/\/.*$/gm, '')
    .replace(/(?<=[ \t])\/\/[^\n]*/g, '');

  /** `await <client>.from(…)…insert|upsert|update|delete(…);` as a statement of its own. */
  function countDiscarded(code: string): number {
    const src = strip(code);
    let n = 0;
    for (const m of src.matchAll(/\bawait\s+((?:[\w.]+(?:\(\))?\s*)\.from\()/g)) {
      let k = m.index - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      if (k >= 0 && !';{}'.includes(src[k])) continue; // bound, returned, or an argument
      const stmt = src.slice(m.index, src.indexOf(';', m.index));
      if (!/\.(insert|upsert|update|delete)\(/.test(stmt)) continue;
      if (stmt.includes('.then(') || stmt.includes('.catch(')) continue;
      n++;
    }
    return n;
  }

  function sourceFiles(cwd: string): string[] {
    // Let Git interpret pathspecs directly on every OS. NUL output preserves
    // spaces/Unicode without Git's quoted-filename escaping or shell parsing.
    return execFileSync('git', ['ls-files', '-z', '--', 'app/**/*.ts', 'app/**/*.tsx', 'lib/**/*.ts', 'components/**/*.tsx'], { cwd, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  }

  function discardedWrites(cwd: string): Record<string, number> {
    const found: Record<string, number> = {};
    for (const f of sourceFiles(cwd)) {
      const n = countDiscarded(readFileSync(path.join(cwd, f), 'utf8'));
      if (n) found[f] = n;
    }
    return found;
  }

  const acceptedCounts = Object.fromEntries(Object.entries(ACCEPTED).map(([f, v]) => [f, v.count]));

  it('every remaining site is accepted, with exact counts', () => {
    expect(discardedWrites(path.resolve(__dirname, '..'))).toEqual(acceptedCounts);
  });

  function withTrackedFixture(run: (cwd: string) => void) {
    const temporaryRoot = path.resolve(tmpdir());
    const cwd = mkdtempSync(path.join(temporaryRoot, 'discarded-write scanner-é-'));
    const discarded = "async function write() { await db.from('t').insert({}); }\n";
    const fixture: Record<string, string> = {
      'app/(app)/plain.ts': 'export const value = 1;\n',
      'app/(app)/space é.tsx': 'export const value = 1;\n',
      'lib/資料/ordinary.ts': 'export const value = 1;\n',
      'components/test/child panel.tsx': 'export const value = 1;\n',
      'lib/contact-center/sms-ingress.ts': discarded,
      'lib/guardian/callbacks.ts': discarded.repeat(2),
      // These are tracked but outside the original four pathspecs.
      'app/outside.js': discarded,
      'components/test/excluded.ts': discarded,
      'lib/資料/excluded.tsx': discarded,
      'tests/excluded.ts': discarded,
    };
    try {
      for (const [file, code] of Object.entries(fixture)) {
        const target = path.join(cwd, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, code);
      }
      execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', cwd]);
      execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', '.'], { cwd });
      writeFileSync(path.join(cwd, 'app/(app)/untracked.ts'), discarded);
      run(cwd);
    } finally {
      // Remove only the directory this fixture created inside the temp root.
      expect(path.dirname(path.resolve(cwd))).toBe(temporaryRoot);
      expect(path.basename(cwd)).toMatch(/^discarded-write scanner-é-/);
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('enumerates the same tracked source scope with spaces and Unicode paths', () => {
    withTrackedFixture(cwd => {
      expect(sourceFiles(cwd).sort()).toEqual([
        'app/(app)/plain.ts', 'app/(app)/space é.tsx', 'lib/資料/ordinary.ts',
        'components/test/child panel.tsx', 'lib/contact-center/sms-ingress.ts', 'lib/guardian/callbacks.ts',
      ].sort());
      expect(discardedWrites(cwd)).toEqual(acceptedCounts);
    });
  });

  it('still rejects a newly tracked unaccepted discarded write', () => {
    withTrackedFixture(cwd => {
      expect(discardedWrites(cwd)).toEqual(acceptedCounts);
      const extra = 'app/(app)/new discarded é.tsx';
      writeFileSync(path.join(cwd, extra), "async function write() { await db.from('t').insert({}); }\n");
      execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', extra], { cwd });
      const found = discardedWrites(cwd);
      expect(found).toEqual({ ...acceptedCounts, [extra]: 1 });
      expect(() => expect(found).toEqual(acceptedCounts)).toThrow();
    });
  });

  for (const count of [0, 3]) {
    it(`still rejects an accepted path whose discarded-write count changes to ${count}`, () => {
      withTrackedFixture(cwd => {
        expect(discardedWrites(cwd)).toEqual(acceptedCounts);
        writeFileSync(path.join(cwd, 'lib/guardian/callbacks.ts'), "async function write() { await db.from('t').insert({}); }\n".repeat(count));
        const found = discardedWrites(cwd);
        expect(found['lib/guardian/callbacks.ts'] ?? 0).toBe(count);
        expect(() => expect(found).toEqual(acceptedCounts)).toThrow();
      });
    });
  }

  it('the scanner sees the shape it names, and not a bound or returned write', () => {
    const fixture = countDiscarded;
    expect(fixture("async function f() {\n  await db.from('t').insert({ a: 1 });\n}")).toBe(1);
    expect(fixture("async function f() {\n  await createClient().from('t').upsert({ a: 1 });\n}")).toBe(1);
    expect(fixture("async function f() {\n  const { error } = await db.from('t').insert({ a: 1 });\n}")).toBe(0);
    expect(fixture("async function f() {\n  return await db.from('t').insert({ a: 1 });\n}")).toBe(0);
    expect(fixture("async function f() {\n  const r =\n    await db.from('t').insert({ a: 1 });\n}")).toBe(0);
    expect(fixture("async function f() {\n  await db.from('t').select('id');\n}")).toBe(0);
    expect(fixture("async function f() {\n  await mutate(() => db.from('t').insert({}));\n}")).toBe(0);
  });
});

describe('a refused AEO insert after the clear is named, not silent (C1-S9-76)', () => {
  it('the insert error is thrown into the catch that logs it', () => {
    const src = readFileSync('app/(app)/admin/marketing/content/actions.ts', 'utf8');
    const tryBlock = between(src, "const { error: clearError } = await supabase.from('marketing_aeo_questions')", '} catch (aeoError) {');
    expect(tryBlock).toContain("const { error: aeoInsertError } = await supabase.from('marketing_aeo_questions').insert(");
    expect(tryBlock).toContain('if (aeoInsertError) throw aeoInsertError;');
  });
});
