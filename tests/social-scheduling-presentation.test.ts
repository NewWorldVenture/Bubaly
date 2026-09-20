import { createElement, isValidElement, type ReactElement, type ReactNode, type ComponentProps, type AnchorHTMLAttributes } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Json, Tables } from '@/lib/database.types';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { StudioForm } from '@/components/social/studio-form';

// Actual async pages, schedule-time helpers, RetryPublishButton, presentation
// primitives and React SSR. Auth/query results are explicit request boundaries;
// the New page's Studio client boundary is inspected separately (its actual
// browser behavior is covered in social-scheduling-ui.spec.ts).
const boundary = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, auth: vi.fn(), post: vi.fn(), calendar: vi.fn(), accounts: vi.fn(), feed: vi.fn(), inbox: vi.fn(), resolve: vi.fn(),
  settings: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), retry: vi.fn(),
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(boundary.locale), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault(boundary.locale), source: 'default' }),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: boundary.auth }));
vi.mock('@/lib/social/queries', () => ({ getPost: boundary.post, getCalendarItems: boundary.calendar, getAccounts: boundary.accounts, getFeed: boundary.feed, getInbox: boundary.inbox }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({ from: boundary.from }) }));
vi.mock('@/app/(app)/dashboard/social/actions', () => ({ retryPublishAction: boundary.retry, resolveCommentAction: boundary.resolve }));
vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('FIXTURE_NOT_FOUND'); } }));
vi.mock('@/components/social/studio-form', () => ({
  StudioForm: (props: ComponentProps<typeof StudioForm>) => createElement('section', {
    'data-studio-zone': props.defaultTimezone ?? 'browser', 'data-account-count': props.accounts.length,
  }),
}));

const { default: DetailPage } = await import('@/app/(app)/dashboard/social/posts/[id]/page');
const { default: CalendarPage } = await import('@/app/(app)/dashboard/social/calendar/page');
const { default: NewPage } = await import('@/app/(app)/dashboard/social/content-studio/new/page');
const { default: FeedPage } = await import('@/app/(app)/dashboard/social/feed/page');
const { default: InboxPage } = await import('@/app/(app)/dashboard/social/inbox/page');
const familyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const postId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const targetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const accountId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const instant = '2027-01-01T01:00:00.000Z';
const stamps = { created_at: '2026-09-12T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z' };
const basePost: Tables<'social_posts'> = {
  id: postId, family_id: familyId, user_id: userId, campaign_id: null, title: 'Scheduled announcement', body: 'A real-shaped fixture post',
  kind: 'text', status: 'scheduled', link: null, scheduled_for: instant, published_at: null, approval_status: 'not_required', approved_by: null,
  approved_at: null, created_by: userId, updated_by: null, deleted_at: null,
  metadata: { schedule_timezone: 'America/New_York', schedule_phase: 'queued' }, ...stamps,
};
const baseTarget: Tables<'social_post_targets'> = {
  id: targetId, post_id: postId, family_id: familyId, account_id: accountId, platform: 'x', status: 'pending', provider_object_id: null,
  permalink_url: null, error: null, scheduled_for: instant, published_at: null, created_by: userId, updated_by: null, metadata: {}, ...stamps,
};
const baseAccount: Tables<'social_accounts'> = {
  id: accountId, family_id: familyId, user_id: userId, platform: 'x', account_type: null, provider_account_id: 'fixture-provider',
  handle: 'fixture', display_name: 'Fixture X', avatar_url: null, profile_url: null, status: 'connected', health: 'healthy', scopes: [],
  last_synced_at: null, last_error: null, created_by: userId, updated_by: null, deleted_at: null, metadata: {}, ...stamps,
};
const calendarItem = (id: string, timezone: string | null, changes: Partial<Tables<'social_calendar_items'>> = {}): Tables<'social_calendar_items'> => ({
  id, family_id: familyId, post_id: postId, campaign_id: null, title: `Announcement ${id}`, platform: 'x', scheduled_for: instant,
  status: 'scheduled', created_by: userId, updated_by: null,
  metadata: timezone ? { schedule_timezone: timezone, schedule_phase: 'queued' } : {}, ...stamps, ...changes,
});
const copy = (key: string) => getRawMessages(boundary.locale)[key];
function html(tree: ReactNode) {
  const props: ComponentProps<typeof LocaleProvider> = { locale: localeOrDefault(boundary.locale), source: 'default', messages: getMessages(boundary.locale), children: tree };
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}
function plain(value: string) { return value.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"'); }
function buttons(markup: string) { return [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match => plain(match[1]).trim()); }
function elements(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...elements(tree.props.children as ReactNode)];
}
function setPost(changes: Partial<Tables<'social_posts'>> = {}, targets: Tables<'social_post_targets'>[] = [{ ...baseTarget }]) {
  boundary.post.mockResolvedValue({ post: { ...basePost, ...changes }, targets, variants: [], results: [] });
}
async function detail() { return html(await DetailPage({ params: Promise.resolve({ id: postId }) })); }

