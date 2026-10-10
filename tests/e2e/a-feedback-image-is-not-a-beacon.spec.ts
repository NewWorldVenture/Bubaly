import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { closeWithoutSnapshot, createOwnedAccount, requireLocalOrigin, type OwnedAccount } from './helpers/durable-session';
import { cleanUpFeedbackFixture } from './helpers/feedback-fixture-cleanup';

// SEC-007: a feedback screenshot must not make the super admin's browser fetch
// an arbitrary URL — and the screenshots the board takes must still reach the
// super admin.
//
// The rule (Q61) checked the attachment at submit (normalizeIdea) and again
// where the console renders it, both for this project's own
// /object/public/feedback-attachments/ URL. Then the bucket went private
// (0450, F-E05): the uploader records a bare `<user>/<object>` path, and the
// console page signs every stored value into an /object/sign/ URL. Neither
// check was moved, so on main a member's idea with a screenshot is refused at
// submit ("Attach the screenshot with the upload button…"), and the console
// renders no screenshot at all, however it was stored.
//
// Real pages and real Storage on the disposable local stack; disposable
// accounts (the console's is a super admin through a super_admins row,
// removed with it); synthetic one-pixel PNGs. Every request to a host other
// than this machine is aborted and recorded.
//
// The submit runs onFeedbackSubmitted on the server, which files a GitHub
// issue and emails the super admins when their keys are set. Browser routing
// cannot see those requests. Both launch paths start the server with those
// keys blanked (scripts/e2e-server-env.mjs). This suite refuses to start when
// they, or the other providers' keys, are in its own environment, and refuses
// a server neither path started (PLAYWRIGHT_EXTERNAL_SERVER=1 without the
// runner's marker): a blank Playwright process says nothing about a server
// started by hand.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

test.use({ locale: 'en-US', trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BUCKET = 'feedback-attachments';

let account: OwnedAccount | null = null;
let external: string[] = [];
let requested: string[] = [];
const run = crypto.randomUUID().slice(0, 8);

const admin = () => createClient(requireLocalOrigin(provider), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

/** Records the text of every notice (alert or status) the page shows from now on, so a short-lived one is not missed. */
async function recordNotices(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __notices: string[] }).__notices = seen;
    new MutationObserver(() => {
      for (const n of Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))) {
        const text = (n.textContent ?? '').trim();
        if (text && !seen.includes(text)) seen.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __notices: string[] }).__notices);
}

