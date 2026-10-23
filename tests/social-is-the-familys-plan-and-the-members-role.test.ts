// household-roles N1, N8 and N2 — the Social console decided neither who in the
// family may read it nor whether the family may use it.
//
// N1/N8: no read page checked lib/social/roles.ts. A read_only member — by
// default a child, caregiver or guest, "View the unified feed only" — opened
// the family's drafts, the scheduled and failed queues, the content calendar,
// each post's targets and provider errors, the media library and every
// member's AI generations, and the overview counted the drafts and scheduled
// posts for them. A teen (content_creator) opened analytics, which their role
// does not hold. Writes were refused on submit, but every write control was on
// the page.
//
// N2: only the overview called requireFeature. The layout, the fifteen other
// pages and every server action called requireUserContext alone, so a Free
// family (or any family once Social was switched off) opened every page by URL
// and could connect an account, draft and publish by posting the actions.
//
// N2-R1: the fix for N2 put the plan in front of disconnectAccountAction too,
// and the layout sent the family to billing from the accounts page, so a family
// that connected X on Basic and then dropped to Free (or saw Social switched
// off) could no longer disconnect it: Bubaly kept its X tokens, and nothing in
// Bubaly could clear them until the family paid again. A plan gates creating
// and changing, not removing (lib/family/actions.ts).
//
// Driven here: the real layout, pages and actions; the real social-role
// resolver (getSocialAccess) and the real plan resolver
// (resolveFeatureEntitlement), against an in-memory database. requireFeature
// is its own decision made by that same resolver; the drain half of N2 is in
// tests/social-scheduled-publish.test.ts.
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

const FAMILY = 'f0000000-0000-4000-8000-000000000001';
const USERS = {
  parent: 'a0000000-0000-4000-8000-000000000001',
  teen: 'a0000000-0000-4000-8000-000000000002',
  child: 'a0000000-0000-4000-8000-000000000003',
  analyst: 'a0000000-0000-4000-8000-000000000004',
} as const;
type Who = keyof typeof USERS;
const ROLE: Record<Who, string> = { parent: 'parent', teen: 'teen', child: 'child', analyst: 'adult' };
const POSTS = {
  draft: 'b0000000-0000-4000-8000-000000000001',
  scheduled: 'b0000000-0000-4000-8000-000000000002',
  failed: 'b0000000-0000-4000-8000-000000000003',
  published: 'b0000000-0000-4000-8000-000000000004',
} as const;

