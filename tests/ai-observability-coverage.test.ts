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

// The only four exports of `lib/ai/provider` that hand back an AIProvider.
// Importing anything else from that module — a `ToolSpec` type, `describeAIError`,
// `isAIConfigured` — does not put a file anywhere near a model.
const PROVIDER_PRODUCERS = ['resolveProvider', 'getProvider', 'providerFromConfig', 'OpenAIProvider'];

/**
 * Every import statement in `src` that ends at `@/lib/ai/provider`, found by
 * scanning BACK from the specifier to the `import` that opens the statement.
 *
 * A forward regex cannot do this. `import\s+(type\s+)?\{[\s\S]*?\}\s+from '…provider'`
 * starts matching at the FIRST `import {` in the file and lazily extends to the
 * provider specifier, swallowing every import in between — so a file whose first
 * import happens to be `import type {…}` is read as type-only no matter what it
 * actually imports from the provider. That misread `lib/ai/assistant-engine.ts`,
 * which imports `resolveProvider` and calls `provider.runTools`, as unable to
 * reach a model at all.
 */
function providerImports(src: string): string[] {
  // Leading newline so a provider import on line 1 is still found.
  const text = `\n${src}`;
  const out: string[] = [];
  const re = /from '@\/lib\/ai\/provider'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = text.lastIndexOf('\nimport ', m.index);
    if (start >= 0) out.push(text.slice(start + 1, m.index));
  }
  return out;
}

/** Whether a file can actually obtain a provider, as opposed to naming a type. */
export function reachesAModel(src: string): boolean {
  return providerImports(src).some((clause) => {
    if (/^import\s+type\b/.test(clause)) return false;
    const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
    return inner
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n && !/^type\s/.test(n))
      .some((n) => PROVIDER_PRODUCERS.includes(n.split(/\s/)[0]));
  });
}

