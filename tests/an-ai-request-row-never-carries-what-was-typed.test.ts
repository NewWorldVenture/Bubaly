// P-10 review (#585). `ai_requests` is readable by every active member of the
// family (0250's SELECT policy). Once P-10 let feature rows be filed at all,
// every surface that handed `withAiRequest` the person's own words — the
// assistant's message, the chef request, a marketplace question, a chore
// prompt, a post topic, a trip destination — would have shown them to the rest
// of the household. The rule is now structural: the recorded text is a fixed
// label at every call site. This scan holds every call site to it; the
// assistant's behaviour (the model still gets the message) is pinned in
// tests/assistant-engine.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

type Site = { file: string; line: number; text: string | null };

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of [...walk('app'), ...walk('lib')]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bwithAiRequest\(/g)) {
      const before = src.slice(Math.max(0, m.index - 30), m.index);
      if (/function\s+$/.test(before)) continue; // the definition itself
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index)) || src.slice(lineStart, m.index).includes('//')) continue; // prose
      const after = src.slice(m.index, m.index + 1500);
      const spec = after.match(/\{\s*feature:[^\n]*?\btext:\s*([^,}]+)/);
      sites.push({ file, line: src.slice(0, m.index).split('\n').length, text: spec ? spec[1].trim() : null });
    }
  }
  return sites;
}

describe('the text an AI request row records', () => {
  const sites = callSites();

  it('finds every call site (a scan that finds nothing proves nothing)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(35);
  });

  it('is a fixed label at every call site: a plain string literal or a catalogue string', () => {
    const offenders = sites
      .filter((s) => s.text === null || !/^('[^'`$]*'|t\('[^']+'\))$/.test(s.text))
      .map((s) => `${s.file}:${s.line} text: ${s.text ?? '(no inline { feature, text } spec)'}`);
    expect(offenders).toEqual([]);
  });

  it('never names the variables that carry what a person typed', () => {
    const typed = /\b(message|input\.message|request|prompt|q|topic|input\.topic|destination|input\.destination)\b/;
    expect(sites.filter((s) => s.text && typed.test(s.text) && !s.text.startsWith("'"))).toEqual([]);
  });
});
