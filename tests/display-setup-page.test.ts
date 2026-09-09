import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SELF_CHECK_IDS, checkFullscreen, checkOnline, checkRecovery, checkWakeLock, runDisplaySelfCheck,
  type SelfCheckEnv, type SelfCheckResult,
} from '@/components/display/display-self-check';
import { DEFAULT_DISPLAY_SETTINGS, normalizeSettings } from '@/lib/display/ambient';

// /display/setup: a checklist and a self-check. The property under test is the
// one the page promises in its own copy — it reports ONLY what it measured, and
// "this browser has none" is an answer rather than a silent pass.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogues = Object.fromEntries(
  LOCALES.map((code) => [code, JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>]),
);

const setupPage = readFileSync('app/(app)/display/setup/page.tsx', 'utf8');
const selfCheck = readFileSync('components/display/display-self-check.tsx', 'utf8');
const setupCard = readFileSync('components/display/setup-card.tsx', 'utf8');
const grid = readFileSync('components/display/display-grid.tsx', 'utf8');

function grantingNavigator(onLine = true) {
  const released: number[] = [];
  return {
    released,
    nav: {
      onLine,
      wakeLock: {
        request: async () => ({ released: false, release: async () => { released.push(1); } }),
      },
    } as SelfCheckEnv['navigator'],
  };
}

const fullscreenDocument = (over: Record<string, unknown> = {}): SelfCheckEnv['document'] => ({
  visibilityState: 'visible',
  fullscreenEnabled: true,
  documentElement: { requestFullscreen: () => Promise.resolve() },
  addEventListener: () => {},
  removeEventListener: () => {},
  ...over,
});

describe('the fullscreen check', () => {
  it('passes when the API is present and permitted', async () => {
    await expect(checkFullscreen({ document: fullscreenDocument() })).resolves.toMatchObject({
      id: 'fullscreen', outcome: 'pass',
    });
  });

  it('warns rather than passing when the browser has fullscreen switched off', async () => {
    await expect(checkFullscreen({ document: fullscreenDocument({ fullscreenEnabled: false }) })).resolves.toMatchObject({
      outcome: 'warn',
    });
  });

  it('fails when there is no requestFullscreen at all', async () => {
    await expect(checkFullscreen({ document: fullscreenDocument({ documentElement: {} }) })).resolves.toMatchObject({
      outcome: 'fail',
    });
  });

  it('says unknown — never pass — when there is no document to look at', async () => {
    await expect(checkFullscreen({ document: null })).resolves.toMatchObject({ outcome: 'unknown' });
  });
});

describe('the wake-lock check asks for real', () => {
  it('passes when the lock is granted, and hands it straight back', async () => {
    const { nav, released } = grantingNavigator();
    await expect(checkWakeLock({ navigator: nav, document: fullscreenDocument() })).resolves.toMatchObject({
      id: 'wakeLock', outcome: 'pass',
    });
    expect(released).toHaveLength(1);
  });

  it('warns when the browser declines', async () => {
    const nav = { wakeLock: { request: async () => { throw new Error('NotAllowedError'); } } } as SelfCheckEnv['navigator'];
    await expect(checkWakeLock({ navigator: nav, document: fullscreenDocument() })).resolves.toMatchObject({ outcome: 'warn' });
  });

  it('fails — and does not throw — when the browser has no wake lock', async () => {
    await expect(checkWakeLock({ navigator: {}, document: fullscreenDocument() })).resolves.toMatchObject({ outcome: 'fail' });
  });
});