const h = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as unknown as { user: { id: string; email: string | null }; memberships: unknown[]; active: Record<string, unknown> & { familyId: string } },
  featureChecks: [] as string[],
  aiGenerationSelects: [] as string[],
  /** Whether the database's super-admin allowlist (rpc is_super_admin) lists the signed-in user. */
  superAdmin: false,
  locale: 'en-US' as 'en-US' | 'de-DE',
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
  usePathname: () => '/dashboard/social',
  useRouter: () => ({ push() {}, refresh() {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath() {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/auth', async (importOriginal) => {
  const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
  // The real super-admin check: the email list, then the database's allowlist.
  const { isSuperAdmin } = await importOriginal<typeof import('@/lib/supabase/auth')>();
  return {
    isSuperAdmin,
    requireUserContext: async () => h.ctx,
    // requireFeature's decision, by the resolver it wraps: allowed, or refused.
    // A super administrator passes, as requireFeature lets them through.
    requireFeature: async (key: string) => {
      h.featureChecks.push(key);
      if (await isSuperAdmin()) return h.ctx;
      const entitlement = await resolveFeatureEntitlement(h.db as never, h.ctx.active.familyId, key);
      if (!entitlement.allowed) throw new Error(`FEATURE_REFUSED ${key}`);
      return h.ctx;
    },
  };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, getMessages, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(h.locale), key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});

const { default: SocialLayout } = await import('@/app/(app)/dashboard/social/layout');
const { default: OverviewPage } = await import('@/app/(app)/dashboard/social/page');
const pages = {
  posts: (await import('@/app/(app)/dashboard/social/posts/page')).default,
  contentStudio: (await import('@/app/(app)/dashboard/social/content-studio/page')).default,
  composer: (await import('@/app/(app)/dashboard/social/content-studio/new/page')).default,
  scheduled: (await import('@/app/(app)/dashboard/social/scheduled/page')).default,
  failed: (await import('@/app/(app)/dashboard/social/failed/page')).default,
  published: (await import('@/app/(app)/dashboard/social/published/page')).default,
  calendar: (await import('@/app/(app)/dashboard/social/calendar/page')).default,
  analytics: (await import('@/app/(app)/dashboard/social/analytics/page')).default,
  media: (await import('@/app/(app)/dashboard/social/media-library/page')).default,
  connect: (await import('@/app/(app)/dashboard/social/accounts/connect/page')).default,
  accounts: (await import('@/app/(app)/dashboard/social/accounts/page')).default,
  inbox: (await import('@/app/(app)/dashboard/social/inbox/page')).default,
  settings: (await import('@/app/(app)/dashboard/social/settings/page')).default,
};
const { default: FeedPage } = await import('@/app/(app)/dashboard/social/feed/page');
const { default: PostDetailPage } = await import('@/app/(app)/dashboard/social/posts/[id]/page');
const { connectAccountAction, createPostAction, createMediaAction, disconnectAccountAction } = await import('@/app/(app)/dashboard/social/actions');
const { ToastProvider } = await import('@/components/ui/toast');

const stamps = { created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' };

/** The household, signed in as `who`, on `plan` (null: no subscription, the Free tier). */
function household(who: Who, plan: 'basic' | 'plus' | null = 'basic'): InMemorySupabase {
  const db = createInMemorySupabase({ userId: USERS[who], maxRows: 1000, rpc: { is_super_admin: () => h.superAdmin } });
  db.seed('families', [{ id: FAMILY, name: 'Rivera household', trial_ends_at: null, closed_at: null }]);
  if (plan) db.seed('subscriptions', [{ id: 's-1', family_id: FAMILY, plan, status: 'active', current_period_end: null }]);
  db.seed('family_members', (Object.keys(USERS) as Who[]).map((member, i) => ({
    id: `m-${i}`, family_id: FAMILY, user_id: USERS[member], role: ROLE[member], is_active: true, display_name: member,
  })));
  // An adult the parents restricted to analytics (Settings → Access control).
  db.seed('social_access_permissions', [{ id: 'p-1', family_id: FAMILY, user_id: USERS.analyst, social_role: 'analyst', status: 'active' }]);
  const post = (id: string, title: string, status: string) => ({
    id, family_id: FAMILY, user_id: USERS.parent, campaign_id: null, title, body: `${title} body`, kind: 'text', status, link: null,
    scheduled_for: status === 'scheduled' ? '2026-11-01T12:00:00.000Z' : null, published_at: null, approval_status: 'not_required',
    approved_by: null, approved_at: null, created_by: USERS.parent, updated_by: null, deleted_at: null, metadata: {}, ...stamps,
  });
  db.seed('social_posts', [
    post(POSTS.draft, 'Spring fair draft', 'draft'),
    post(POSTS.scheduled, 'Bake sale reminder', 'scheduled'),
    post(POSTS.failed, 'Car wash recap', 'failed'),
    post(POSTS.published, 'Thank you neighbours', 'published'),
  ]);
  db.seed('social_post_targets', [{
    id: 'c0000000-0000-4000-8000-000000000001', post_id: POSTS.failed, family_id: FAMILY, account_id: null, platform: 'x', status: 'failed',
    provider_object_id: null, permalink_url: null, error: 'Rate limited by the provider', scheduled_for: null, published_at: null,
    created_by: USERS.parent, updated_by: null, metadata: {}, ...stamps,
  }]);
  db.seed('social_calendar_items', [{
    id: 'd0000000-0000-4000-8000-000000000001', family_id: FAMILY, post_id: POSTS.scheduled, campaign_id: null, title: 'Bake sale reminder',
    platform: 'x', scheduled_for: '2026-11-01T12:00:00.000Z', status: 'scheduled', created_by: USERS.parent, updated_by: null, metadata: {}, ...stamps,
  }]);
  db.seed('social_ai_generations', [
    { id: 'g-1', family_id: FAMILY, user_id: USERS.parent, kind: 'caption', prompt: 'A parent’s private topic', model: 'm', status: 'completed', ...stamps },
    { id: 'g-2', family_id: FAMILY, user_id: USERS.teen, kind: 'hashtags', prompt: 'A teen’s topic', model: 'm', status: 'completed', ...stamps },
  ]);
  db.seed('social_media_library', [{ id: 'e-1', family_id: FAMILY, user_id: USERS.parent, kind: 'image', title: 'Fair poster', url: null, alt_text: null, tags: [], status: 'prompt_only', deleted_at: null, ...stamps }]);
  // Every select the page makes on the AI generations, to see what it asks for.
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    if (table !== 'social_ai_generations') return query;
    const select = query.select.bind(query);
    query.select = ((columns?: string, options?: never) => { h.aiGenerationSelects.push(columns ?? '*'); return select(columns, options); }) as typeof query.select;
    return query;
  }) as typeof db.from;
  h.db = db;
  h.ctx = {
    user: { id: USERS[who], email: null }, memberships: [],
    active: { familyId: FAMILY, role: ROLE[who], member: { id: `m-${Object.keys(USERS).indexOf(who)}` }, family: { id: FAMILY, timezone: 'UTC' } },
  };
  return db;
}

const html = async (tree: ReactNode) => renderServerPage(tree);
const page = async (name: keyof typeof pages) => textOf(await html(await (pages[name] as () => Promise<ReactNode>)()));
const detail = async (id: string) => textOf(await html(await PostDetailPage({ params: Promise.resolve({ id }) })));
const TO_FEED = 'REDIRECT /dashboard/social/feed';

beforeEach(() => {
  h.featureChecks = [];
  h.aiGenerationSelects = [];
  h.superAdmin = false;
  h.locale = 'en-US';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a read_only member reads the feed, not the pipeline (N1, N8)', () => {
  const beyondTheFeed = ['posts', 'contentStudio', 'composer', 'scheduled', 'failed', 'published', 'calendar', 'analytics', 'media', 'connect'] as const;

  it.each(beyondTheFeed)('a child is sent from %s to the feed, having read nothing', async (name) => {
    household('child');
    await expect(page(name)).rejects.toThrow(TO_FEED);
  });

  it('a child is sent from a post\'s detail (its targets and provider errors) to the feed', async () => {
    household('child');
    await expect(detail(POSTS.failed)).rejects.toThrow(TO_FEED);
  });

  it.each(beyondTheFeed)('the same page, %s, opens for a parent', async (name) => {
    household('parent');
    await expect(page(name)).resolves.toEqual(expect.any(String));
  });

  it('a parent reads every post in the pipeline', async () => {
    household('parent');
    const posts = await page('posts');
    for (const title of ['Spring fair draft', 'Bake sale reminder', 'Car wash recap', 'Thank you neighbours']) expect(posts).toContain(title);
    expect(await detail(POSTS.failed)).toContain('Rate limited by the provider');
  });
});

describe('each other social role reads what its permissions open (N1, N8)', () => {
  it('a teen (content creator) reads the drafts, and only their own AI generations, without the prompt', async () => {
    household('teen');
    const studio = await page('contentStudio');
    expect(studio).toContain('Spring fair draft');
    expect(studio).toContain('Hashtags');
    expect(studio, 'a parent’s generation is not the teen’s to list').not.toContain('Caption');
    expect(h.aiGenerationSelects.length).toBeGreaterThan(0);
    expect(h.aiGenerationSelects.join(' '), 'what a member asked the model is not read for the list').not.toMatch(/prompt|\*/);
  });

  it('a teen does not open analytics, which content_creator does not hold', async () => {
    household('teen');
    await expect(page('analytics')).rejects.toThrow(TO_FEED);
  });

  it('an analyst reads what was published and analytics, and nothing still in the pipeline', async () => {
    household('analyst');
    const published = await page('published');
    expect(published).toContain('Thank you neighbours');
    expect(published).not.toContain('Spring fair draft');
    await expect(page('analytics')).resolves.toEqual(expect.any(String));
    for (const name of ['posts', 'contentStudio', 'scheduled', 'failed', 'calendar'] as const) {
      await expect(page(name), name).rejects.toThrow(TO_FEED);
    }
  });

  it('Retry is offered only to whoever may publish', async () => {
    household('teen');
    const teen = await detail(POSTS.failed);
    expect(teen).toContain('Car wash recap');
    expect(teen).not.toContain('Retry publish');
    household('parent');
    expect(await detail(POSTS.failed)).toContain('Retry publish');
  });

  it('New post is offered only to whoever may compose', async () => {
    household('analyst');
    await expect(page('posts')).rejects.toThrow(TO_FEED);
    household('teen');
    expect(await page('posts')).toContain('New post');
  });
});

describe('the section nav and the overview show a role only what it may open (N1, N8)', () => {
  const linksIn = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  it('a child\'s nav has the feed, inbox, accounts and settings, and none of the pipeline', async () => {
    household('child');
    const nav = linksIn(await html(await SocialLayout({ children: createElement('main') })));
    expect(nav).toEqual(expect.arrayContaining(['/dashboard/social', '/dashboard/social/feed', '/dashboard/social/inbox', '/dashboard/social/accounts', '/dashboard/social/settings']));
    for (const href of ['/dashboard/social/content-studio', '/dashboard/social/posts', '/dashboard/social/calendar', '/dashboard/social/analytics', '/dashboard/social/media-library']) {
      expect(nav).not.toContain(href);
    }
  });

  it('a parent\'s nav has all ten sections', async () => {
    household('parent');
    expect(linksIn(await html(await SocialLayout({ children: createElement('main') }))).filter((href) => href.startsWith('/dashboard/social'))).toHaveLength(10);
  });

  it('a child\'s overview does not count the drafts, the scheduled or the published posts, or link to what they cannot open', async () => {
    household('child');
    const markup = await html(await OverviewPage());
    const text = textOf(markup);
    for (const tile of ['Drafts', 'Scheduled', 'Published']) expect(text).not.toContain(tile);
    for (const link of ['Create content', 'Connect an account', 'View analytics']) expect(text).not.toContain(link);
    expect(linksIn(markup)).not.toContain('/dashboard/social/accounts/connect');
    expect(text).toContain('Open unified feed');
  });

  it('a parent\'s overview counts them', async () => {
    household('parent');
    const text = textOf(await html(await OverviewPage()));
    for (const tile of ['Drafts', 'Scheduled', 'Published', 'Create content', 'Connect an account', 'View analytics']) expect(text).toContain(tile);
  });

  it('the accounts page offers Connect only to whoever may connect', async () => {
    household('child');
    expect(linksIn(await html(await pages.accounts()))).not.toContain('/dashboard/social/accounts/connect');
    household('parent');
    expect(linksIn(await html(await pages.accounts()))).toContain('/dashboard/social/accounts/connect');
  });
});

describe('Social is the family\'s plan, on every page and every action (N2)', () => {
  const NOT_IN_PLAN = "Social media tools aren't part of your family's plan.";
  const connect = (platform = 'facebook') => { const fd = new FormData(); fd.set('platform', platform); return connectAccountAction(fd); };

  it('the layout refuses a Free family before any page below it renders', async () => {
    household('parent', null);
    await expect(SocialLayout({ children: createElement('main') })).rejects.toThrow('FEATURE_REFUSED /dashboard/social');
    expect(h.featureChecks).toEqual(['/dashboard/social']);
  });

  it('the layout opens for a Family Basic household', async () => {
    household('parent', 'basic');
    await expect(SocialLayout({ children: createElement('main') })).resolves.toBeTruthy();
    expect(h.featureChecks).toEqual(['/dashboard/social']);
  });

  it('a Free family\'s parent cannot connect an account, draft a post or add media by posting the actions', async () => {
    const db = household('parent', null);
    expect(await connect()).toEqual({ ok: false, error: NOT_IN_PLAN });
    const draft = new FormData(); draft.set('intent', 'draft'); draft.set('body', 'Spring fair');
    expect(await createPostAction(draft)).toEqual({ ok: false, error: NOT_IN_PLAN });
    const media = new FormData(); media.set('title', 'Poster'); media.set('kind', 'image');
    await expect(createMediaAction(media)).rejects.toMatchObject({ message: NOT_IN_PLAN, digest: 'ACTION_REFUSED:notAllowed' });
    expect(db.table('social_accounts')).toEqual([]);
    expect(db.table('social_posts')).toHaveLength(4);
    expect(db.table('social_media_library')).toHaveLength(1);
  });

  it('a Family+ household is refused too once Social is switched off', async () => {
    const db = household('parent', 'plus');
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'social-circle': 'off' } }]);
    expect(await connect()).toEqual({ ok: false, error: NOT_IN_PLAN });
    expect(db.table('social_accounts')).toEqual([]);
  });

  it('a plan that could not be read is not a refusal and not a pass', async () => {
    const db = household('parent', 'basic');
    db.replace('families', []);
    expect(await connect()).toEqual({ ok: false, error: 'Bubaly could not confirm your plan right now. Try again in a moment.' });
    expect(db.table('social_accounts')).toEqual([]);
  });

  it('a Family Basic household connects and adds media as before', async () => {
    const db = household('parent', 'basic');
    expect(await connect()).toMatchObject({ ok: true });
    const media = new FormData(); media.set('title', 'Poster'); media.set('kind', 'image');
    await createMediaAction(media);
    expect(db.table('social_accounts')).toHaveLength(1);
    expect(db.table('social_media_library')).toHaveLength(2);
  });
});

