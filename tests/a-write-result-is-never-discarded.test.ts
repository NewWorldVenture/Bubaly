import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  it('every remaining site is accepted, with exact counts', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'app/**/*.tsx' 'lib/**/*.ts' 'components/**/*.tsx'", { encoding: 'utf8' })
      .trim().split('\n');
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = countDiscarded(readFileSync(f, 'utf8'));
      if (n) found[f] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ACCEPTED).map(([f, v]) => [f, v.count])));
  });

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