beforeEach(() => {
  vi.clearAllMocks(); boundary.locale = 'en-US';
  boundary.auth.mockReset().mockResolvedValue({ active: { familyId }, user: { id: userId } });
  boundary.feed.mockReset().mockResolvedValue([]); boundary.inbox.mockReset().mockResolvedValue({ comments: [], messages: [] });
  boundary.post.mockReset(); setPost(); boundary.calendar.mockReset().mockResolvedValue([]); boundary.accounts.mockReset().mockResolvedValue([{ ...baseAccount }]);
  boundary.settings.mockReset().mockResolvedValue({ data: { default_timezone: 'America/New_York' }, error: null });
  boundary.from.mockImplementation((table: string) => { if (table !== 'social_settings') throw new Error(`Unexpected settings table ${table}`); return { select: boundary.select }; });
  boundary.select.mockReturnValue({ eq: boundary.eq }); boundary.eq.mockReturnValue({ maybeSingle: boundary.settings });
});

describe('social calendar rendered schedule presentation', () => {
  it('groups one absolute instant into each saved zone day, including New York previous year', async () => {
    boundary.calendar.mockResolvedValue([calendarItem('new-york', 'America/New_York'), calendarItem('utc', 'UTC'), calendarItem('paris', 'Europe/Paris')]);
    const markup = html(await CalendarPage()), text = plain(markup);
    expect(text).toContain('2026-12-31 · America/New_York'); expect(text).toContain('2027-01-01 · UTC'); expect(text).toContain('2027-01-01 · Europe/Paris');
    expect(text).toContain('Dec 31, 2026, 8:00 PM (America/New_York)'); expect(text).toContain('Jan 1, 2027, 1:00 AM (UTC)'); expect(text).toContain('Jan 1, 2027, 2:00 AM (Europe/Paris)');
    const groups = [...markup.matchAll(/<h3\b[^>]*>(.*?)<\/h3>([\s\S]*?)(?=<h3\b|$)/g)].map(match => ({ heading: plain(match[1]), body: plain(match[2]) }));
    expect(groups.find(group => group.heading.includes('America/New_York'))?.body).toContain('Announcement new-york');
    expect(groups.find(group => group.heading.includes('America/New_York'))?.body).not.toContain('Announcement utc');
    expect(boundary.calendar).toHaveBeenCalledWith(familyId); expect(markup).toContain(`href="/dashboard/social/posts/${postId}"`);
  });

  it('renders a legacy row in explicit UTC with unverified authorization copy', async () => {
    boundary.calendar.mockResolvedValue([calendarItem('legacy', null)]);
    const text = plain(html(await CalendarPage()));
    expect(text).toContain('2027-01-01 · UTC'); expect(text).toContain('Jan 1, 2027, 1:00 AM (UTC)');
    expect(text).toContain(copy('socialSchedule.legacyUnverified')); expect(text).not.toContain(copy('socialSchedule.queued'));
  });

  it.each([
    ['approval_required', 'socialSchedule.approvalRequired'], ['unknown', 'socialSchedule.awaitingConfirmation'],
    ['dispatching', 'socialSchedule.awaitingConfirmation'], ['failed', 'socialSchedule.changed'], ['unarmed', 'socialSchedule.saveUnconfirmed'],
  ])('projects %s as public localized copy without raw metadata', async (phase, key) => {
    boundary.calendar.mockResolvedValue([calendarItem('held', 'America/New_York', { metadata: { schedule_timezone: 'America/New_York', schedule_phase: phase,
      schedule_error: 'PRIVATE_FIXTURE_PROVIDER_TEXT', private_manifest: 'PRIVATE_FIXTURE_MANIFEST' } })]);
    const text = plain(html(await CalendarPage())); expect(text).toContain(copy(key));
    expect(text).not.toContain('PRIVATE_FIXTURE'); expect(text).not.toContain(copy('socialSchedule.queued'));
  });

  it('uses allowlisted failure copy and does not display an arbitrary translation key', async () => {
    boundary.calendar.mockResolvedValue([calendarItem('failed', 'UTC', { metadata: { schedule_timezone: 'UTC', schedule_phase: 'failed', schedule_error: 'socialSchedule.reconnectRequired' } })]);
    expect(plain(html(await CalendarPage()))).toContain(copy('socialSchedule.reconnectRequired'));
    boundary.calendar.mockResolvedValue([calendarItem('failed', 'UTC', { metadata: { schedule_timezone: 'UTC', schedule_phase: 'failed', schedule_error: 'admin.secretKey' } })]);
    const text = plain(html(await CalendarPage())); expect(text).toContain(copy('socialSchedule.changed')); expect(text).not.toContain('admin.secretKey');
  });

  it('keeps completed rows free of obsolete queued or unverified warnings', async () => {
    boundary.calendar.mockResolvedValue([calendarItem('completed', 'UTC', { status: 'published', metadata: { schedule_timezone: 'UTC', schedule_phase: 'completed', schedule_error: null } })]);
    const text = plain(html(await CalendarPage())); expect(text).toContain('published');
    expect(text).not.toContain(copy('socialSchedule.queued')); expect(text).not.toContain(copy('socialSchedule.legacyUnverified')); expect(text).not.toContain(copy('socialSchedule.awaitingConfirmation'));
  });

  it('uses French date formatting and approval copy together', async () => {
    boundary.locale = 'fr-FR'; boundary.calendar.mockResolvedValue([calendarItem('fr', 'America/New_York', { metadata: { schedule_timezone: 'America/New_York', schedule_phase: 'approval_required' } })]);
    const text = plain(html(await CalendarPage())); expect(text).toContain('31 déc. 2026, 20:00 (America/New_York)'); expect(text).toContain(copy('socialSchedule.approvalRequired'));
    expect(text).not.toContain('Dec 31');
  });

  it('distinguishes legitimate empty results from a required query failure', async () => {
    expect(plain(html(await CalendarPage()))).toContain(copy('dashboardSocialCalendar.nothingScheduled'));
    boundary.calendar.mockRejectedValue(new Error('Fixture required calendar read unavailable'));
    await expect(CalendarPage()).rejects.toThrow('Fixture required calendar read unavailable');
  });
});