const X_ACCOUNT = 'e0000000-0000-4000-8000-000000000001';
const PAGE_BELOW = 'The page below the layout';

/** An X account the family connected while it had Social, and the tokens Bubaly keeps for it. */
function withConnectedX(db: InMemorySupabase): InMemorySupabase {
  db.seed('social_accounts', [{
    id: X_ACCOUNT, family_id: FAMILY, user_id: USERS.parent, platform: 'x', status: 'connected', display_name: 'Rivera fair on X',
    handle: 'riverafair', provider_account_id: '123456789', scopes: [], last_error: null, last_synced_at: null, deleted_at: null,
    created_by: USERS.parent, updated_by: null, metadata: {}, ...stamps,
  }]);
  db.seed('social_account_tokens', [{
    id: X_ACCOUNT, account_id: X_ACCOUNT, family_id: FAMILY, platform: 'x', provider_account_id: '123456789',
    access_token_enc: 'sealed-access-token', refresh_token_enc: 'sealed-refresh-token', expires_at: null,
    created_by: USERS.parent, updated_by: null, metadata: { x_state: 'connected' }, ...stamps,
  }]);
  return db;
}
// Inside the toast provider app/layout.tsx puts around every page: each
// account's Disconnect reports a failure through it.
const layout = async () => html(createElement(ToastProvider, null, await SocialLayout({ children: createElement('main', null, PAGE_BELOW) })));
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const feed = async () => html(await FeedPage({ searchParams: Promise.resolve({}) }));
// Each account's row reports a failed Disconnect through the toast provider.
const accountsPage = async () => html(createElement(ToastProvider, null, await pages.accounts()));

