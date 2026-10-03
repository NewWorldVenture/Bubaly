import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// F19. A route checks the allowance and then files its request through
// `withAiRequest`; when another of the family's requests takes the last slot
// in between, the admission (0477) refuses before the model runs. A route's
// own catch used to read that as an outage ("failed", "temporarily
// unavailable", 5xx). Every route under app/api that files through
// `withAiRequest` and answers a 5xx from a catch must first ask
// `admissionRefusalResponse`, which answers it as the gate does (429
// `allowance_exceeded` with the cap, in the reader's language).
//
// The routes that map the refusal themselves are named; a route whose catches
// answer no 5xx (it falls back to a deterministic answer) needs nothing.
const MAPS_IT_ITSELF = new Set(['app/api/ai/route.ts', 'app/api/ai/chat/route.ts', 'app/api/ai/gift/route.ts']);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === 'route.ts' ? [path] : [];
  });
}

/** Every `catch (x) { … }` body in `src` that answers a 5xx JSON response. */
function fiveHundredCatches(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\}\s*catch\s*\((\w+)\)\s*\{/g)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    while (depth && i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice((m.index ?? 0) + m[0].length, i - 1);
    if (body.includes('NextResponse.json') && /status:\s*5\d\d/.test(body)) out.push(body);
  }
  return out;
}

function libs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? libs(path) : name.endsWith('.ts') ? [path] : [];
  });
}

// A route can file through a library rather than call the wrapper itself (the
// social generator, the chat engine): the admission's refusal reaches its catch
// all the same. Every lib module that calls `withAiRequest(`, as its `@/` import.
const FILING_LIBS = libs('lib')
  .filter((f) => f !== join('lib', 'ai', 'observability.ts') && readFileSync(f, 'utf8').includes('withAiRequest('))
  .map((f) => `@/${f.replace(/\\/g, '/').replace(/\.ts$/, '')}`);

function filesThroughTheWrapper(src: string): boolean {
  return src.includes('withAiRequest(') || FILING_LIBS.some((m) => src.includes(`from '${m}'`));
}

describe('every AI route answers the admission refusal as the allowance (F19)', () => {
  const files = routes('app/api').filter((f) => filesThroughTheWrapper(readFileSync(f, 'utf8')));

  it('finds the routes it polices, including one that files through a library', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(FILING_LIBS).toContain('@/lib/social/ai');
    expect(files).toContain(join('app', 'api', 'social', 'ai', 'route.ts'));
  });

  it('each 5xx catch asks admissionRefusalResponse first', () => {
    const missing: string[] = [];
    for (const file of files) {
      if (MAPS_IT_ITSELF.has(file)) continue;
      const catches = fiveHundredCatches(readFileSync(file, 'utf8'));
      catches.forEach((body, i) => {
        const first = body.trimStart().split('\n')[0];
        if (!/admissionRefusalResponse\(/.test(first)) missing.push(`${file} (catch ${i + 1})`);
      });
    }
    expect(missing, 'answer the admission refusal before the route\'s own 5xx').toEqual([]);
  });

  it('the routes that map it themselves still do', () => {
    for (const file of MAPS_IT_ITSELF) expect(readFileSync(file, 'utf8')).toMatch(/AiRequestOverAllowance|code: 'allowance_exceeded'/);
  });
});
