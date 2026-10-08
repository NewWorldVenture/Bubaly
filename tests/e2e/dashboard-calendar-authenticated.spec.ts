import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import type { Database, Insertable } from '../../lib/database.types';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '../../lib/calendar/source-capability';
import {
  authCookieName, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin, type OwnedAccount,
} from './helpers/durable-session';

type Client = SupabaseClient<Database>;
type Zone = 'America/New_York' | 'Asia/Tokyo';

function localClient(origin: string, key: string): Client {
  requireLocalOrigin(origin);
  if (!key) throw new Error('Dashboard E2E requires disposable local credentials.');
  return createClient<Database>(origin, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
    }) },
  });
}

function dayKey(date: Date, zone: Zone): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Only unambiguous fixture times are used. No process/browser clock changes.
function wallTime(key: string, hour: number, minute: number, zone: Zone): string {
  const [year, month, day] = key.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const number = (type: string) => Number(parts.find(value => value.type === type)!.value);
    const local = Date.UTC(number('year'), number('month') - 1, number('day'), number('hour'), number('minute'));
    if (local === target) return new Date(instant).toISOString();
    instant += target - local;
  }
  throw new Error('Dashboard fixture could not resolve an unambiguous family time.');
}

function panel(page: Page, heading: string): Locator {
  return page.getByRole('heading', { name: heading, exact: true }).locator('../..');
}

function stat(page: Page, label: string): Locator {
  return page.locator('a[href="/dashboard/calendar"]').filter({ has: page.getByText(label, { exact: true }) });
}

async function openContext(browser: Browser,
  app: string, provider: string): Promise<BrowserContext> {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return [app, provider].includes(url.origin) ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', route => {
      const url = new URL(route.url());
      url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
      if ([app, provider].includes(url.origin)) route.connectToServer();
      else void route.close();
    });
    return context;
  } catch {
    await closeWithoutSnapshot(context);
    throw new Error('Dashboard E2E could not initialize its local browser.');
  }
}