describe('a family that lost Social can still disconnect what it connected (N2-R1)', () => {
  const OFF = { key: 'feature_tiers', value: { 'social-circle': 'off' } };
  const account = (db: InMemorySupabase) => db.table('social_accounts').find((row) => row.id === X_ACCOUNT)!;
  const token = (db: InMemorySupabase) => db.table('social_account_tokens').find((row) => row.id === X_ACCOUNT)!;
  const linksIn = hrefs;

  it('a Free family\'s parent disconnects their X account, and Bubaly no longer holds its tokens', async () => {
    const db = withConnectedX(household('parent', null));
    expect(await disconnectAccountAction(X_ACCOUNT)).toEqual({ ok: true });
    expect(account(db)).toMatchObject({ status: 'disconnected', deleted_at: expect.any(String) });
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null, metadata: expect.objectContaining({ x_state: 'blocked' }) });
  });

  it('so does a Family+ household once Social is switched off', async () => {
    const db = withConnectedX(household('parent', 'plus'));
    db.seed('app_settings', [OFF]);
    expect(await disconnectAccountAction(X_ACCOUNT)).toEqual({ ok: true });
    expect(account(db).status).toBe('disconnected');
    expect(token(db)).toMatchObject({ access_token_enc: null, refresh_token_enc: null });
  });

  it('the social role still decides who disconnects: a Free family\'s child cannot', async () => {
    const db = withConnectedX(household('child', null));
    await expect(disconnectAccountAction(X_ACCOUNT)).rejects.toThrow('Missing social permission: connect_accounts');
    expect(account(db)).toMatchObject({ status: 'connected', deleted_at: null });
    expect(token(db)).toMatchObject({ access_token_enc: 'sealed-access-token', refresh_token_enc: 'sealed-refresh-token' });
  });

  it('the layout shows a Free family\'s parent the accounts still connected, with Disconnect and the plans, and nothing else of Social', async () => {
    withConnectedX(household('parent', null));
    const markup = await layout();
    const text = textOf(markup);
    expect(text).toContain('Rivera fair on X');
    expect(text).toContain('Disconnect');
    expect(text).toContain('Social media tools aren’t available to your family right now');
    expect(text, 'no page below the layout renders').not.toContain(PAGE_BELOW);
    const links = linksIn(markup);
    expect(links.filter((href) => href.startsWith('/dashboard/social')), 'no section of the console is offered').toEqual([]);
    expect(links).toContain('/dashboard/billing?upgrade=1&need=1');
  });

  it('switched off, the layout shows the same, without an offer to upgrade', async () => {
    const db = withConnectedX(household('parent', 'plus'));
    db.seed('app_settings', [OFF]);
    const markup = await layout();
    expect(textOf(markup)).toContain('Rivera fair on X');
    expect(textOf(markup)).not.toContain(PAGE_BELOW);
    expect(linksIn(markup).filter((href) => href.startsWith('/dashboard/billing'))).toEqual([]);
  });

  it('a Free family\'s child, who cannot disconnect, is still refused before anything renders', async () => {
    withConnectedX(household('child', null));
    await expect(layout()).rejects.toThrow('FEATURE_REFUSED /dashboard/social');
  });

  it('a Family Basic household with an account connected gets the console as before', async () => {
    withConnectedX(household('parent', 'basic'));
    const markup = await layout();
    expect(textOf(markup)).toContain(PAGE_BELOW);
    expect(linksIn(markup)).toContain('/dashboard/social/posts');
    expect(h.featureChecks).toEqual(['/dashboard/social']);
  });
});

