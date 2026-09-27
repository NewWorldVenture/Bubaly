import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Found by the API sweep (scripts/api-audit): with no AI key, eighteen AI
// routes told the family "the AI engine isn't set up" with a 503, and the rest
// let the provider's "OpenAI API key is not configured" throw reach a generic
// catch — a 500 "failed to generate", or a 502 "temporarily unavailable",
// which says try again to someone for whom trying again cannot work. One
// (health/coach) did check, but only the environment, so a key saved in
// Admin → AI Engine was reported as missing.
//
// isAIConfigured() (lib/ai/provider.ts) knows every place a key can come from.
// Every route that calls the provider asks it first, unless it has a real
// answer without the model — named below, with what it answers.

const FALLS_BACK_WITHOUT_A_MODEL: Record<string, string> = {
  'app/api/ai/journal/route.ts': 'answers an evergreen journaling prompt',
  'app/api/ai/savings/route.ts': 'answers data-driven savings suggestions from the family’s own budgets',
  'app/api/behavior/insight/route.ts': 'answers an insight computed from the behaviour data',
};

function routes(dir = 'app/api'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    return name === 'route.ts' ? [full.split(path.sep).join('/')] : [];
  });
}

const callers = routes().filter((f) => /\bresolveProvider\(/.test(readFileSync(f, 'utf8')));

describe('an AI route says when the engine is not set up', () => {
  it('finds the routes that call the provider', () => {
    expect(callers.length).toBeGreaterThanOrEqual(30);
  });

  it.each(callers.filter((f) => !(f in FALLS_BACK_WITHOUT_A_MODEL)))('%s asks isAIConfigured() before calling the provider', (file) => {
    const src = readFileSync(file, 'utf8');
    const asked = src.search(/\bisAIConfigured\(\)/);
    expect(asked, `${file} never asks isAIConfigured()`).toBeGreaterThan(-1);
    expect(asked, `${file} asks only after calling the provider`).toBeLessThan(src.search(/\bresolveProvider\(\)/));
  });

  it('checks no key source by hand: the environment alone misses a key saved in Admin → AI Engine', () => {
    for (const file of callers) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/if\s*\(\s*!process\.env\.(OPENAI|ANTHROPIC)_API_KEY/);
    }
  });

  it('keeps the fallback list honest: each named route still calls the provider and still has a fallback', () => {
    for (const file of Object.keys(FALLS_BACK_WITHOUT_A_MODEL)) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toMatch(/\bresolveProvider\(/);
      expect(src, file).toMatch(/fallback/i);
    }
  });
});
