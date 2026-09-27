// SRV-001 l8 — only a released app installs, and an installed app can always
// be removed.
//
// family_apps.status is published, beta, coming_soon or retired, and the App
// Store page drew no Install button for a coming-soon app. That was the whole
// rule: installAppAction upserted any app id it was handed, so a member could
// install an unreleased app by calling the action (or over /rest/v1). The card
// then showed "Unavailable" and no control at all, so nobody could remove it —
// the same card an operator produces by moving a released app back to
// coming-soon.
//
// The database half is 0420, held by docs/audit/only-a-released-app-installs-
// check.sql. This pins the application half against the REAL en-US catalogue.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'child', member: { id: 'member-1' } },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
// The button's toasts are not what this measures; a provider-less stand-in.
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));

const { installAppAction } = await import('@/app/(app)/dashboard/app-store/actions');
const { InstallButton } = await import('@/components/appstore/install-button');

let db: InMemorySupabase;
const APPS = [
  { id: 'app-published', slug: 'published', name: 'Published', status: 'published' },
  { id: 'app-beta', slug: 'beta', name: 'Beta', status: 'beta' },
  { id: 'app-soon', slug: 'soon', name: 'Coming', status: 'coming_soon' },
  { id: 'app-retired', slug: 'retired', name: 'Retired', status: 'retired' },
];

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('family_apps', structuredClone(APPS));
  h.db = db;
});

const installs = () => db.table('family_app_installs') as { app_id: string }[];

describe('installAppAction installs only a published or beta app', () => {
  it.each(['app-published', 'app-beta'])('installs %s', async (appId) => {
    expect(await installAppAction(appId)).toEqual({ ok: true });
    expect(installs().map((r) => r.app_id)).toEqual([appId]);
  });

  it.each(['app-soon', 'app-retired'])('refuses %s with a sentence, and writes nothing', async (appId) => {
    const res = await installAppAction(appId);
    expect(EN_US['actions.thatAppIsNotAvailableToInstallYet']).toEqual(expect.any(String));
    expect(res).toEqual({ ok: false, error: EN_US['actions.thatAppIsNotAvailableToInstallYet'] });
    expect(installs()).toHaveLength(0);
  });

  it('refuses an app id the catalogue does not have', async () => {
    expect(await installAppAction('app-nobody-published')).toEqual({ ok: false, error: EN_US['actions.thatAppIsNotAvailableToInstallYet'] });
    expect(installs()).toHaveLength(0);
  });

  it('refuses when the status cannot be read — a failed read is not "installable"', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const q = from(table);
      if (table !== 'family_apps') return q;
      return Object.assign(q, { maybeSingle: async () => ({ data: null, error: { message: 'timeout', code: '57014' } }) });
    }) as typeof db.from);
    expect(await installAppAction('app-published')).toEqual({ ok: false, error: EN_US['actions.couldNotInstallThatApp'] });
    expect(installs()).toHaveLength(0);
  });
});

describe('an installed app keeps its control whatever its status now says', () => {
  it('an installed app that is no longer available still renders the toggle, so it can be removed', () => {
    const html = renderTranslated(createElement(InstallButton, { appId: 'app-soon', installed: true, available: false }));
    expect(html).toContain('<button');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain(EN_US['installButton.unavailable']);
  });

  it('an app that is neither available nor installed shows the label and nothing to press', () => {
    const html = renderTranslated(createElement(InstallButton, { appId: 'app-soon', installed: false, available: false }));
    expect(html).not.toContain('<button');
    expect(html).toContain(EN_US['installButton.unavailable']);
  });
});