describe('a page below the layout ships nothing for a family without Social (N2-R1-payload)', () => {
  // A page renders beside its layout, not inside it: the layout showing the
  // accounts left connected in place of `children` kept these pages off the
  // screen, and their data still went out in the response.
  const SECRET = {
    feed: 'A neighbour’s post in the family feed',
    comment: 'A comment on the bake sale post',
    message: 'A direct message to the family',
    tone: 'A tone the family set for its posts',
  };
  function withFeedAndInbox(db: InMemorySupabase): InMemorySupabase {
    db.seed('social_feed_items', [{
      id: 'fi-1', family_id: FAMILY, platform: 'x', body: SECRET.feed, author_name: 'Neighbour', author_handle: null, media_type: null,
      posted_at: '2026-10-01T00:00:00.000Z', permalink_url: null, metadata: {}, metrics: {}, deleted_at: null, ...stamps,
    }]);
    db.seed('social_comments', [{
      id: 'sc-1', family_id: FAMILY, platform: 'x', kind: 'comment', body: SECRET.comment, status: 'open', author_name: 'Neighbour',
      author_handle: null, posted_at: '2026-10-01T00:00:00.000Z', permalink_url: null, deleted_at: null, ...stamps,
    }]);
    db.seed('social_messages', [{
      id: 'sm-1', family_id: FAMILY, platform: 'x', body: SECRET.message, author_name: 'Neighbour', author_handle: null,
      posted_at: '2026-10-01T00:00:00.000Z', deleted_at: null, ...stamps,
    }]);
    db.seed('social_settings', [{
      id: 'ss-1', family_id: FAMILY, default_timezone: 'Europe/Lisbon', ai_tone: SECRET.tone, signature: null,
      default_platforms: [], require_approval: false, auto_hashtags: true, ...stamps,
    }]);
    return db;
  }
  const readers = {
    feed,
    inbox: async () => html(await pages.inbox()),
    settings: async () => html(await pages.settings()),
    accounts: accountsPage,
  };

  it.each(Object.keys(readers) as (keyof typeof readers)[])('%s refuses a Free family\'s parent who still has X connected, reading nothing', async (name) => {
    withFeedAndInbox(withConnectedX(household('parent', null)));
    await expect(readers[name]()).rejects.toThrow('FEATURE_REFUSED /dashboard/social');
    expect(h.featureChecks).toEqual(['/dashboard/social']);
  });

  it('the layout still shows that parent the accounts left connected (control)', async () => {
    withFeedAndInbox(withConnectedX(household('parent', null)));
    expect(textOf(await layout())).toContain('Rivera fair on X');
  });

  it('a Family Basic household reads its feed, inbox, settings and accounts as before (control)', async () => {
    withFeedAndInbox(withConnectedX(household('parent', 'basic')));
    expect(textOf(await readers.feed())).toContain(SECRET.feed);
    const inbox = textOf(await readers.inbox());
    expect(inbox).toContain(SECRET.comment);
    expect(inbox).toContain(SECRET.message);
    expect(await readers.settings()).toContain(SECRET.tone);
    expect(textOf(await readers.accounts())).toContain('Rivera fair on X');
  });
});

