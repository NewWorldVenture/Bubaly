import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceFiles, uncancelledAsyncEffects } from './helpers/jsx-a11y-scan';

// MAIN-F-D09. An effect that awaits and then sets state, with no way to know
// it has been superseded, lets an old answer overwrite a newer one: the gif
// picker could show "ca"'s results under "cat", the notification bell a count
// for the family just switched away from, the trip concierge the previous
// trip's conversation. Every such effect now carries a flag, an
// AbortController or a generation counter.

describe('an async effect knows when it is gone', () => {
  it('scans the real tree (guards the guard)', () => {
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it('none sets state from a superseded request', () => {
    const sites = sourceFiles().flatMap((f) => uncancelledAsyncEffects(f)).map((s) => `${s.file}:${s.line} ${s.what}`);
    expect(sites, 'guard it with `let active = true` … `return () => { active = false; }`, or an AbortController').toEqual([]);
  });
});

describe('the scanner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effects-'));
  const scan = (effect: string) => {
    const file = join(dir, `e${Math.random().toString(36).slice(2)}.tsx`);
    writeFileSync(file, `import { useEffect, useState } from 'react';\nexport function F({ id, load, fired }: any) {\n  const [x, setX] = useState(null);\n  ${effect}\n  return null;\n}\n`);
    return uncancelledAsyncEffects(file).length;
  };

  it('flags a set after an await or in a then', () => {
    expect(scan(`useEffect(() => { (async () => { const r = await load(id); setX(r); })(); }, [id]);`)).toBe(1);
    expect(scan(`useEffect(() => { load(id).then((r) => setX(r)); }, [id]);`)).toBe(1);
  });

  it('accepts a flag, an AbortController or a generation counter', () => {
    expect(scan(`useEffect(() => { let active = true; load(id).then((r) => { if (active) setX(r); }); return () => { active = false; }; }, [id]);`)).toBe(0);
    expect(scan(`useEffect(() => { const c = new AbortController(); load(id, c.signal).then(setX); return () => c.abort(); }, [id]);`)).toBe(0);
  });

  it('accepts a one-shot effect, which nothing can supersede', () => {
    expect(scan(`useEffect(() => { if (fired.current) return; fired.current = true; load(id).then(setX); }, []);`)).toBe(0);
  });

  it('ignores a set that happens before the first await', () => {
    expect(scan(`useEffect(() => { setX(null); const ch = load(id); ch.subscribe(async () => { await ch.track(); }); }, [id]);`)).toBe(0);
  });
});