/** Files that reach a model without opening a request row. */
function silentSurfaces(): string[] {
  const found: string[] = [];
  for (const file of ['app', 'lib'].flatMap(walk)) {
    if (file.startsWith('lib/ai/observability')) continue;
    const src = readFileSync(file, 'utf8');
    if (!reachesAModel(src)) continue;
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
      ['app/api/ai/notes/route.ts', "feature: 'notes.assist'"],
      ['app/api/ai/relationship/route.ts', "feature: 'relationship.digest'"],
      ['app/api/ai/meals/nutrition/route.ts', "feature: 'meals.nutrition'"],
      ['app/api/ai/chef/route.ts', "feature: 'meals.chef'"],
      ['app/api/ai/wallet/route.ts', "feature: 'wallet.coach'"],
      ['app/api/ai/wallet/child/[childId]/route.ts', "feature: 'wallet.coach.child'"],
      ['app/api/ai/resolve-conflict/route.ts', "feature: 'calendar.resolve-conflict'"],
      ['lib/social/ai.ts', 'feature: `social.${input.kind}`'],
      ['app/api/recipes/suggest/route.ts', "feature: 'recipes.suggest'"],
      ['app/api/recipes/transform/route.ts', 'feature: `recipes.${actionId}`'],
      ['app/api/ai/trip/route.ts', "feature: 'travel.research'"],
      ['app/api/ai/auto/accident/route.ts', "feature: 'auto.accident'"],
      ['app/api/ai/invest/route.ts', "feature: 'invest.mentor'"],
      ['app/api/behavior/insight/route.ts', "feature: 'behavior.insight'"],
      ['app/(app)/dashboard/contacts/[id]/actions.ts', "feature: 'contacts.reconnect'"],
      ['app/(app)/dashboard/paperwork/actions.ts', "feature: 'paperwork.draft-reply'"],
      ['app/(app)/marketplace/assistant-actions.ts', "feature: 'marketplace.assistant'"],
    ] as const) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must open a request row`).toContain('withAiRequest(');
      expect(src, `${file} must name its surface`).toContain(feature);
      // `provider.model` is the same fact as `completion.model` — a helper that
      // resolved its provider first names it that way. What is still excluded is
      // a caller naming its own MODEL constant, which records the model it meant
      // to use rather than the one that answered.
      expect(src, `${file} must record the model that answered`).toMatch(/obs\.used\((?:completion|done|provider)\.model/);
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

  it('the assistant engine observes both transports, and the stream from inside', () => {
    const src = readFileSync('lib/ai/assistant-engine.ts', 'utf8');
    // Two transports over one engine, named separately: a family reporting "it
    // stops halfway" can be told which one they were on, and the two break
    // differently.
    expect(src).toContain("feature: 'assistant.turn'");
    expect(src).toContain("feature: 'assistant.stream'");

    // THE load-bearing one. `withAiRequest` settles when its body resolves, and
    // `createAssistantStream` returns a ReadableStream before a single token
    // exists — so a wrapper placed around the CALL would settle every row
    // `completed` for a turn that had not begun. It has to be inside `start`.
    const stream = src.slice(src.indexOf('export function createAssistantStream'));
    const startAt = stream.indexOf('async start(controller)');
    const wrapAt = stream.indexOf('withAiRequest(');
    expect(startAt, 'createAssistantStream must still open a stream').toBeGreaterThan(-1);
    expect(wrapAt, 'the stream must open a request row').toBeGreaterThan(-1);
    expect(wrapAt, 'the wrapper must sit INSIDE start(), not around the stream')
      .toBeGreaterThan(startAt);

    // A turn that answers and then fails to save is one the family meets again
    // as a conversation missing its last exchange. Both transports record it,
    // and as partial rather than failed — they did get their answer.
    const persistFailures = src.match(/obs\.failed\(new Error\(`Turn not persisted/g) ?? [];
    expect(persistFailures, 'both transports must record a lost turn').toHaveLength(2);
    expect(src).toContain("obs.failed(new Error(`Turn not persisted: ${persisted.error}`), { partial: true })");

    // A stream that breaks after text reached the family is partial; one that
    // breaks with nothing shown, and whose fallback also fails, is a plain
    // failure. Recording both the same way would erase the difference.
    expect(src).toContain('obs.failed(streamErr, { partial: true })');
    expect(src).toContain('obs.failed(fallbackErr)');
    expect(src).not.toContain('obs.failed(fallbackErr, { partial: true })');
  });

  it('a canned sentence that reads like coaching is recorded as a failure', () => {
    // The subtlest shape of all. When the parenting coach replies without JSON,
    // `/api/behavior/insight` answers 200 with "Keep logging — patterns will
    // sharpen over time." — a warm, plausible sentence a parent cannot tell from
    // real coaching. The other empty-200 routes at least LOOK empty.
    const src = readFileSync('app/api/behavior/insight/route.ts', 'utf8');
    // The canned line is chosen after the failure is recorded, not instead of it.
    const failedAt = src.indexOf('obs.failed(');
    const cannedAt = src.indexOf("insight ?? 'Keep logging");
    expect(failedAt, 'the unusable reply must be recorded').toBeGreaterThan(-1);
    expect(cannedAt, 'the canned line must still be what the parent sees').toBeGreaterThan(failedAt);
  });

  it('a 200 carrying an empty answer is recorded as a failure too', () => {
    // The fourth shape of silence, after "throws", "never throws" and "answers
    // 200 with a flag". `/api/ai/resolve-conflict` splits the reply into lines
    // and returns `{ ideas: [] }` when none survive — a 200 that looks exactly
    // like a working model with nothing to suggest. The response is deliberately
    // unchanged; the row is the only place the difference lives.
    const src = readFileSync('app/api/ai/resolve-conflict/route.ts', 'utf8');
    expect(src).toContain('if (parsed.length === 0) obs.failed(');
    expect(src, 'the empty answer must still be returned as a 200').toContain('return NextResponse.json({ ideas });');

    // Recipe suggestions are the same shape: `parseSuggestions` keeps only ids
    // the family owns, so an empty list means the model named nothing real —
    // and the cook sees "no suggestions" either way.
    const suggest = readFileSync('app/api/recipes/suggest/route.ts', 'utf8');
    expect(suggest).toContain('if (parsed.length === 0) obs.failed(');
    expect(suggest, 'the empty answer must still be returned as a 200').toContain('return NextResponse.json({ picks: results });');
  });

  it('an answer the surface could not use is a failure, and the tokens still count', () => {
    // Four surfaces share one failure mode nothing recorded: the model answered,
    // the tokens were spent, and the reply could not be parsed into anything
    // usable. Each ends at a 502/422 or a silent fallback that looks exactly
    // like "AI is not configured" from the outside.
    //
    // Two things have to be true in each, and the ORDER is the assertion:
    // `obs.used` first, so the spend is on the row even though the turn failed,
    // then `obs.failed`, so the row does not read `completed` for the one turn
    // the family wrote in about.
    for (const file of [
      'app/api/ai/notes/route.ts',
      'app/api/ai/relationship/route.ts',
      'app/api/ai/meals/nutrition/route.ts',
      'app/api/ai/chef/route.ts',
      'app/api/ai/wallet/route.ts',
      'app/api/ai/wallet/child/[childId]/route.ts',
      'app/api/ai/resolve-conflict/route.ts',
      'app/api/recipes/suggest/route.ts',
      'app/api/recipes/transform/route.ts',
      'app/api/ai/trip/route.ts',
      'app/api/ai/invest/route.ts',
      'app/api/behavior/insight/route.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      const used = src.indexOf('obs.used(');
      const failed = src.indexOf('obs.failed(');
      expect(used, `${file} must record the model that answered`).toBeGreaterThan(-1);
      expect(failed, `${file} must record an unusable answer as a failure`).toBeGreaterThan(-1);
      expect(used, `${file} must charge the tokens before reporting the failure`).toBeLessThan(failed);
    }
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
  it('leaves the admin AI-engine connectivity test alone, with a reason', () => {
    // `app/(app)/admin/ai/actions.ts` authenticates with getUser() + isSuperAdmin()
    // and never resolves a family at all — it exists to answer "does the
    // configured key work?". There is no `familyId` to build a scope from, and
    // billing a connectivity check to whichever family happens to be first would
    // be worse than not recording it. Same class as /api/ai/gift.
    const src = readFileSync('app/(app)/admin/ai/actions.ts', 'utf8');
    expect(src).not.toContain('withAiRequest(');
    expect(src).toContain('isSuperAdmin()');
    expect(src, 'it has no family context to attribute a row to').not.toContain('requireUserContext');
  });

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

  it('counts the provider factory, which will never adopt, so the floor is 1', () => {
    // `resolveProviderForTask` builds an OpenAIProvider and hands it back; it
    // never calls one. There is no request to observe here and no scope to
    // observe it with — the caller that asked for the provider is the surface.
    //
    // It stays in the count anyway. Excluding it would mean teaching the scanner
    // a judgement call, and a scanner that makes judgement calls is one that can
    // be argued into excluding a real surface. The floor of the ceiling is 1,
    // not 0, and that is written down rather than discovered by whoever gets
    // there.
    const src = readFileSync('lib/ai/routing.ts', 'utf8');
    expect(src).toContain('return new OpenAIProvider(');
    expect(src).not.toContain('.complete(');
    expect([...SILENT]).toContain('lib/ai/routing.ts');
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
    // surface adopts withAiRequest — 52 → 48 → 44 → 42 → 40 → 36 → 32, then 23
    // when the scanner stopped counting files that cannot reach a model at all,
    // then 22 when the assistant engine adopted it, then 19, then 17, then 14,
    // then 11, then 8.
    //
    // That drop is a CORRECTION, not nine adoptions. The old scanner counted any
    // import from `lib/ai/provider`, so six files importing only a `ToolSpec` or
    // `AIProviderConfig` type, and three importing only `describeAIError` /
    // `isAIConfigured`, sat in the count. None of them can obtain a provider.
    // They were nine units of slack in the very ratchet this comment says must
    // have none.
    const CEILING = 8;
    expect(
      SILENT.size,
      `these reach a model and record nothing:\n  ${[...SILENT].join('\n  ')}\n` +
      'Wrap the call in withAiRequest(), or raise CEILING deliberately and say why.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('counts what can reach a model, and nothing else', () => {
    // The scanner has been wrong twice, in both directions, so it gets its own
    // fixtures. Every line here is a file whose behaviour was checked by hand.
    //
    // Counted: obtains a provider and calls it. These prove the scanner still
    // finds real surfaces. Deliberately the two ADMIN/marketing ones rather than
    // a family-facing route: §33 is about what a family writes in about, so
    // those adopt first and these stay put. (`app/api/ai/wallet/route.ts` and
    // `lib/chores/ai.ts` each sat here until they adopted, one tranche apart —
    // hence picking fixtures that are not next in line.)
    expect([...SILENT]).toContain('lib/marketing/platform.ts');
    expect([...SILENT]).toContain('app/api/admin/marketing/ai/route.ts');
    // `lib/ai/assistant-engine.ts` used to be asserted here. It was found only
    // after the backward scan was fixed — a forward regex read its earlier
    // `import type` line and called it type-only — and it has since adopted the
    // wrapper, so it belongs in the adopted list below rather than this one.

    // Not counted: `import type { ToolSpec }` and nothing else.
    for (const file of [
      'lib/assistant/tools.ts',
      'lib/assistant/trust-wrapper.ts',
      'lib/ai/action-tools.ts',
      'lib/ai/tools/legacy-adapter.ts',
      'lib/ai/settings.ts',
      'lib/ai/provider-stub.ts',
    ]) expect([...SILENT], `${file} imports only types`).not.toContain(file);

    // Not counted: imports a value, but one that never yields a provider.
    for (const file of [
      'app/api/ai/route.ts',
      'app/api/social/ai/route.ts',
      'app/(app)/dashboard/concierge/run-actions.ts',
    ]) expect([...SILENT], `${file} imports no provider producer`).not.toContain(file);
  });

  it('reads a provider import the same way whichever line it sits on', () => {
    // Direct unit checks on the classifier, so a regression shows up here rather
    // than as a ceiling that silently drifts.
    expect(reachesAModel("import { resolveProvider } from '@/lib/ai/provider';")).toBe(true);
    // Line 1 with no preceding newline — the backward scan has to find it.
    expect(reachesAModel("import { getProvider } from '@/lib/ai/provider';\nconst x = 1;")).toBe(true);
    expect(reachesAModel("import type { ToolSpec } from '@/lib/ai/provider';")).toBe(false);
    expect(reachesAModel("import { type AIProvider } from '@/lib/ai/provider';")).toBe(false);
    expect(reachesAModel("import { describeAIError, isAIConfigured } from '@/lib/ai/provider';")).toBe(false);
    // The exact shape the old forward regex got wrong: an unrelated `import type`
    // above a real value import from the provider.
    expect(reachesAModel(
      "import type { Foo } from '@/lib/foo';\nimport { resolveProvider, type AIMessage } from '@/lib/ai/provider';",
    )).toBe(true);
  });

  it('is actually scanning something, so the ceiling is not vacuously satisfied', () => {
    // A broken scanner returns an empty set and this file goes quietly green
    // while every surface is silent — the exact failure mode it exists to catch.
    expect(SILENT.size).toBeGreaterThan(0);
    expect([...SILENT].some((f) => f.startsWith('app/api/ai/'))).toBe(true);
  });
});
