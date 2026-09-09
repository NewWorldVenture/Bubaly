import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PUBLIC_ROUTES } from './e2e/public-routes';

// The public family-display page: "a shared family screen on the tablet you
// already own". Three things are pinned here — that a signed-out visitor can
// actually reach it, that it renders the two pure catalogs rather than copy of
// its own, and that it stays inside the honesty fence the section was given:
// no competitor price, no superlative, no partnership claim.

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

import { middleware } from '../middleware';

const ROUTE = '/family-display';
const page = readFileSync(`app${ROUTE.replace('/', '/(marketing)/')}/page.tsx`, 'utf8');
const sitemap = readFileSync('app/sitemap.ts', 'utf8');

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogues = Object.fromEntries(
  LOCALES.map((code) => [code, JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>]),
);

describe('the route a signed-out visitor reaches', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
    getUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('serves the page without a session', async () => {
    const response = await middleware(new NextRequest(`https://www.bubaly.com${ROUTE}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does NOT make the signed-in kiosk public along with it', async () => {
    for (const guarded of ['/display', '/display/setup']) {
      const response = await middleware(new NextRequest(`https://www.bubaly.com${guarded}`));
      expect(response.status, guarded).toBe(307);
      expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
    }
  });

  it('is in the sitemap and in the e2e public-route sweep', () => {
    expect(sitemap).toContain(`path: '${ROUTE}'`);
    expect(PUBLIC_ROUTES).toContain(ROUTE);
  });

  it('lives at /family-display because /display is already the app kiosk', () => {
    // Two pages cannot resolve to the same path. The app owns /display
    // (app/(app)/display/page.tsx), so the marketing route takes its own slug.
    expect(existsSync('app/(app)/display/page.tsx')).toBe(true);
    expect(existsSync('app/(marketing)/display/page.tsx')).toBe(false);
  });
});

describe('the page itself', () => {
  it('meets the marketing route contract (metadata + the shared AEO section)', () => {
    expect(page).toContain('export async function generateMetadata');
    expect(page).toContain('resolveMarketingMetadata');
    expect(page).toContain('<MarketingAeoSection');
    expect(page).toContain(`path="${ROUTE}"`);
  });

  it('renders the catalogs instead of holding copy of its own', () => {
    expect(page).toContain("from '@/lib/marketing/certified-devices'");
    expect(page).toContain("from '@/lib/marketing/display-compare'");
    expect(page).toContain('DEVICE_SETUP_STEPS.map');
    expect(page).toContain('DISPLAY_COMPARE_ROWS.map');
    expect(page).toContain('devicesInTier(tier, CERTIFIED_DEVICES)');
    // Including the device's own name and browser: those were English literals
    // printed verbatim here, on a page every locale reads.
    expect(page).toContain('t(device.nameKey)');
    expect(page).not.toMatch(/\{device\.(?:label|browser|minOs)\}/);
    expect(page).toContain('PROGRAM_DISCLAIMER_KEY');
    expect(page).toContain('COMPARE_FAIRNESS_KEY');
  });

  it('badges the mocked wall as an illustrative sample', () => {
    expect(page).toContain('<SampleBadge>');
    expect(page).toContain("t('handledProof.sampleBadge')");
  });

  it('sends a signed-in reader to the in-app setup guide', () => {
    expect(page).toContain('href="/display/setup"');
  });

  it('leaves the marketing header, footer and nav alone', () => {
    // The site tranche owns those files; this page is reached from /display/setup
    // and from the sitemap until they link it.
    const nav = readFileSync('lib/constants/navigation.ts', 'utf8');
    expect(nav).not.toContain(ROUTE);
  });
});

describe('what the page promises', () => {
  const keys = [...new Set([...page.matchAll(/'(marketingDisplay\.[A-Za-z0-9]+)'/g)].map((m) => m[1]))];

  it('found the page keys', () => {
    expect(keys.length).toBeGreaterThan(25);
  });

  it.each(LOCALES)('%s carries every one of them', (locale) => {
    expect(keys.filter((key) => !catalogues[locale][key]), `missing in ${locale}`).toEqual([]);
  });

  it('never claims hardware Bubaly sells, and never prices a rival', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        const text = catalogues[locale][key] ?? '';
        expect(text, `${locale} ${key}`).not.toMatch(/[$£€]\s?\d/);
        expect(text, `${locale} ${key}`).not.toMatch(/\b(?:skylight|hearth|cozi|familywall|ohai)\b/i);
        expect(text, `${locale} ${key}`).not.toMatch(/\b(the best|world[- ]class|unbeatable|revolutionary|market[- ]leading)\b/i);
      }
    }
  });

  it('says the display runs on hardware the family already has', () => {
    const en = catalogues['en-US'];
    expect(`${en['marketingDisplay.title']} ${en['marketingDisplay.subtitle']} ${en['marketingDisplay.metaDescription']}`)
      .toMatch(/already own|no new hardware|not a device to buy/i);
  });

  it('describes the handled tile the way the tile actually behaves', () => {
    expect(catalogues['en-US']['marketingDisplay.mockHandledBody']).toMatch(/instead of showing a zero/i);
  });
});