describe('no link or control leads where the viewer would be sent back (N1-R1)', () => {
  const CONNECT = '/dashboard/social/accounts/connect';

  it('the empty feed offers Connect only to whoever may connect', async () => {
    household('child');
    const child = await feed();
    expect(textOf(child)).toContain('No connected accounts');
    expect(hrefs(child)).not.toContain(CONNECT);
    household('parent');
    expect(hrefs(await feed())).toContain(CONNECT);
  });

  it('an analyst reads what was published without the pipeline\'s tabs or a link into a post', async () => {
    household('analyst');
    const markup = await html(await pages.published());
    expect(textOf(markup)).toContain('Thank you neighbours');
    const pipeline = hrefs(markup).filter((href) => href.startsWith('/dashboard/social/posts')
      || href === '/dashboard/social/scheduled' || href === '/dashboard/social/failed');
    expect(pipeline).toEqual([]);
  });

  it('a parent, who holds the pipeline, keeps the tabs and each post\'s link (control)', async () => {
    household('parent');
    const links = hrefs(await html(await pages.published()));
    expect(links).toContain(`/dashboard/social/posts/${POSTS.published}`);
    expect(links).toEqual(expect.arrayContaining(['/dashboard/social/posts', '/dashboard/social/scheduled', '/dashboard/social/failed']));
  });

  it('the accounts page offers Disconnect only to whoever may disconnect', async () => {
    withConnectedX(household('child'));
    const child = textOf(await accountsPage());
    expect(child).toContain('Rivera fair on X');
    expect(child).not.toContain('Disconnect');
    withConnectedX(household('parent'));
    expect(textOf(await accountsPage())).toContain('Disconnect');
  });
});