async function login(context: BrowserContext, app: string, provider: string, account: OwnedAccount): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${app}/login?redirect=${encodeURIComponent('/dashboard?view=personal')}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  } catch { throw new Error('Dashboard E2E could not submit its owned sign-in form.'); }
  await expect(page).toHaveURL(`${app}/dashboard?view=personal`, { timeout: 60_000 });
  expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId,
    'Browser authenticates as the owned fixture').toBe(true);
  await expect(page.getByRole('heading', { name: 'My Day', exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}

// Real Auth -> middleware/route -> genuine async dashboards -> PostgREST/RLS.
// Service credentials are used only for owned setup, inspection and cleanup.
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });
test.describe('authenticated native dashboard calendar', () => {
  test.skip(process.env.E2E_DURABLE_SESSION !== '1', 'Requires the disposable local Supabase stack.');
  test.setTimeout(240_000);

  for (const zone of ['America/New_York', 'Asia/Tokyo'] as const) {
    test(`${zone}: real family and personal DATE, recurrence, scope and complete counts`, async ({ browser, baseURL }, info) => {
      test.skip(info.project.name !== 'chromium', 'Run the independent desktop fixture once.');
      // Before credentials, fixture writes or HTTP; ignore remote-E2E overrides.
      const app = requireLocalOrigin(baseURL);
      const provider = requireLocalOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
      if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.RESEND_API_KEY
        || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
        throw new Error('Dashboard E2E refuses external provider credentials.');
      }
      expect(CALENDAR_SOURCE_ARCHIVE_ENABLED, 'Imported-source capability remains held').toBe(false);
      const admin = localClient(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
      const accounts: OwnedAccount[] = [];
      const contexts: BrowserContext[] = [];
      const members: Client[] = [];
      try {
        for (let index = 0; index < 3; index++) accounts.push(await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''));
        const [owner, reader, outsider] = accounts;
        const household = await admin.from('families').update({ timezone: zone }).eq('id', owner.familyId).eq('created_by', owner.userId);
        expect(!household.error, 'Owned household uses the tested family clock').toBe(true);
        const membership = await admin.from('family_members').upsert({
          family_id: owner.familyId, user_id: reader.userId, role: 'caregiver', is_active: true, display_name: 'Dashboard Reader',
        }, { onConflict: 'family_id,user_id' }).select('id').single();
        const ownerMember = await admin.from('family_members').select('id').eq('family_id', owner.familyId).eq('user_id', owner.userId).single();
        expect(!membership.error && !!membership.data && !ownerMember.error && !!ownerMember.data,
          'Distinct active parent and caregiver memberships exist').toBe(true);
        const ownId = membership.data!.id;
        const otherId = ownerMember.data!.id;
        for (const account of [owner, reader]) {
          const preferences = await admin.from('user_preferences').upsert({
            user_id: account.userId, active_family_id: owner.familyId, default_dashboard: 'family',
            notification_prefs: { onboardingComplete: true },
          }, { onConflict: 'user_id' });
          expect(!preferences.error, 'Owned preference selects this household').toBe(true);
        }
        const client = localClient(provider, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
        members.push(client);
        const auth = await client.auth.signInWithPassword({ email: reader.email, password: reader.password });
        expect(!auth.error && auth.data.user?.id === reader.userId, 'Inspection uses real caregiver Auth').toBe(true);
        const today = dayKey(new Date(), zone);
        const tomorrow = addDays(today, 1);
        const last = addDays(today, 14);
        const token = `Dashboard-${randomUUID()}`;
        const titles = {
          date: `${token}-Shared-Today`, own: `${token}-Own-Today`, other: `${token}-Other-Today`,
          recurring: `${token}-Daily-Nine`, future: `${token}-Tomorrow-DATE`, timed: `${token}-Tomorrow-Timed`,
          lastDate: `${token}-Day14-DATE`, lastTimed: `${token}-Day14-Timed`,
          outside: `${token}-Day15`, foreign: `${token}-Foreign`,
        };
        const date = (title: string, key: string): Insertable<'calendar_events'> => ({
          id: randomUUID(), family_id: owner.familyId, title, created_by: owner.userId,
          starts_at: `${key}T00:00:00Z`, ends_at: `${addDays(key, 1)}T00:00:00Z`, all_day: true,
          recurrence: 'none', assignee_id: null,
        });
        const timed = (title: string, key: string, hour: number, minute: number, assignee: string | null): Insertable<'calendar_events'> => ({
          id: randomUUID(), family_id: owner.familyId, title, created_by: owner.userId,
          starts_at: wallTime(key, hour, minute, zone), ends_at: wallTime(key, hour, minute + 1, zone),
          all_day: false, recurrence: 'none', assignee_id: assignee,
        });
        const previousYear = Number(today.slice(0, 4)) - 1;
        const candidates = [`${previousYear}-01-15`, `${previousYear}-07-15`];
        const currentUtcHour = new Date(wallTime(today, 9, 0, zone)).getUTCHours();
        const seed = zone === 'America/New_York'
          ? candidates.find(key => new Date(wallTime(key, 9, 0, zone)).getUTCHours() !== currentUtcHour)
          : candidates[0];
        expect(!!seed, 'New York master starts before today at the opposite DST offset').toBe(true);
        const rows: Insertable<'calendar_events'>[] = [
          date(titles.date, today), timed(titles.own, today, 0, 5, ownId), timed(titles.other, today, 0, 6, otherId),
          { ...timed(titles.recurring, seed!, 9, 0, null), recurrence: 'daily', recurrence_until: wallTime(last, 23, 0, zone) },
          date(titles.future, tomorrow), timed(titles.timed, tomorrow, 1, 0, ownId),
          date(titles.lastDate, last), timed(titles.lastTimed, last, 0, 0, ownId),
          date(titles.outside, addDays(today, 15)),
          { ...date(titles.foreign, today), family_id: outsider.familyId, created_by: outsider.userId },
        ];
        const inserted = await admin.from('calendar_events').insert(rows);
        expect(!inserted.error, 'Only owned native calendar rows are seeded').toBe(true);
        const ownRows = await client.from('calendar_events').select('id, starts_at, all_day')
          .eq('family_id', owner.familyId);
        const persistedDate = ownRows.data?.find(row => row.id === rows[0].id);
        const persistedMaster = ownRows.data?.find(row => row.id === rows[3].id);
        expect(!ownRows.error && ownRows.data?.length === 9 && persistedDate?.all_day === true
          && Date.parse(persistedDate.starts_at) === Date.parse(`${today}T00:00:00Z`)
          && !!persistedMaster && Date.parse(persistedMaster.starts_at) === Date.parse(rows[3].starts_at),
        'Authenticated reads confirm genuine canonical DATE and historical recurring storage').toBe(true);
        const foreign = await client.from('calendar_events').select('id').eq('family_id', outsider.familyId);
        expect(!foreign.error && foreign.data?.length === 0, 'Real RLS excludes the unrelated household').toBe(true);

        const context = await openContext(browser, app, provider);
        contexts.push(context);
        const page = await login(context, app, provider, reader);
        const assertDayStable = () => expect(dayKey(new Date(), zone), 'Family day did not roll over during this real-clock scenario').toBe(today);
        assertDayStable();
        const myDay = panel(page, 'My Day');
        const coming = panel(page, 'Coming Up');
        await expect(stat(page, 'My Events Today').locator('p.text-2xl')).toHaveText('3');
        await expect(myDay.locator('li')).toHaveCount(3);
        await expect(myDay.getByText(titles.date, { exact: true })).toBeVisible();
        await expect(myDay.getByText(titles.own, { exact: true })).toBeVisible();
        const recurringToday = myDay.locator('li').filter({ hasText: titles.recurring });
        await expect(recurringToday).toContainText('9:00 AM');
        await expect(myDay.getByText(titles.other, { exact: true })).toHaveCount(0);
        await expect(coming.locator('li')).toHaveCount(5);
        const futureDate = coming.locator('li').filter({ hasText: titles.future });
        await expect(futureDate).toContainText('All Day');
        await expect(futureDate.locator('p.text-base')).toHaveText(String(Number(tomorrow.slice(-2))));
        await expect(coming.locator('li').filter({ hasText: titles.timed })).toContainText('1:00 AM');
        await expect(coming.locator('li').filter({ hasText: titles.recurring })).toHaveCount(3);
        // Upcoming begins tomorrow and includes day14 midnight: thirteen 09:00
        // recurrences (days1..13) plus four singles, independently counted.
        await expect(stat(page, 'Coming Up').locator('p.text-2xl')).toHaveText('17');
        await expect(page.getByText(titles.foreign, { exact: true })).toHaveCount(0);
        await expect(page.getByText(titles.outside, { exact: true })).toHaveCount(0);

        await page.goto(`${app}/dashboard?view=family`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: "Today's Schedule", exact: true })).toBeVisible();
        await expect(stat(page, 'Events Today').locator('p.text-2xl')).toHaveText('4');
        await expect(panel(page, "Today's Schedule").getByText(titles.other, { exact: true })).toBeVisible();
        await expect(panel(page, 'Upcoming Events').locator('li')).toHaveCount(5);
        await expect(panel(page, 'Upcoming Events').locator('li').filter({ hasText: titles.future }).locator('p.text-base'))
          .toHaveText(String(Number(tomorrow.slice(-2))));

        // Force a genuine provider-sized domain without changing its cap. The
        // 1,001 singles alone exceed the usual 1,000 row PostgREST response.
        const bulk = Array.from({ length: 1001 }, (_, index) => timed(`${token}-Bulk-${index}`, today, 13, 0, ownId));
        for (let offset = 0; offset < bulk.length; offset += 250) {
          const write = await admin.from('calendar_events').insert(bulk.slice(offset, offset + 250));
          expect(!write.error, 'Owned bulk setup succeeds').toBe(true);
        }
        const prefix = await client.from('calendar_events').select('id', { count: 'exact' })
          .eq('family_id', owner.familyId).like('title', `${token}-Bulk-%`).order('id');
        expect(!prefix.error && prefix.count === 1001 && prefix.data?.length === 1000,
          'Real provider truncates its 1,001-row domain to a 1,000-row prefix with exact count').toBe(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        assertDayStable();
        await expect(stat(page, 'Events Today').locator('p.text-2xl')).toHaveText('1005');
        await expect(panel(page, "Today's Schedule").locator('li')).toHaveCount(8);
        await expect(panel(page, 'Upcoming Events').locator('li')).toHaveCount(5);
        await page.goto(`${app}/dashboard?view=personal`, { waitUntil: 'domcontentloaded' });
        await expect(stat(page, 'My Events Today').locator('p.text-2xl')).toHaveText('1004');
        await expect(stat(page, 'Coming Up').locator('p.text-2xl')).toHaveText('17');
        await expect(panel(page, 'My Day').locator('li')).toHaveCount(8);
        await expect(panel(page, 'Coming Up').locator('li')).toHaveCount(5);
        await expect(panel(page, 'My Day').getByText(titles.other, { exact: true })).toHaveCount(0);
        await expect(page.getByText(titles.foreign, { exact: true })).toHaveCount(0);

        const parentContext = await openContext(browser, app, provider);
        contexts.push(parentContext);
        const parentPage = await login(parentContext, app, provider, owner);
        await expect(parentPage.getByRole('heading', { name: 'Needs Your Approval', exact: true })).toBeVisible();
        await expect(parentPage.getByRole('heading', { name: 'Coming Up', exact: true })).toHaveCount(0);
        await parentPage.goto(`${app}/dashboard?view=family`, { waitUntil: 'domcontentloaded' });
        await expect(stat(parentPage, 'Events Today').locator('p.text-2xl')).toHaveText('1005');
        // Remove only owned setup rows obscuring the horizon behind the cap.
        // The remaining day14 DATE and exact-midnight timed event must render;
        // day15 must remain absent. No process clock or calendar cap changes.
        const removeIds = rows.filter(row => [titles.recurring, titles.future, titles.timed].includes(row.title)).map(row => row.id!);
        const removed = await admin.from('calendar_events').delete().eq('family_id', owner.familyId)
          .eq('created_by', owner.userId).in('id', removeIds);
        expect(!removed.error, 'Only owned earlier presentation fixtures are removed').toBe(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(stat(page, 'Coming Up').locator('p.text-2xl')).toHaveText('2');
        const horizon = panel(page, 'Coming Up');
        await expect(horizon.locator('li')).toHaveCount(2);
        await expect(horizon.getByText(titles.lastDate, { exact: true })).toBeVisible();
        await expect(horizon.getByText(titles.lastTimed, { exact: true })).toBeVisible();
        await expect(horizon.locator('li').filter({ hasText: titles.lastDate }).locator('p.text-base'))
          .toHaveText(String(Number(last.slice(-2))));
        await expect(page.getByText(titles.outside, { exact: true })).toHaveCount(0);
        await parentPage.reload({ waitUntil: 'domcontentloaded' });
        await expect(panel(parentPage, 'Upcoming Events').locator('li')).toHaveCount(2);
        await expect(parentPage.getByText(titles.lastDate, { exact: true })).toBeVisible();
        await expect(parentPage.getByText(titles.lastTimed, { exact: true })).toBeVisible();
        await expect(parentPage.getByText(titles.outside, { exact: true })).toHaveCount(0);
        assertDayStable();
      } finally {
        // Never allow a failing cleanup to skip the remaining owned resources.
        const closed = await Promise.allSettled(contexts.map(context => closeWithoutSnapshot(context)));
        const signedOut = await Promise.allSettled(members.map(client => client.auth.signOut()));
        const disposed = await Promise.allSettled([...accounts].reverse().map(account => account.dispose()));
        if ([...closed, ...signedOut, ...disposed].some(result => result.status === 'rejected')
          || signedOut.some(result => result.status === 'fulfilled' && result.value.error)) {
          throw new Error('Dashboard E2E could not completely clean up its owned fixture.');
        }
      }
    });
  }
});
