import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S9-74 — server actions called and not awaited: `void someAction(…)`.
 *
 * The charter forbids ignoring failed promises. A `void` call can fail two
 * ways its caller never sees: a refusal it answers (`ok: false`) and a call
 * that rejects outright (a lapsed session, a network drop). Seventeen sites
 * were triaged. Eleven remain, each listed below with how it learns about
 * failure; a new one fails this test until it is classified.
 *
 *  - `checked`: the chain reads the result AND handles a rejection, and the
 *    handler does something — a `.catch(() => {})` is a swallow, not a check.
 *  - `deliberate`: best-effort by design, with the reason here.
 */
const CLASSIFIED: Record<string, { kind: 'checked' } | { kind: 'deliberate'; why: string; count?: number }> = {
  'components/modules/workload-module.tsx::saveWorkloadSnapshotAction': { kind: 'checked' },
  'components/modules/social-feed-module.tsx::markReadAction': { kind: 'checked' },
  'components/modules/routines-panel.tsx::undoCalendarEventsAction': { kind: 'checked' },
  'components/app/command-bar.tsx::searchRecordsAction': { kind: 'checked' },
  'components/settings/ai-settings.tsx::loadAISettingsAction': { kind: 'checked' },
  'components/billing/family-delivered-value.tsx::loadFamilyDeliveredValueAction': { kind: 'checked' },
  'components/capture/capture-shortcuts.tsx::saveCaptureShortcutsAction': { kind: 'checked' },
  'components/moments/moments-view.tsx::removeMomentGroceryAction': { kind: 'checked' },
  'components/auth/signup-form.tsx::stitchIdentityAction': {
    kind: 'deliberate',
    why: 'visitor-analytics stitching; the action try/catches itself and must never block sign-up',
  },
  'components/dashboard/quick-actions.tsx::logDashboardEventAction': {
    kind: 'deliberate', count: 2,
    why: 'click telemetry; the action catches its own failures and answers { ok: false }',
  },
};

const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^[^\S\n]*\/\/.*$/gm, '');

/** Each `void xAction(` statement, from the `void` to its `;` at depth zero. */
function sites(file: string): { action: string; text: string }[] {
  const src = strip(readFileSync(file, 'utf8'));
  const out: { action: string; text: string }[] = [];
  for (const m of src.matchAll(/\bvoid ([a-zA-Z]\w*Action)\(/g)) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') { if (depth === 0) { end = i; break; } depth--; }
      else if (c === ';' && depth === 0) { end = i; break; }
    }
    out.push({ action: m[1], text: src.slice(m.index, end) });
  }
  return out;
}

function allSites() {
  const files = execSync("grep -rlE 'void [a-zA-Z]+Action\\(' app components --include=*.tsx || true", { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  return files.flatMap((f) => sites(f).map((s) => ({ key: `${f}::${s.action}`, ...s })));
}

describe('every fire-and-forget server action call is classified (C1-S9-74)', () => {
  const found = allSites();

  it('no unclassified site, and no classified site that has gone', () => {
    const counts = new Map<string, number>();
    for (const s of found) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
    const expected = new Map(Object.entries(CLASSIFIED).map(([k, v]) => [k, v.kind === 'deliberate' ? (v.count ?? 1) : 1]));
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(expected));
  });

  it('a checked site reads the result and handles a rejection, without swallowing it', () => {
    for (const s of found) {
      if (CLASSIFIED[s.key]?.kind !== 'checked') continue;
      expect(s.text, s.key).toContain('.then(');
      expect(s.text, s.key).toContain('.catch(');
      expect(s.text, `${s.key} swallows the rejection`).not.toMatch(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/);
    }
  });
});

describe('the library player takes back a position it did not save (C1-S9-74)', () => {
  const player = strip(readFileSync('app/(app)/dashboard/library/player.tsx', 'utf8'));

  it('no progress write is fire-and-forget', () => {
    expect(player).not.toMatch(/void saveProgressAction\(/);
    const helper = player.slice(at(player, 'function saveInBackground('));
    const body = helper.slice(0, at(helper, '\n}\n'));
    // Each branch on its own: a single regex across both let the catch
    // branch's call stand in for a missing refusal branch (a mutation survived).
    expect(between(body, 'if (res.ok) return;', '.catch(')).toContain('onFail?.();');
    expect(body.slice(at(body, '.catch((err: unknown) => {'))).toContain('onFail?.();');
  });

  it('a failed position save restores what was last really saved — unless a newer save claimed it', () => {
    const fn = player.slice(at(player, 'function savePosition('));
    expect(at(fn, 'const previous = lastSaved.current;')).toBeLessThan(at(fn, 'lastSaved.current = at;'));
    expect(fn).toContain('if (lastSaved.current === at) lastSaved.current = previous;');
    // Every position save goes through it, so the unmount check trusts only
    // positions that landed.
    expect(player).toContain('if (touched.current) savePosition(audio.currentTime);');
    expect(player).toContain('>= SAVE_EVERY_SECONDS) savePosition(audio.currentTime);');
  });
});

describe('the referral cookie is not swallowed (C1-S9-74)', () => {
  it('a failed save is retried once and a final failure is logged', () => {
    const form = strip(readFileSync('components/auth/signup-form.tsx', 'utf8'));
    expect(form).toContain('rememberReferralCodeAction(referralCode)');
    expect(form).toContain("if (!res.ok) throw new Error('referral cookie refused');");
    expect(form).toContain('.catch(() => remember())');
    expect(form).toMatch(/\.catch\(\(error: unknown\) => console\.warn\('\[signup\] referral code could not be remembered/);
    expect(form).not.toContain('rememberReferralCodeAction(referralCode).catch(() => {})');
  });
});

describe('AI settings do not load forever (C1-S9-74)', () => {
  it('a failed load call ends the loading state and shows the load error', () => {
    const src = strip(readFileSync('components/settings/ai-settings.tsx', 'utf8'));
    const failure = src.slice(at(src, "console.error('[settings:ai] load call failed', error);"));
    expect(failure.slice(0, at(failure, '});'))).toContain('if (alive) setLoadCallFailed(true);');
    expect(src).toContain('if (loadError || loadCallFailed) {');
    expect(src).toContain("{loadError ?? t('aiActions.couldNotLoadYourBubaly')}");
  });
});