describe('a super administrator is decided the way the pages decide one (N2-R2)', () => {
  const draft = () => { const fd = new FormData(); fd.set('intent', 'draft'); fd.set('body', 'An administrator’s preview'); return createPostAction(fd); };

  it('one on the database\'s allowlist (not the email list) drafts in a Free family, as they open its pages', async () => {
    const db = household('parent', null);
    h.superAdmin = true;
    expect(await draft()).toMatchObject({ ok: true, action: 'draft' });
    expect(db.table('social_posts')).toHaveLength(5);
  });

  it('and is given the console there, not the accounts left connected', async () => {
    withConnectedX(household('parent', null));
    h.superAdmin = true;
    const text = textOf(await layout());
    expect(text).toContain(PAGE_BELOW);
    expect(text).not.toContain('Social media tools aren’t available to your family right now');
  });

  it('anyone not on it is still refused (control)', async () => {
    const db = household('parent', null);
    expect(await draft()).toEqual({ ok: false, error: "Social media tools aren't part of your family's plan." });
    expect(db.table('social_posts')).toHaveLength(4);
  });
});

describe('a German family reads its plan in the catalogue\'s formal register (I18N-R1)', () => {
  const INFORMAL = /\b(du|dich|dir|dein\w*|versuche)\b/i;
  const connect = () => { const fd = new FormData(); fd.set('platform', 'facebook'); return connectAccountAction(fd); };

  it('a Free family\'s parent is refused in the Sie-form, and told so when the plan could not be read', async () => {
    h.locale = 'de-DE';
    const db = household('parent', null);
    const refused = await connect();
    expect(refused).toEqual({ ok: false, error: 'Die Social-Media-Tools sind nicht Teil des Tarifs Ihrer Familie.' });
    db.replace('families', []);
    const unread = await connect();
    expect(unread).toEqual({ ok: false, error: 'Bubaly konnte Ihren Tarif gerade nicht bestätigen. Versuchen Sie es gleich noch einmal.' });
    for (const result of [refused, unread]) expect(result.error).not.toMatch(INFORMAL);
  });

  it('the accounts left connected are introduced the same way', async () => {
    h.locale = 'de-DE';
    withConnectedX(household('parent', null));
    const text = textOf(await layout());
    expect(text).toContain('Die Social-Media-Tools sind für Ihre Familie gerade nicht verfügbar');
    expect(text).toContain('Sie können sie unabhängig von Ihrem Tarif trennen');
    expect(text).not.toMatch(INFORMAL);
  });
});