describe('the network check reports the browser flag and nothing more', () => {
  it('passes when navigator.onLine is true', async () => {
    await expect(checkOnline({ navigator: grantingNavigator(true).nav })).resolves.toMatchObject({ outcome: 'pass' });
  });

  it('fails when navigator.onLine is false', async () => {
    await expect(checkOnline({ navigator: grantingNavigator(false).nav })).resolves.toMatchObject({ outcome: 'fail' });
  });

  it('says unknown when the browser reports no network state', async () => {
    await expect(checkOnline({ navigator: {} })).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('never claims Bubaly is reachable — only that the device says it is online', () => {
    const en = catalogues['en-US'];
    expect(en['displaySetup.onlineYes']).toMatch(/not proof|does not prove/i);
  });
});

describe('the recovery check exercises lib/display/recover', () => {
  it('passes against the real policy module', async () => {
    await expect(checkRecovery()).resolves.toMatchObject({ id: 'recovery', outcome: 'pass' });
  });

  it('is wired to the real helpers rather than asserting a constant', () => {
    expect(selfCheck).toContain("from '@/lib/display/recover'");
    expect(selfCheck).toContain('isStaleBundleError');
    expect(selfCheck).toContain('shouldHardReload');
    expect(selfCheck).toContain('isBundleStaleByAge');
  });
});

describe('the runner', () => {
  const env = (): SelfCheckEnv => ({ navigator: grantingNavigator().nav, document: fullscreenDocument() });

  it('runs the four checks, in order, reporting each as it lands', async () => {
    const live: SelfCheckResult[] = [];
    const results = await runDisplaySelfCheck(env(), (r) => live.push(r));
    expect(results.map((r) => r.id)).toEqual([...SELF_CHECK_IDS]);
    expect(live.map((r) => r.id)).toEqual([...SELF_CHECK_IDS]);
  });

  it('turns a check that blows up into "unknown", never into a pass', async () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, 'documentElement', { get() { throw new Error('sealed'); } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const results = await runDisplaySelfCheck({ navigator: {}, document: hostile as SelfCheckEnv['document'] });
    spy.mockRestore();
    const fullscreen = results.find((r) => r.id === 'fullscreen');
    expect(fullscreen?.outcome).toBe('unknown');
    expect(results.every((r) => r.outcome !== 'pass' || r.id === 'recovery')).toBe(true);
  });

  it('starts with nothing claimed: every row reads "not tested yet" until asked', () => {
    expect(selfCheck).toContain("t('displaySetup.notTestedYet')");
    expect(selfCheck).toContain('results[id]');
  });
});

describe('the /display/setup page', () => {
  it('is behind the same feature gate as the display itself', () => {
    expect(setupPage).toContain("requireFeature('/display')");
  });

  it('renders the self-check and gets back to the display', () => {
    expect(setupPage).toContain('<DisplaySelfCheck />');
    expect(setupPage).toContain('href="/display"');
  });

  it('reaches the public device list, which is how a new route gets found here', () => {
    expect(setupPage).toContain('href="/family-display"');
  });

  it('translates its own tab title instead of shipping one English string', () => {
    expect(setupPage).toContain('export async function generateMetadata');
    expect(setupPage).toContain("t('displaySetup.setUpThisDisplay')");
  });

  it('is linked from the display header (new routes are reached by links, not by the sidebar)', () => {
    expect(grid).toContain('href="/display/setup"');
    expect(readFileSync('lib/constants/navigation.ts', 'utf8')).not.toContain('/display/setup');
  });
});

describe('the first-run card persists its dismissal in display_layouts.settings', () => {
  it('normalizeSettings carries the flag, defaulting to not-dismissed', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.setupDismissed).toBe(false);
    expect(normalizeSettings(null).setupDismissed).toBe(false);
    expect(normalizeSettings({ setupDismissed: true }).setupDismissed).toBe(true);
    expect(normalizeSettings({ setupDismissed: 'yes' }).setupDismissed).toBe(false);
  });

  it('writes through the existing family-scoped upsert', () => {
    expect(grid).toContain('async function dismissSetup');
    expect(grid).toContain('setupDismissed: true');
    expect(grid).toContain("upsert({ family_id: familyId, tiles: tiles as never, settings: nextSettings as never, updated_by: userId }, { onConflict: 'family_id' })");
  });

  it('does not claim the dismissal when the write failed', () => {
    const dismiss = grid.slice(grid.indexOf('async function dismissSetup'), grid.indexOf('const dayIcon'));
    // The error path logs, toasts and RETURNS before setSetupDismissed(true).
    expect(dismiss).toContain("console.error('[display] setup card dismissal write failed'");
    expect(dismiss.indexOf('return;')).toBeLessThan(dismiss.indexOf('setSetupDismissed(true)'));
  });

  it('targets a column that exists', () => {
    const migration = readFileSync('supabase/migrations/0200_display_settings.sql', 'utf8');
    expect(migration).toMatch(/add column if not exists settings jsonb/i);
  });

  it('shows the wake-lock state as a measurement, with a line for every state', () => {
    for (const key of ['wakeLockActive', 'wakeLockBlocked', 'wakeLockUnsupported', 'wakeLockIdle']) {
      expect(setupCard, key).toContain(`displaySetupCard.${key}`);
    }
  });
});

describe('every string this surface can render exists in all seven catalogues', () => {
  const keys = [
    ...new Set([
      ...[...setupPage.matchAll(/'(displaySetup\.[A-Za-z0-9]+)'/g)].map((m) => m[1]),
      ...[...selfCheck.matchAll(/'(displaySetup\.[A-Za-z0-9]+)'/g)].map((m) => m[1]),
      ...[...setupCard.matchAll(/'(displaySetupCard\.[A-Za-z0-9]+)'/g)].map((m) => m[1]),
    ]),
  ];

  it('found the keys to check', () => {
    expect(keys.length).toBeGreaterThan(20);
  });

  it.each(LOCALES)('%s has every key', (locale) => {
    const missing = keys.filter((key) => !catalogues[locale][key]);
    expect(missing, `missing in ${locale}`).toEqual([]);
  });
});
