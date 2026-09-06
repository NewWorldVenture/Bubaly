// Which AI surfaces leave a record, and which are still silent.
//
// §33: "a failure in the chat assistant or the daily brief is invisible after
// the request ends." Both of those now open an `ai_requests` row through
// `withAiRequest`. The rest are enumerated below, so what remains is a list
// someone chose rather than a list nobody counted — and so the next surface has
// to be added here deliberately.
//
// The count is the point. `ai_requests` has had `model`, `prompt_tokens`,
// `completion_tokens`, `latency_ms` and `error` from the start, and
// `recordModelCall` has always filled them; it just needs a `requestId`, and
// almost nothing opened a row.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' ? []
      : e.isDirectory() ? walk(`${dir}/${e.name}`)
      : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []);

/** Files that reach a model without opening a request row. */
function silentSurfaces(): string[] {
  const found: string[] = [];
  for (const file of ['app', 'lib'].flatMap(walk)) {
    if (file.startsWith('lib/ai/observability')) continue;
    const src = readFileSync(file, 'utf8');
    const callsModel = /from '@\/lib\/ai\/provider'/.test(src);
    if (!callsModel) continue;
    const observed = /withAiRequest\(/.test(src) || /requestId/.test(src);
    if (!observed) found.push(file);
  }
  return found.sort();
}

// Surfaces that reach a model and record nothing about the run. Each is a real
// gap: when one of these fails, a family asking "why did Bubaly stop doing X"
// gets a console line on a server nobody is reading.
const SILENT = new Set<string>(silentSurfaces());

describe('§33 the surfaces a family would ask about are observed', () => {
  it('the surfaces adopted so far all open a request row', () => {
    // Named individually. "Fewer silent surfaces" is not a property anyone can
    // check; "the meal planner records which model produced this week's plan" is.
    for (const [file, feature] of [
      ['app/api/ai/meals/plan/route.ts', "feature: 'meals.plan'"],
      ['app/api/ai/insights/route.ts', 'feature: `insights.${kind}`'],
      ['app/api/ai/assist/route.ts', "feature: 'assist'"],
      ['app/api/ai/weekly-briefing/route.ts', "feature: 'briefing.weekly'"],
      ['app/api/ai/health/coach/route.ts', "feature: 'health.coach'"],
      ['app/api/ai/habits/route.ts', "feature: 'habits.coach'"],
      ['app/api/ai/savings/route.ts', "feature: 'finances.savings'"],
      ['app/api/ai/journal/route.ts', "feature: 'journal.prompt'"],
      ['app/api/ai/home/diagnose/route.ts', "feature: 'home.diagnose'"],
      ['app/api/ai/home/find-pro/route.ts', "feature: 'home.find-pro'"],
      ['app/api/ai/home/forecast/route.ts', "feature: 'home.forecast'"],
      ['app/api/ai/home/utility-savings/route.ts', "feature: 'home.utility-savings'"],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must open a request row`).toContain('withAiRequest(');
      expect(src, `${file} must name its surface`).toContain(feature);
      expect(src, `${file} must record the model that answered`).toMatch(/obs\.used\((?:completion|done)\.model/);
    }
  });

  it('the daily brief opens a request row', () => {
    const src = readFileSync('app/api/ai/briefing/route.ts', 'utf8');
    expect(src).toContain('withAiRequest(');
    expect(src).toContain("feature: `briefing.${type}`");
    // The brief swallows provider errors BY DESIGN (they can carry family
    // context). Recording has to happen inside, or the swallow erases it.
    expect(src).toMatch(/withAiRequest\([\s\S]{0,800}obs\.used\(/);
  });

  it('the chat assistant records the stream failures it handles itself', () => {
    const src = readFileSync('app/api/ai/chat/route.ts', 'utf8');
    expect(src).toContain('withAiRequest(');
    expect(src).toContain("feature: 'chat.assistant'");
    // It catches its own stream errors and falls back, so a wrapper's catch
    // never fires — `obs.failed` is the only way the evidence survives.
    expect(src).toContain('obs.failed(streamErr');
    expect(src).toContain('obs.failed(fallbackErr)');
  });

  it('utility savings records the failure it swallows, before it swallows it', () => {
    // This route answers 200 either way: on a provider failure it drops the
    // narrative and returns the deterministic findings alone, with `aiUsed:
    // false`. That flag cannot distinguish "the model errored" from "no API key
    // is configured", so the swallow has to happen OUTSIDE the wrapper or the
    // evidence is gone. Ordering is the whole assertion.
    const src = readFileSync('app/api/ai/home/utility-savings/route.ts', 'utf8');
    // The wrapper body — everything from the call to the `aiUsed = true` that
    // follows it — must not swallow: a catch in there settles the row
    // `completed` for a call that never produced anything. Slicing to
    // `obs.used(` instead would miss a catch placed after it, which is exactly
    // where a well-meaning `try { ... } catch { return null }` lands.
    const wrapped = src.slice(src.indexOf('withAiRequest('), src.indexOf('aiUsed = true'));
    expect(wrapped, 'the wrapper body must not swallow its own failure').not.toContain('catch');
    // And the fallback that drops the narrative sits after it, so the wrapper
    // has already recorded by the time the route decides to answer 200 anyway.
    expect(src.indexOf('recommendations = null; // fall back'))
      .toBeGreaterThan(src.indexOf('obs.used('));
  });

  it('a partial stream is recorded as partial, not as a clean completion', () => {
    const src = readFileSync('app/api/ai/chat/route.ts', 'utf8');
    expect(src).toContain('partial: Boolean(content)');
  });

  it('the record says which model ANSWERED, not which one the caller intended', () => {
    // A caller naming its own constant records the model it meant to use, which
    // is exactly the wrong answer after a fallback or a config change.
    const provider = readFileSync('lib/ai/provider.ts', 'utf8');
    expect(provider).toContain('model: this.model');
    expect(readFileSync('app/api/ai/briefing/route.ts', 'utf8')).toContain('completion.model');
  });

  it('neither of the two is in the silent set any more', () => {
    expect([...SILENT]).not.toContain('app/api/ai/briefing/route.ts');
    expect([...SILENT]).not.toContain('app/api/ai/chat/route.ts');
  });
});

describe('what is deliberately NOT adopted', () => {
  it('leaves the public gift assistant alone, with a reason', () => {
    // /api/ai/gift is UNAUTHENTICATED by design — givers are not signed in, so
    // there is no user scope to build one from. Attributing a stranger's
    // request to the family's own `ai_requests` ledger is a product decision
    // about whose AI budget a gift-link visitor spends, not a mechanical
    // conversion, so it is left out rather than guessed at.
    const src = readFileSync('app/api/ai/gift/route.ts', 'utf8');
    expect(src).not.toContain('withAiRequest(');
    expect(src).toContain('createServiceClient()');
  });
});

describe('the remaining silence is counted, not ignored', () => {
  it('does not grow', () => {
    // A ceiling, not a target. It exists so the next surface that reaches a
    // model has to be a deliberate addition rather than one more file nobody
    // noticed. Lower it as surfaces adopt withAiRequest; never raise it without
    // saying why in the same change.
    // Set to the exact count, not a round number above it: slack in a ratchet is
    // room for new silent surfaces to slip in green. Lower it every time a
    // surface adopts withAiRequest — 52 → 48 → 44 → 42 → 40 → 36 so far.
    const CEILING = 36;
    expect(
      SILENT.size,
      `these reach a model and record nothing:\n  ${[...SILENT].join('\n  ')}\n` +
      'Wrap the call in withAiRequest(), or raise CEILING deliberately and say why.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('is actually scanning something, so the ceiling is not vacuously satisfied', () => {
    // A broken scanner returns an empty set and this file goes quietly green
    // while every surface is silent — the exact failure mode it exists to catch.
    expect(SILENT.size).toBeGreaterThan(0);
    expect([...SILENT].some((f) => f.startsWith('app/api/ai/'))).toBe(true);
  });
});