describe('social detail rendered schedule presentation', () => {
  it('shows the saved zone instant and Publish now for a queued scheduled post', async () => {
    const markup = await detail(); expect(plain(markup)).toContain('Dec 31, 2026, 8:00 PM (America/New_York)');
    expect(plain(markup)).toContain(copy('socialSchedule.queued')); expect(buttons(markup)).toContain(copy('studio.publishNow'));
    expect(buttons(markup)).not.toContain(copy('retryButton.retryPublish')); expect(boundary.post).toHaveBeenCalledWith(familyId, postId); expect(boundary.retry).not.toHaveBeenCalled();
  });

  it('keeps ordinary failed-post Retry publish distinct from scheduling', async () => {
    setPost({ status: 'failed', scheduled_for: null, metadata: {} }, [{ ...baseTarget, status: 'failed' }]);
    const markup = await detail(); expect(buttons(markup)).toContain(copy('retryButton.retryPublish')); expect(buttons(markup)).not.toContain(copy('studio.publishNow'));
    expect(plain(markup)).not.toContain(copy('socialSchedule.legacyUnverified'));
  });

  it('labels a legacy scheduled post with explicit UTC and an authorization review warning', async () => {
    setPost({ metadata: {} }); const text = plain(await detail());
    expect(text).toContain('Jan 1, 2027, 1:00 AM (UTC)'); expect(text).toContain(copy('socialSchedule.legacyUnverified'));
  });

  it.each([
    ['approval_required', 'socialSchedule.approvalRequired'], ['unknown', 'socialSchedule.awaitingConfirmation'], ['failed', 'socialSchedule.changed'],
  ])('renders %s safely with the actual page and localized helper', async (phase, key) => {
    setPost({ metadata: { schedule_timezone: 'America/New_York', schedule_phase: phase, schedule_error: '<script>PRIVATE_FIXTURE</script>' } });
    const markup = await detail(); expect(plain(markup)).toContain(copy(key)); expect(markup).not.toContain('PRIVATE_FIXTURE');
  });

  it('does not offer retry when a target remains publishing, even with a failed sibling', async () => {
    setPost({ status: 'partially_published' }, [{ ...baseTarget, status: 'publishing' }, { ...baseTarget, id: 'other-target', status: 'failed' }]);
    const markup = await detail(); expect(buttons(markup)).not.toContain(copy('retryButton.retryPublish')); expect(buttons(markup)).not.toContain(copy('studio.publishNow'));
    expect(plain(markup)).toContain(copy('socialPost.awaitingConfirmation'));
  });

  it('renders completed schedule date without an obsolete phase warning or retry', async () => {
    setPost({ status: 'published', metadata: { schedule_timezone: 'UTC', schedule_phase: 'completed', schedule_error: null } }, [{ ...baseTarget, status: 'published' }]);
    const markup = await detail(); expect(plain(markup)).toContain('Jan 1, 2027, 1:00 AM (UTC)'); expect(buttons(markup)).toEqual([]);
    expect(plain(markup)).not.toContain(copy('socialSchedule.legacyUnverified')); expect(plain(markup)).not.toContain(copy('socialSchedule.queued'));
  });

  it('uses real French locale for date, approval warning, and immediate action label', async () => {
    boundary.locale = 'fr-FR'; const markup = await detail();
    expect(plain(markup)).toContain('31 déc. 2026, 20:00 (America/New_York)'); expect(buttons(markup)).toContain(copy('studio.publishNow'));
    setPost({ metadata: { schedule_timezone: 'America/New_York', schedule_phase: 'approval_required' } }); expect(plain(await detail())).toContain(copy('socialSchedule.approvalRequired'));
  });

  it('keeps missing and unavailable posts distinct and invokes no publishing action during render', async () => {
    boundary.post.mockResolvedValue({ post: null, targets: [], variants: [], results: [] }); await expect(detail()).rejects.toThrow('FIXTURE_NOT_FOUND');
    boundary.post.mockRejectedValue(new Error('Fixture required post read unavailable')); await expect(detail()).rejects.toThrow('Fixture required post read unavailable');
    expect(boundary.retry).not.toHaveBeenCalled();
  });
});