async function signIn(page: Page, to: string) {
  await page.goto(`/login?redirect=${encodeURIComponent(to)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(account!.email);
  await page.locator('input[name="password"]').fill(account!.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === to, { timeout: 60_000 });
}

test.describe('SEC-007: feedback screenshots reach the super admin, and nothing else does', () => {
  test.skip(!enabled, 'Set E2E_AUTHENTICATED=1 to run against the disposable local Supabase.');
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ context }) => {
    // Before any account, row or request.
    if (process.env.PLAYWRIGHT_EXTERNAL_SERVER === '1' && process.env.E2E_SERVER_PROVIDER_KEYS_BLANKED !== '1') {
      throw new Error('Feedback E2E refuses a server it did not start: its environment cannot be verified. Run it through scripts/run-e2e.mjs.');
    }
    if (process.env.GITHUB_TOKEN || process.env.GITHUB_FEEDBACK_TOKEN || process.env.RESEND_API_KEY
      || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.SENDGRID_API_KEY || process.env.TWILIO_ACCOUNT_SID) {
      throw new Error('Feedback E2E refuses external provider credentials.');
    }
    external = [];
    requested = [];
    await context.route('**/*', (route) => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    context.on('request', (r) => requested.push(r.url()));
    account = await createOwnedAccount(requireLocalOrigin(provider), serviceKey);
  });

  test.afterEach(async ({ context }) => {
    // Pages close before the context, and before Playwright's failure
    // snapshot, so a failure cannot attach the sign-in form's values to it
    // (the established pattern; CI's artifact upload also excludes this suite).
    // Every step runs whatever the one before it did, and each failure is
    // reported (tests/a-feedback-fixture-cleanup-runs-every-step.test.ts).
    const owned = account;
    account = null;
    await cleanUpFeedbackFixture({ close: () => closeWithoutSnapshot(context), db: admin, bucket: BUCKET, run, account: owned });
  });

  test('a member posts an idea with a screenshot through the real form; it is stored as the uploaded path', async ({ page }) => {
    await signIn(page, '/feedback');
    const title = `Screenshot idea ${run}`;
    await page.getByLabel('Title', { exact: true }).fill(title);
    const file = page.locator('input[type="file"][accept*="image/png"]');
    const stored = async () => ((await admin().storage.from(BUCKET).list(account!.userId)).data ?? []).map((o) => o.name);
    // A first screenshot, removed again: the uploader removes its own object.
    await file.setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: PNG });
    // The upload is done when its preview, signed from the private bucket, shows.
    await expect(page.getByRole('img', { name: 'Idea attachment' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(stored).toHaveLength(1);
    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('img', { name: 'Idea attachment' })).toHaveCount(0);
    await expect.poll(stored, { message: 'the removed upload is gone' }).toEqual([]);
    // The screenshot that is posted.
    await file.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('img', { name: 'Idea attachment' })).toBeVisible({ timeout: 30_000 });
    const notices = await recordNotices(page);
    await page.getByRole('button', { name: 'Submit idea' }).click();

    const ACCEPTED = 'Thanks! Your idea is on the board. 💡';
    const REFUSED = 'Attach the screenshot with the upload button rather than a link.';
    await expect.poll(async () => (await notices()).filter((n) => n === ACCEPTED || n === REFUSED), { timeout: 30_000 }).not.toEqual([]);
    expect(await notices(), 'the answer to the submit').toContain(ACCEPTED);
    expect(await notices(), 'refused at submit').not.toContain(REFUSED);
    const { data, error } = await admin().from('feedback_ideas').select('image_url, author_id').eq('title', title);
    expect(error).toBeNull();
    expect(data).toEqual([{ image_url: `${account!.userId}/${(await stored())[0]}`, author_id: account!.userId }]);
    expect(external, 'requests that left this machine').toEqual([]);
  });

  test('the super admin sees each real screenshot, signed; a planted URL is never requested', async ({ page }) => {
    const db = admin();
    const grant = await db.from('super_admins').insert({ email: account!.email.toLowerCase() });
    if (grant.error) throw new Error(`Could not make the fixture a super admin (${grant.error.code ?? grant.error.message}).`);
    const origin = new URL(requireLocalOrigin(provider)).origin;
    // Two real attachments: one stored as 0450's bare path, one as the public
    // URL rows written before 0450 still hold.
    const paths = [`${account!.userId}/${crypto.randomUUID()}-bare.png`, `${account!.userId}/${crypto.randomUUID()}-legacy.png`];
    for (const path of paths) {
      const { error } = await db.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png', upsert: false });
      if (error) throw new Error(`Could not store a synthetic attachment (${error.message}).`);
    }
    const planted = {
      tracker: `https://tracker.example/pixel-${run}.gif`,
      otherBucket: `${origin}/storage/v1/object/public/family-media/${crypto.randomUUID()}/beacon-${run}.png`,
      traversal: `${origin}/storage/v1/object/public/${BUCKET}/../family-media/beacon-${run}.png`,
      script: `javascript:alert(document.domain)//${run}`,
    };
    const rows = [
      { title: `Bare path ${run}`, image_url: paths[0] },
      { title: `Legacy URL ${run}`, image_url: `${origin}/storage/v1/object/public/${BUCKET}/${paths[1]}` },
      ...Object.entries(planted).map(([kind, image_url]) => ({ title: `Planted ${kind} ${run}`, image_url })),
    ].map((r) => ({ ...r, author_name: 'Probe' }));
    const { error } = await db.from('feedback_ideas').insert(rows);
    if (error) throw new Error(`Could not seed feedback ideas (${error.code ?? error.message}).`);

    await signIn(page, '/admin/feedback');
    for (const r of rows) await expect(page.getByText(r.title, { exact: true })).toBeVisible();

    // Each real screenshot is on the page as a signed URL for its own object,
    // and the browser loaded it.
    for (const path of paths) {
      const img = page.locator(`img[src*="/storage/v1/object/sign/${BUCKET}/${path}?token="]`);
      await expect(img, `${path} is shown`).toHaveCount(1);
      await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).naturalWidth), { message: `${path} loaded` }).toBe(1);
    }
    await page.waitForLoadState('networkidle');
    // No planted value is an image, or among the requests the page made.
    const srcs = await page.evaluate(() => Array.from(document.images).map((i) => i.getAttribute('src') ?? ''));
    expect(srcs.filter((s) => s.includes(run)), 'a planted value rendered as an image').toEqual([]);
    expect(requested.filter((u) => u.includes(run)), 'a planted value was requested').toEqual([]);
    expect(external, 'requests that left this machine').toEqual([]);

    // Calibration: the measurement does see a beacon when there is one. An
    // image the page itself sets is requested (off this machine: aborted and
    // recorded).
    await page.evaluate((src) => { new Image().src = src; }, `https://tracker.example/control-${run}.gif`);
    await expect.poll(() => external.filter((u) => u.includes(`control-${run}`)).length).toBe(1);
  });
});
