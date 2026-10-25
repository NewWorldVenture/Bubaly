import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// /admin/tier-features read the feature tiers with the default
// 'catalog-defaults' answer, so a refused or late app_settings read drew every
// feature at its catalog tier: a stored Off read Free, a stored Plus read its
// default, and every tier button and "Reset to defaults" were offered over a
// state nobody had read (review R9-2-TIER-FEATURES-FAILED-READ-IS-CATALOG-DEFAULTS).
// The page now asks for the read's failure and shows its read-error state,
// with no tier button and no Reset. The REAL page and client over the
// in-memory database, the app_settings read failing (and counted) beside a
// control where it answers.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: () => {}, success: () => {}, error: () => {} }) }));
// The client's server actions; a render calls neither.
vi.mock('@/app/(app)/admin/tier-features/actions', () => ({
  setFeatureTierAction: async () => ({ ok: true }),
  resetFeatureTiersAction: async () => ({ ok: true }),
}));

let db: InMemorySupabase;
let faulted = 0;

function seed() {
  db.seed('app_settings', [{ key: 'feature_tiers', value: { calendar: 'off', 'ai-concierge': 'plus' }, updated_at: '2026-10-01T00:00:00.000Z' }]);
}
function failAppSettings() {
  h.db = withFaults(db, (table) => {
    if (table !== 'app_settings') return null;
    faulted += 1;
    return { code: '42501', message: 'permission denied for table app_settings' };
  });
}
async function renderPage(): Promise<string> {
  const { default: Page } = await import('@/app/(app)/admin/tier-features/page');
  return renderServerPage(await Page());
}
/** The tier a feature's row shows as active: the label of its one highlighted button. */
function activeTier(html: string, label: string): string | null {
  const start = html.indexOf(`>${label}</p>`);
  if (start < 0) throw new Error(`no "${label}" row on the page`);
  const row = html.slice(start, html.indexOf('</div></div>', start));
  const buttons = [...row.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)];
  const active = buttons.filter(([, cls]) => / (bg-slate-600|bg-emerald-700|bg-blue-600|bg-violet-600) /.test(`${cls} `));
  return active.length === 1 ? textOf(active[0][2]) : null;
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  faulted = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('/admin/tier-features: a failed read is the error state, and no tier is offered', () => {
  it('says the tiers could not be read and renders no tier button and no Reset', async () => {
    seed();
    failAppSettings();
    const html = await renderPage();
    expect(faulted).toBe(1);
    const text = textOf(html);
    expect(text).toContain(SOURCE_MESSAGES['adminTierFeatures.tierAmpFeatures']);
    expect(text).toContain(SOURCE_MESSAGES['adminTierFeatures.couldNotLoadFeatureTiers']);
    expect(html).not.toContain('<button');
    expect(text).not.toContain(SOURCE_MESSAGES['adminTierFeaturesTierFeaturesClient.resetToDefaults']);
    expect(text).not.toContain('Calendar');
    expect(html).toContain('href="/admin/tier-features"');
    expect(console.error).toHaveBeenCalled();
  });

  it('the control: a read that answers shows the stored tiers, not the catalog defaults', async () => {
    seed();
    const html = await renderPage();
    expect(activeTier(html, 'Calendar')).toBe('Off');
    expect(activeTier(html, 'AI Concierge')).toBe('Plus');
    expect(textOf(html)).toContain(SOURCE_MESSAGES['adminTierFeaturesTierFeaturesClient.resetToDefaults']);
    expect(textOf(html)).not.toContain(SOURCE_MESSAGES['adminTierFeatures.couldNotLoadFeatureTiers']);
  });

  it('the control: nothing stored, from a read that answered, is the catalog defaults', async () => {
    const html = await renderPage();
    expect(activeTier(html, 'Calendar')).toBe('Free');
    expect(activeTier(html, 'AI Concierge')).toBe('Basic');
  });
});