describe('NewContentPage verified server inputs', () => {
  it('passes the stored timezone and authenticated family:user React key to the Studio boundary', async () => {
    const tree = await NewPage(), studio = elements(tree).find(element => element.type === StudioForm)!;
    expect(studio).toBeDefined(); expect(studio.key).toBe(`${familyId}:${userId}`); expect(studio.props.defaultTimezone).toBe('America/New_York');
    expect(studio.props.accounts).toEqual([{ id: accountId, platform: 'x', display_name: 'Fixture X', handle: 'fixture', status: 'connected' }]);
    expect(html(tree)).toContain('data-studio-zone="America/New_York"'); expect(boundary.eq).toHaveBeenCalledWith('family_id', familyId);
    expect(boundary.select).toHaveBeenCalledWith('default_timezone'); expect(boundary.accounts).toHaveBeenCalledWith(familyId);
  });

  it('passes optional absence to the browser-zone policy without treating it as a query failure', async () => {
    boundary.settings.mockResolvedValue({ data: null, error: null }); const tree = await NewPage();
    expect(elements(tree).find(element => element.type === StudioForm)?.props.defaultTimezone).toBeUndefined(); expect(html(tree)).toContain('data-studio-zone="browser"');
  });

  it.each([
    [{ default_timezone: 'America/New_York' }, { message: 'Fixture settings read denied' }],
    [{ default_timezone: 'Invalid/Zone' }, null],
  ] as Array<[Json, unknown]>)('rejects failed or invalid settings before rendering Studio', async (data, error) => {
    boundary.settings.mockResolvedValue({ data, error }); await expect(NewPage()).rejects.toThrow(copy('socialSchedule.accessUnavailable'));
  });

  it('preserves authentication failure before any settings/account query', async () => {
    boundary.auth.mockRejectedValue(new Error('FIXTURE_AUTH_REQUIRED')); await expect(NewPage()).rejects.toThrow('FIXTURE_AUTH_REQUIRED');
    expect(boundary.from).not.toHaveBeenCalled(); expect(boundary.accounts).not.toHaveBeenCalled();
  });
});


it.each(['unknown', 'dispatching'])('does not advertise immediate publishing for %s schedule projection with stale ordinary statuses', async (phase) => {
  setPost({ status: 'scheduled', metadata: { schedule_timezone: 'America/New_York', schedule_phase: phase, schedule_error: 'socialSchedule.awaitingConfirmation' } }, [{ ...baseTarget, status: 'pending' }]);
  const markup = await detail(); expect(plain(markup)).toContain(copy('socialSchedule.awaitingConfirmation'));
  expect(buttons(markup)).not.toContain(copy('studio.publishNow')); expect(buttons(markup)).not.toContain(copy('retryButton.retryPublish'));
  setPost({ status: 'scheduled', metadata: { schedule_timezone: 'America/New_York', schedule_phase: phase, schedule_error: 'socialSchedule.reconnectRequired' } });
  const inconsistent = await detail(); expect(plain(inconsistent)).toContain(copy('socialSchedule.awaitingConfirmation'));
  expect(plain(inconsistent)).not.toContain(copy('socialSchedule.reconnectRequired')); expect(buttons(inconsistent)).not.toContain(copy('studio.publishNow'));
  expect(boundary.retry).not.toHaveBeenCalled();
});


