import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `readAllAsQuery` reports a failed OR TRUNCATED read as `data: null` plus an
// error — deliberately, so it can sit inside a `settleAll([...])` batch and let
// each caller's own error branch key on it (lib/supabase/read-all.ts:139-141).
//
// A call site that destructures only `{ data }` therefore turns a truncated
// read into an EMPTY ARRAY. On a money read that is not a short list, it is a
// balance of zero. Audit C4-S4-02 found exactly that on two routes that feed
// the figure to an LLM, which then wrote coaching prose about a child's money
// that was computed from nothing — under a comment that said, verbatim, "Money,
// so a quietly truncated read is a wrong balance, not a short list."
//
// `tests/no-limit-above-the-row-cap.test.ts` already enforces the read's SHAPE.
// Nothing enforced that its ERROR is consumed, which is why thirteen call sites
// drifted. This is that guard.

const ROOTS = ['app', 'lib', 'components'];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (['.ts', '.tsx'].includes(extname(entry.name))) out.push(path);
  }
  return out;
}

/**
 * Destructuring positions in a `settleAll([...])`/await result that bind
 * `readAllAsQuery`'s output. We look for the binding pattern rather than parse
 * TS: a site that names `error` anywhere in its own destructure is consuming it.
 */
function unconsumedSites(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (!/readAllAsQuery/.test(line)) return;
    // The destructure sits at the head of the statement, which may be lines above.
    const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
    const destructure = /const\s*\[([\s\S]*?)\]\s*=\s*await\s+settleAll|const\s*\{([\s\S]*?)\}\s*=\s*await\s+readAllAsQuery/.exec(window);
    if (!destructure) return;
    const bound = destructure[1] ?? destructure[2] ?? '';
    if (!/\berror\b/.test(bound)) hits.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  return hits;
}

describe('a truncated read is never silently an empty array (C4-S4-02)', () => {
  const files = ROOTS.flatMap((r) => walk(resolve(r), []));

  it('the matcher finds readAllAsQuery call sites at all', () => {
    // A matcher that silently matched nothing would make this rule vacuous —
    // the defect class this repository is most prone to.
    const withCalls = files.filter((f) => readFileSync(f, 'utf8').includes('readAllAsQuery'));
    expect(withCalls.length).toBeGreaterThan(0);
  });

  it('the two AI money routes consume the read error', () => {
    // These are the sites C4-S4-02 named: a child's balance, fed to a model.
    for (const f of [
      'app/api/ai/wallet/route.ts',
      'app/api/ai/wallet/child/[childId]/route.ts',
    ]) {
      const source = readFileSync(resolve(f), 'utf8');
      expect(source, `${f} must bind readAllAsQuery's error`).toMatch(/data:\s*txns,\s*error:\s*txnsError/);
      expect(source, `${f} must branch on it`).toMatch(/if\s*\(txnsError\)/);
      expect(unconsumedSites(source), `${f} has an unconsumed readAllAsQuery`).toEqual([]);
    }
  });
});
