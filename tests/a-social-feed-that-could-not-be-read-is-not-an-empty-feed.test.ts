// N16 — the Social Feed page discarded both of its read errors.
//
// `const [{ data: sources }, { data: items }] = await settleAll([...])` never
// looked at `.error`, so a refused or timed-out read became an empty list and
// the module said "Your feed is empty — Add your first source", inviting the
// family to reconnect sources they already have. One failing read quietly
// dropped that half of the page.
//
// Driven through the REAL page against an in-memory database whose chosen
// table refuses the read.
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const t = (key: string) => translate(SOURCE_MESSAGES, key);
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { getTranslations: async () => (key: string) => tr(messages, key) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: FAMILY, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
// The module is the page's child; what this asserts is what the PAGE hands it,
// so it is recorded rather than rendered.
vi.mock('@/components/modules/social-feed-module', () => ({ SocialFeedModule: () => null }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate: tr } = await import('@/lib/i18n/translate');
  return { useTranslations: () => (key: string) => tr(messages, key) };
});

const SocialFeedPage = (await import('@/app/(app)/dashboard/social-feed/page')).default;
const { SocialFeedModule } = await import('@/components/modules/social-feed-module');

let base: InMemorySupabase;
let failing: string | null;

beforeEach(() => {
  base = createInMemorySupabase();
  failing = null;
  state.db = withFaults(base, (table) => (table === failing ? { message: 'Fixture read refused' } : null));
  base.seed('social_reader_sources', [{ id: 'src-1', family_id: FAMILY, platform: 'instagram', display_name: 'Grandma', handle: '@grandma', account_count: 1, category: 'family', is_active: true, sort_order: 0 }]);
  base.seed('social_reader_items', [{ id: 'item-1', family_id: FAMILY, source_id: 'src-1', platform: 'instagram', author_name: 'Grandma', content: 'Garden photos', media_urls: [], posted_at: '2026-10-12T10:00:00Z', is_favorite: false, is_read: false, verified: false }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a social feed that could not be read is not an empty feed', () => {
  it.each(['social_reader_sources', 'social_reader_items'])('a failed %s read shows the error, not the module with an empty list', async (table) => {
    failing = table;

    const page = await SocialFeedPage() as ReactElement<Record<string, unknown>>;
    const html = renderToStaticMarkup(page);

    expect(html).toContain(t('socialFeed.couldNotLoadYourFeed'));
    // Not the feed with a list emptied by the failure: that is the module
    // whose empty state says "Add your first source".
    expect(page.type).not.toBe(SocialFeedModule);
  });

  it('when both reads answer, the module gets the family\'s sources and items', async () => {
    const page = await SocialFeedPage() as ReactElement<{ sources: { id: string }[]; items: { id: string }[] }>;

    expect(page.type).toBe(SocialFeedModule);
    expect(page.props.sources.map((s) => s.id)).toEqual(['src-1']);
    expect(page.props.items.map((i) => i.id)).toEqual(['item-1']);
  });
});