const visibleBody = 'Visible <script>fixture text only</script> & announcement';
function feedItem(url: string | null, profile?: string): Tables<'social_feed_items'> {
  return { id: 'feed-fixture', family_id: familyId, account_id: accountId, platform: 'x', provider_object_id: null,
    author_name: 'Fixture author', author_handle: null, author_avatar_url: null, permalink_url: url, body: visibleBody,
    media_type: 'text', media: {}, metrics: {}, posted_at: null, fetched_at: stamps.created_at, status: 'synced', created_by: userId,
    updated_by: null, deleted_at: null, metadata: profile ? { profile_url: profile } : {}, ...stamps };
}
function comment(url: string | null): Tables<'social_comments'> {
  return { id: 'comment-fixture', family_id: familyId, account_id: accountId, platform: 'x', provider_object_id: null,
    feed_item_id: null, parent_provider_id: null, kind: 'comment', author_name: 'Fixture author', author_handle: null,
    body: visibleBody, permalink_url: url, status: 'resolved', assigned_to: null, posted_at: null, created_by: userId,
    updated_by: null, deleted_at: null, metadata: {}, ...stamps };
}
function hrefs(markup: string) { return [...markup.matchAll(/\bhref="([^"]*)"/g)].map(match => plain(match[1])); }
async function feed() { return html(await FeedPage({ searchParams: Promise.resolve({}) })); }

describe('SEC-004 stored social links in actual page rendering', () => {
  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>fixture</script>'],
    ['credentials', 'https://fixture-user:fixture-password@example.test/post'],
    ['whitespace', 'https://example.test/\npost'],
    ['overlong', `https://example.test/${'x'.repeat(4096)}`],
  ])('removes unsafe %s links from legacy detail/feed/inbox rows without dropping escaped content', async (_name, unsafe) => {
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setPost({ link: unsafe, body: visibleBody }, [{ ...baseTarget, permalink_url: unsafe }]);
      boundary.feed.mockResolvedValue([feedItem(unsafe, unsafe)]); boundary.inbox.mockResolvedValue({ comments: [comment(unsafe)], messages: [] });
      const pages = [await detail(), await feed(), html(await InboxPage())];
      for (const markup of pages) {
        expect(hrefs(markup).filter(value => !value.startsWith('/dashboard/social'))).toEqual([]);
        expect(markup).toContain('Visible &lt;script&gt;fixture text only&lt;/script&gt; &amp; announcement');
        expect(markup).not.toMatch(/<script\b/); expect(markup).not.toMatch(/href="(?:javascript|data):/i);
      }
      expect(warnings).not.toHaveBeenCalled(); expect(boundary.retry).not.toHaveBeenCalled(); expect(boundary.resolve).not.toHaveBeenCalled();
    } finally { warnings.mockRestore(); }
  });

  it.each(['https://example.test/post?x=1&y=2#entry', 'http://example.test/post'])('retains safe external link %s on all actual pages', async (url) => {
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setPost({ link: url }, [{ ...baseTarget, permalink_url: url }]); boundary.feed.mockResolvedValue([feedItem(url)]); boundary.inbox.mockResolvedValue({ comments: [comment(url)], messages: [] });
      const pages = [await detail(), await feed(), html(await InboxPage())];
      expect(hrefs(pages[0]).filter(value => value === url)).toHaveLength(2);
      expect(hrefs(pages[1])).toContain(url); expect(hrefs(pages[2])).toContain(url);
      for (const markup of pages) expect(markup).toContain('target="_blank" rel="noreferrer"');
      expect(warnings).not.toHaveBeenCalled();
    } finally { warnings.mockRestore(); }
  });

  it('uses a safe profile fallback when a stored feed permalink is unsafe', async () => {
    boundary.feed.mockResolvedValue([feedItem('javascript:alert(1)', 'https://example.test/profile')]);
    const markup = await feed(); expect(hrefs(markup)).toContain('https://example.test/profile');
    expect(markup).not.toContain('href="javascript:'); expect(markup).toContain('Visible &lt;script&gt;fixture text only&lt;/script&gt;');
  });

  it('does not replace a safe feed permalink with an unsafe profile URL', async () => {
    boundary.feed.mockResolvedValue([feedItem('https://example.test/post', 'javascript:alert(1)')]);
    expect(hrefs(await feed())).toContain('https://example.test/post');
  });
});
